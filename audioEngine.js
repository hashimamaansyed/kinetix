/**
 * @file renderer/audioEngine.js
 * @description KINETIX Dual-Mode Audio Engine — Electron Edition
 *
 * Supports DUAL MODES routed through the unified Web Audio DSP Chain:
 *   1. System Audio Loopback Mode (Windows WASAPI loopback via desktopCapturer)
 *   2. Local Library Audio Playback (IndexedDB / File blobs via HTMLAudioElement)
 *
 * Unified DSP Chain:
 *   [System Stream Source OR HTMLAudioElement Source]
 *       └─► 5-Band Graphic Equalizer (BiquadFilterNodes: 60Hz, 230Hz, 910Hz, 3.6kHz, 14kHz)
 *           └─► Dry/Wet Spatial Convolver (Acoustic Depth & Reverb)
 *               └─► StereoPannerNode (8D LFO Sine Sweep Rotation)
 *                   └─► MasterGainNode (0 - 150%)
 *                       ├─► AnalyserNode (Live Spectrum Visualizer)
 *                       └─► AudioContext.destination (Speakers / Headphones)
 */

(function (root, factory) {
  const lib = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = lib;
  } else {
    root.audioEngine = lib;
    root.KinetixAudioEngine = lib;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  // ─── 5-Band Equalizer Frequency Configuration ──────────────────────────────
  const EQ_BANDS = [
    { freq: 60,    type: 'lowshelf',  label: '60Hz' },
    { freq: 230,   type: 'peaking',   label: '230Hz' },
    { freq: 910,   type: 'peaking',   label: '910Hz' },
    { freq: 3600,  type: 'peaking',   label: '3.6kHz' },
    { freq: 14000, type: 'highshelf', label: '14kHz' }
  ];

  const EQ_PRESETS = {
    flat:        [  0,    0,    0,    0,    0 ],
    bassBoost:   [ +9,   +5,    0,   -1,   -1 ],
    travelVocal: [ -3,   -1,   +7,   +5,   +2 ],
    acoustic:    [ +4,   +3,   -1,   +3,   +5 ],
    loudness:    [ +6,   +3,    0,   +3,   +6 ]
  };

  class DualModeAudioEngine {
    constructor() {
      this.ctx = null;
      this._sourceNode = null;         // MediaStream source (system capture)
      this._elementSourceNode = null;  // MediaElement source (local playback)
      this._audioEl = null;            // HTMLAudioElement for local tracks
      this._currentBlobUrl = null;
      this._currentTrack = null;

      this._eqFilters = [];
      this._pannerNode = null;
      this._masterGain = null;
      this._analyserNode = null;
      this._lfoOsc = null;
      this._lfoGain = null;
      this._convolver = null;
      this._dryGain = null;
      this._wetGain = null;
      this._stream = null;

      this._isInitialized = false;
      this._isBypassed = false;
      this._is8DEnabled = false;
      this._8dCycleTime = 8.0;
      this._eqGains = [...EQ_PRESETS.flat];
      this._powerSaverEnabled = false;
      this._volume = 1.0;

      // Event Callbacks
      this.onSourceConnected = null;
      this.onSourceError = null;
      this.onBypassChange = null;
      this.onPlayStateChange = null;
      this.onTimeUpdate = null;
      this.onEnded = null;
      this.onError = null;
    }

    // ─── Initialize Audio Context & Graph ────────────────────────────────────
    async init() {
      if (this._isInitialized) return;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error('Web Audio API not supported');

      this.ctx = new AudioCtx({ latencyHint: 'interactive', sampleRate: 48000 });

      // Create audio element for local files & background streaming
      this._audioEl = new Audio();
      this._audioEl.crossOrigin = 'anonymous';
      this._audioEl.preload = 'auto';

      this._audioEl.addEventListener('play', () => {
        if (this.onPlayStateChange) this.onPlayStateChange(true);
        this._updateMediaSessionState('playing');
      });

      this._audioEl.addEventListener('pause', () => {
        if (this.onPlayStateChange) this.onPlayStateChange(false);
        this._updateMediaSessionState('paused');
      });

      this._audioEl.addEventListener('ended', () => {
        if (this.onEnded) this.onEnded();
        this._updateMediaSessionState('none');
      });

      this._audioEl.addEventListener('timeupdate', () => {
        if (this.onTimeUpdate) {
          this.onTimeUpdate(this.currentTime, this.duration);
        }
      });

      this._audioEl.addEventListener('error', (err) => {
        console.warn('[AudioEngine] HTMLAudioElement error:', err);
        if (this.onError) this.onError(err);
      });

      this._buildGraph();

      // Power saver handling
      document.addEventListener('visibilitychange', () => {
        if (!this._powerSaverEnabled || this.isCapturing || this.isPlaying) return;
        if (document.hidden) {
          this.ctx.suspend && this.ctx.suspend();
        } else {
          this.ctx.resume && this.ctx.resume();
        }
      });

      this._isInitialized = true;
    }

    _buildGraph() {
      const ctx = this.ctx;

      // 1. Equalizer Filter Bank (5 Biquad Filters)
      this._eqFilters = EQ_BANDS.map((band, i) => {
        const filter = ctx.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = band.freq;
        filter.Q.value = 1.0;
        filter.gain.value = this._eqGains[i] || 0;
        return filter;
      });

      // Chain EQ filters: 0 -> 1 -> 2 -> 3 -> 4
      for (let i = 0; i < this._eqFilters.length - 1; i++) {
        this._eqFilters[i].connect(this._eqFilters[i + 1]);
      }
      const eqOutput = this._eqFilters[this._eqFilters.length - 1];

      // 2. Local File AudioElement Source -> EQ Filter 0
      try {
        this._elementSourceNode = ctx.createMediaElementSource(this._audioEl);
        this._elementSourceNode.connect(this._eqFilters[0]);
      } catch (e) {
        console.warn('[AudioEngine] createMediaElementSource warning:', e);
      }

      // 3. Convolver (Spatial Reverb Tail)
      this._convolver = ctx.createConvolver();
      this._convolver.normalize = true;
      this._generateReverbImpulse();

      // 4. Dry / Wet Mixer
      this._dryGain = ctx.createGain();
      this._wetGain = ctx.createGain();
      this._dryGain.gain.value = 1.0;
      this._wetGain.gain.value = 0.0;

      eqOutput.connect(this._dryGain);
      eqOutput.connect(this._convolver);
      this._convolver.connect(this._wetGain);

      // 5. 8D Spatial StereoPanner
      this._pannerNode = ctx.createStereoPanner();
      this._pannerNode.pan.value = 0;

      this._dryGain.connect(this._pannerNode);
      this._wetGain.connect(this._pannerNode);

      // 6. LFO Sine Sweep Oscillator -> Panner.pan
      this._lfoOsc = ctx.createOscillator();
      this._lfoOsc.type = 'sine';
      this._lfoOsc.frequency.value = 1 / this._8dCycleTime;

      this._lfoGain = ctx.createGain();
      this._lfoGain.gain.value = 0; // inactive until 8D toggled

      this._lfoOsc.connect(this._lfoGain);
      this._lfoGain.connect(this._pannerNode.pan);
      this._lfoOsc.start();

      // 7. Master Gain Node
      this._masterGain = ctx.createGain();
      this._masterGain.gain.value = this._volume;

      this._pannerNode.connect(this._masterGain);

      // 8. Analyser Node for Live Spectrum Visualizer
      this._analyserNode = ctx.createAnalyser();
      this._analyserNode.fftSize = 512;
      this._analyserNode.smoothingTimeConstant = 0.8;

      this._masterGain.connect(this._analyserNode);
      this._masterGain.connect(ctx.destination);
    }

    _generateReverbImpulse() {
      if (!this.ctx || !this._convolver) return;
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * 1.5);
      const buf = this.ctx.createBuffer(2, len, sr);
      for (let c = 0; c < 2; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < len; i++) {
          ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
        }
      }
      this._convolver.buffer = buf;
    }

    // ─── Mode 1: System Audio WASAPI Loopback Capture ────────────────────────
    async captureSystemAudio() {
      if (!this._isInitialized) await this.init();

      // If local playback is running, pause it to prevent overlapping
      if (this.isPlaying) {
        this.pause();
      }

      this.stopCapture();

      const isElectron = !!(window.kinetixElectron);

      try {
        let stream;

        if (isElectron) {
          const sources = await window.kinetixElectron.getDesktopSources();
          const screenSource = sources.find(s =>
            s.name === 'Entire Screen' || s.name === 'Screen 1' || s.name.startsWith('Screen')
          ) || sources[0];

          if (!screenSource) throw new Error('No capturable screen audio source found');

          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: screenSource.id
              }
            },
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: screenSource.id,
                maxFrameRate: 1,
                maxWidth: 32,
                maxHeight: 32
              }
            }
          });

          // Discard video track
          stream.getVideoTracks().forEach(t => t.stop());
        } else {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        }

        this._stream = stream;

        if (this.ctx.state === 'suspended') await this.ctx.resume();

        this._sourceNode = this.ctx.createMediaStreamSource(stream);
        this._sourceNode.connect(this._eqFilters[0]);

        if (this.onSourceConnected) {
          this.onSourceConnected({
            isElectron,
            trackLabel: stream.getAudioTracks()[0]?.label || 'System Audio'
          });
        }

        return true;
      } catch (err) {
        console.error('[AudioEngine] captureSystemAudio error:', err);
        if (this.onSourceError) this.onSourceError(err);
        return false;
      }
    }

    stopCapture() {
      if (this._stream) {
        this._stream.getTracks().forEach(t => t.stop());
        this._stream = null;
      }
      if (this._sourceNode) {
        try { this._sourceNode.disconnect(); } catch {}
        this._sourceNode = null;
      }
    }

    // ─── Mode 2: Local Library File / Blob Playback ──────────────────────────
    async loadTrack(fileOrBlob, trackMeta) {
      if (!this._isInitialized) await this.init();

      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }

      // Revoke previous blob URL
      if (this._currentBlobUrl) {
        try { URL.revokeObjectURL(this._currentBlobUrl); } catch {}
      }

      this._currentTrack = trackMeta || {
        title: (fileOrBlob && fileOrBlob.name) ? fileOrBlob.name.replace(/\.[^/.]+$/, '') : 'Unknown Title',
        artist: 'Unknown Artist',
        album: 'Unknown Album'
      };

      const url = URL.createObjectURL(fileOrBlob);
      this._currentBlobUrl = url;
      this._audioEl.src = url;

      await new Promise((resolve) => {
        const onLoaded = () => {
          this._audioEl.removeEventListener('loadedmetadata', onLoaded);
          this._audioEl.removeEventListener('error', onError);
          resolve();
        };
        const onError = () => {
          this._audioEl.removeEventListener('loadedmetadata', onLoaded);
          this._audioEl.removeEventListener('error', onError);
          resolve();
        };
        this._audioEl.addEventListener('loadedmetadata', onLoaded);
        this._audioEl.addEventListener('error', onError);
        this._audioEl.load();
      });

      this.updateMediaSession(this._currentTrack);
    }

    async play() {
      if (!this._audioEl) return;
      if (this.ctx && this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      try {
        await this._audioEl.play();
      } catch (err) {
        console.warn('[AudioEngine] Play prevented:', err);
      }
    }

    pause() {
      if (this._audioEl) {
        this._audioEl.pause();
      }
    }

    togglePlay() {
      if (this.isPlaying) {
        this.pause();
      } else {
        this.play();
      }
    }

    seek(seconds) {
      if (!this._audioEl) return;
      const dur = this.duration;
      const target = Math.max(0, Math.min(seconds, dur > 0 ? dur : seconds));
      this._audioEl.currentTime = target;
      if (this.onTimeUpdate) {
        this.onTimeUpdate(target, dur);
      }
      this._updatePositionState();
    }

    // ─── Equalizer Operations ────────────────────────────────────────────────
    setEQBand(index, gainDb) {
      if (index < 0 || index >= this._eqFilters.length) return;
      this._eqGains[index] = gainDb;
      if (!this._isBypassed && this._eqFilters[index] && this.ctx) {
        this._eqFilters[index].gain.setTargetAtTime(gainDb, this.ctx.currentTime, 0.015);
      }
    }

    applyEQPreset(name) {
      const gains = EQ_PRESETS[name] || EQ_PRESETS.flat;
      gains.forEach((g, i) => this.setEQBand(i, g));
      this._eqGains = [...gains];
      return gains;
    }

    getEQGains() {
      return [...this._eqGains];
    }

    // ─── Bypass ─────────────────────────────────────────────────────────────
    setBypassed(state) {
      this._isBypassed = state;
      const gains = state ? EQ_PRESETS.flat : this._eqGains;
      gains.forEach((g, i) => {
        if (this._eqFilters[i] && this.ctx) {
          this._eqFilters[i].gain.setTargetAtTime(state ? 0 : g, this.ctx.currentTime, 0.02);
        }
      });

      if (this._pannerNode && this.ctx) {
        if (state) {
          this._pannerNode.pan.setTargetAtTime(0, this.ctx.currentTime, 0.02);
          if (this._lfoGain) this._lfoGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
        } else if (this._is8DEnabled) {
          if (this._lfoGain) this._lfoGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.02);
        }
      }

      if (this.onBypassChange) this.onBypassChange(state);

      if (window.kinetixElectron) {
        window.kinetixElectron.reportEQState({ bypassed: state });
      }
    }

    get isBypassed() { return this._isBypassed; }

    // ─── 8D Spatial Operations ──────────────────────────────────────────────
    enable8D() {
      this._is8DEnabled = true;
      if (this.ctx) {
        if (this._lfoGain && !this._isBypassed) {
          this._lfoGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.1);
        }
        if (this._wetGain) {
          this._wetGain.gain.setTargetAtTime(0.25, this.ctx.currentTime, 0.1);
        }
        if (this._dryGain) {
          this._dryGain.gain.setTargetAtTime(0.85, this.ctx.currentTime, 0.1);
        }
      }
    }

    disable8D() {
      this._is8DEnabled = false;
      if (this.ctx) {
        if (this._lfoGain) {
          this._lfoGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
        }
        if (this._pannerNode) {
          this._pannerNode.pan.setTargetAtTime(0, this.ctx.currentTime, 0.3);
        }
        if (this._wetGain) {
          this._wetGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
        }
        if (this._dryGain) {
          this._dryGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.1);
        }
      }
    }

    toggle8D() {
      if (this._is8DEnabled) {
        this.disable8D();
      } else {
        this.enable8D();
      }
      return this._is8DEnabled;
    }

    set8DCycleTime(seconds) {
      const clamped = Math.max(3, Math.min(20, parseFloat(seconds) || 8.0));
      this._8dCycleTime = clamped;
      if (this._lfoOsc && this.ctx) {
        this._lfoOsc.frequency.setTargetAtTime(1 / clamped, this.ctx.currentTime, 0.05);
      }
    }

    get is8DEnabled() { return this._is8DEnabled; }

    // ─── Volume ─────────────────────────────────────────────────────────────
    setVolume(v) {
      const clamped = Math.max(0, Math.min(1.5, v));
      this._volume = clamped;
      if (this._masterGain && this.ctx) {
        this._masterGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.02);
      }
      if (this._audioEl) {
        this._audioEl.volume = Math.min(1.0, clamped);
      }
    }

    get volume() { return this._volume; }

    // ─── Power Saver ────────────────────────────────────────────────────────
    setPowerSaver(enabled) {
      this._powerSaverEnabled = !!enabled;
    }

    // ─── MediaSession API Integration ───────────────────────────────────────
    updateMediaSession(track) {
      if (!('mediaSession' in navigator) || !track) return;
      const artwork = [];
      if (track.coverArtUrl) {
        artwork.push({ src: track.coverArtUrl, sizes: '512x512', type: 'image/jpeg' });
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'Unknown Title',
        artist: track.artist || 'Unknown Artist',
        album: track.album || 'Unknown Album',
        artwork: artwork
      });
    }

    bindMediaSessionHandlers(handlers) {
      if (!('mediaSession' in navigator)) return;
      const actions = [
        ['play', handlers.onPlay],
        ['pause', handlers.onPause],
        ['nexttrack', handlers.onNext],
        ['previoustrack', handlers.onPrev],
        ['seekto', (details) => handlers.onSeek && handlers.onSeek(details.seekTime)]
      ];
      actions.forEach(([action, handler]) => {
        if (handler) {
          try {
            navigator.mediaSession.setActionHandler(action, handler);
          } catch {}
        }
      });
    }

    _updateMediaSessionState(state) {
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = state;
        } catch {}
      }
    }

    _updatePositionState() {
      if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
        try {
          const dur = this.duration;
          if (dur > 0) {
            navigator.mediaSession.setPositionState({
              duration: dur,
              playbackRate: 1.0,
              position: Math.min(this.currentTime, dur)
            });
          }
        } catch {}
      }
    }

    // ─── Property Getters ───────────────────────────────────────────────────
    get isPlaying() {
      return this._audioEl ? !this._audioEl.paused : false;
    }

    get currentTime() {
      return this._audioEl ? this._audioEl.currentTime : 0;
    }

    get duration() {
      return this._audioEl && isFinite(this._audioEl.duration) ? this._audioEl.duration : 0;
    }

    get currentTrack() {
      return this._currentTrack;
    }

    get isCapturing() {
      return !!(this._stream && this._stream.active);
    }

    get analyser() {
      return this._analyserNode;
    }

    get sampleRate() {
      return this.ctx ? this.ctx.sampleRate : 0;
    }

    get latency() {
      return this.ctx ? (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) : 0;
    }
  }

  const engine = new DualModeAudioEngine();
  return engine;
});
