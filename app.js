/**
 * @file renderer/app.js
 * @description KINETIX Electron Renderer — Main Application Controller
 *
 * Full Integration:
 *   - 5 Tabs: Now Playing, Equalizer, 8D Spatial, Library, Settings
 *   - Central Glass Vinyl Disc with smooth spin animation and 8D orbital particle
 *   - Full Transport Controls (Play/Pause, Prev/Next, Shuffle, Repeat)
 *   - Honor Phone Music Player recursive file scanner & IndexedDB blob persistence
 *   - Dual Mode Audio Processing:
 *       Mode A: System Audio WASAPI Loopback Capture
 *       Mode B: Local Audio Library Playback
 *   - Unified DSP routing through 5-Band Equalizer, 8D Panner, and Master Gain
 *   - Live spectrum visualizer canvas
 *   - Live Toast Feedback Banners
 *   - System Tray IPC synchronization
 */

(function () {
  'use strict';

  // ─── 5-Band EQ Configuration ────────────────────────────────────────────────
  const EQ_BANDS = [
    { freq: '60Hz',   label: '60' },
    { freq: '230Hz',  label: '230' },
    { freq: '910Hz',  label: '910' },
    { freq: '3.6kHz', label: '3.6k' },
    { freq: '14kHz',  label: '14k' }
  ];

  const EQ_PRESETS = {
    flat:        [  0,   0,  0,  0,  0 ],
    bassBoost:   [ +9,  +5,  0, -1, -1 ],
    travelVocal: [ -3,  -1, +7, +5, +2 ],
    acoustic:    [ +4,  +3, -1, +3, +5 ],
    loudness:    [ +6,  +3,  0, +3, +6 ]
  };

  // ─── Application State ──────────────────────────────────────────────────────
  const state = {
    audioMode: 'system',         // 'system' (WASAPI loopback) | 'local' (library)
    capturing: false,           // is system capture running?
    tracks: [],                 // all indexed library tracks
    filteredTracks: [],         // search/sort filtered tracks
    currentTrackIndex: -1,
    currentTrack: null,
    isPlayingLocal: false,
    searchQuery: '',
    sortKey: 'addedAt',
    isScanning: false,

    // Playback Modes
    shuffle: false,
    repeat: 'off',              // 'off' | 'all' | 'one'

    // DSP Engine State
    bypassed: false,
    is8D: false,
    eqGains: [...EQ_PRESETS.flat],
    activePreset: 'flat',
    cycleTime: 8.0,
    volume: 1.0,
    isSeeking: false
  };

  // ─── Engine & Visualizer References ─────────────────────────────────────────
  let engine = null;
  let canvasCtx = null;
  let rafId = null;
  let toastTimer = null;

  // ─── Helper Functions ───────────────────────────────────────────────────────
  function formatTime(seconds) {
    if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message, duration = 3200) {
    const toast = document.getElementById('toast');
    const toastText = document.getElementById('toast-text');
    if (!toast || !toastText) return;

    toastText.textContent = message;
    toast.classList.add('visible');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, duration);
  }

  // ─── Initialization on DOM Ready ────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    engine = window.audioEngine;

    buildEQBands();
    bindTitleBarControls();
    bindTabNav();
    bindCaptureButton();
    bindNowPlayingControls();
    bindBypassButton();
    bindPresetButtons();
    bindMasterVolume();
    bindSpatialControls();
    bindLibraryControls();
    bindMiniPlayerControls();
    bindSettingsControls();
    bindTrayEvents();
    initVisualizer();

    // Hook audio engine callbacks
    setupEngineCallbacks();

    // Restore cached library and settings from IndexedDB
    await restoreOfflineState();

    updateDiagnostics();
  });

  // ─── Setup Audio Engine Callbacks ───────────────────────────────────────────
  function setupEngineCallbacks() {
    if (!engine) return;

    engine.onPlayStateChange = (playing) => {
      state.isPlayingLocal = playing;
      updatePlayButtonUI(playing);
      renderLibraryTracks();
      if (playing) {
        startVisualizer();
      }
    };

    engine.onTimeUpdate = (currentTime, duration) => {
      if (state.isSeeking) return;

      // Update Now Playing timeline
      const npCurrEl = document.getElementById('np-current-time');
      const npTotalEl = document.getElementById('np-duration-time');
      const npFillEl = document.getElementById('np-progress-fill');
      const npHandleEl = document.getElementById('np-progress-handle');

      if (npCurrEl) npCurrEl.textContent = formatTime(currentTime);
      if (npTotalEl) npTotalEl.textContent = formatTime(duration);

      const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
      if (npFillEl) npFillEl.style.width = `${pct}%`;
      if (npHandleEl) npHandleEl.style.left = `${pct}%`;

      // Update Mini Player timeline
      const miniCurrEl = document.getElementById('mini-time-curr');
      const miniTotalEl = document.getElementById('mini-time-total');
      const miniFillEl = document.getElementById('mini-timeline-fill');

      if (miniCurrEl) miniCurrEl.textContent = formatTime(currentTime);
      if (miniTotalEl) miniTotalEl.textContent = formatTime(duration);
      if (miniFillEl) miniFillEl.style.width = `${pct}%`;
    };

    engine.onEnded = () => {
      if (state.repeat === 'one') {
        engine.seek(0);
        engine.play();
      } else {
        playNextTrack();
      }
    };

    engine.onError = (err) => {
      console.warn('[KinetixApp] Audio playback error:', err);
      showToast('Playback error: Unable to decode audio file.');
    };
  }

  // ─── Restore Offline IndexedDB State ────────────────────────────────────────
  async function restoreOfflineState() {
    if (!window.kinetixDB) return;

    try {
      await window.kinetixDB.init();
      const savedTracks = await window.kinetixDB.getAllTracks();
      if (savedTracks && savedTracks.length > 0) {
        state.tracks = savedTracks;
        applyFilterAndSort();
        renderLibraryTracks();
        updateLibraryCount();

        // Populate Now Playing with first track
        selectTrackByIndex(0);
      } else {
        renderLibraryTracks();
      }

      // Restore EQ Gains if saved
      const savedGains = await window.kinetixDB.getSetting('eqGains');
      if (Array.isArray(savedGains) && savedGains.length === 5) {
        state.eqGains = savedGains;
        savedGains.forEach((g, i) => {
          const s = document.getElementById(`eq-slider-${i}`);
          const l = document.getElementById(`eq-db-${i}`);
          if (s) s.value = g;
          if (l) l.textContent = `${g >= 0 ? '+' : ''}${g.toFixed(1)} dB`;
          if (engine) engine.setEQBand(i, g);
        });
      }
    } catch (err) {
      console.warn('[KinetixApp] Error restoring offline state:', err);
      renderLibraryTracks();
    }
  }

  // ─── Title Bar Controls ─────────────────────────────────────────────────────
  function bindTitleBarControls() {
    document.getElementById('btn-minimize')?.addEventListener('click', () => {
      if (window.kinetixElectron) window.kinetixElectron.minimizeWindow();
    });
    document.getElementById('btn-close')?.addEventListener('click', () => {
      if (window.kinetixElectron) window.kinetixElectron.closeWindow();
    });
  }

  // ─── Tab Navigation ─────────────────────────────────────────────────────────
  function bindTabNav() {
    const tabs = document.querySelectorAll('.tab-btn');
    const views = document.querySelectorAll('.view');
    const miniPlayer = document.getElementById('mini-player');

    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.view;
        tabs.forEach(b => b.classList.remove('active'));
        views.forEach(v => v.classList.remove('active'));
        btn.classList.add('active');

        const view = document.getElementById(`view-${target}`);
        if (view) view.classList.add('active');

        // Hide mini player on dedicated Player view, show on others if track loaded
        if (miniPlayer) {
          if (target === 'now-playing') {
            miniPlayer.style.display = 'none';
          } else if (state.currentTrack) {
            miniPlayer.style.display = 'flex';
          }
        }
      });
    });
  }

  // ─── Dedicated Now Playing View & Rotating Disc Controls ────────────────────
  function bindNowPlayingControls() {
    const playPauseBtn = document.getElementById('btn-play-pause');
    const prevBtn = document.getElementById('btn-prev');
    const nextBtn = document.getElementById('btn-next');
    const shuffleBtn = document.getElementById('btn-shuffle');
    const repeatBtn = document.getElementById('btn-repeat');
    const timeline = document.getElementById('np-timeline');

    playPauseBtn?.addEventListener('click', () => {
      if (!engine) return;
      if (state.currentTrackIndex === -1 && state.filteredTracks.length > 0) {
        playTrackByIndex(0);
        return;
      }
      engine.togglePlay();
    });

    prevBtn?.addEventListener('click', () => playPrevTrack());
    nextBtn?.addEventListener('click', () => playNextTrack());

    shuffleBtn?.addEventListener('click', () => {
      state.shuffle = !state.shuffle;
      shuffleBtn.classList.toggle('active', state.shuffle);
      showToast(state.shuffle ? '🔀 Shuffle: ON' : 'Shuffle: OFF', 1800);
    });

    repeatBtn?.addEventListener('click', () => {
      if (state.repeat === 'off') {
        state.repeat = 'all';
        repeatBtn.classList.add('active');
        repeatBtn.title = 'Loop Mode: All Tracks';
        showToast('🔁 Loop: All Tracks', 1800);
      } else if (state.repeat === 'all') {
        state.repeat = 'one';
        repeatBtn.classList.add('active');
        repeatBtn.title = 'Loop Mode: Single Track';
        showToast('🔂 Loop: Single Track', 1800);
      } else {
        state.repeat = 'off';
        repeatBtn.classList.remove('active');
        repeatBtn.title = 'Loop Mode: Off';
        showToast('Loop: OFF', 1800);
      }
    });

    // Timeline Seeking on Now Playing Screen
    if (timeline) {
      const handleSeek = (e) => {
        if (!engine || !engine.duration) return;
        const rect = timeline.getBoundingClientRect();
        const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const pct = clickX / rect.width;
        const targetSec = pct * engine.duration;

        const npFill = document.getElementById('np-progress-fill');
        const npHandle = document.getElementById('np-progress-handle');
        const npCurrTime = document.getElementById('np-current-time');

        if (npFill) npFill.style.width = `${pct * 100}%`;
        if (npHandle) npHandle.style.left = `${pct * 100}%`;
        if (npCurrTime) npCurrTime.textContent = formatTime(targetSec);

        engine.seek(targetSec);
      };

      timeline.addEventListener('mousedown', (e) => {
        state.isSeeking = true;
        handleSeek(e);

        const onMouseMove = (moveEvent) => {
          if (state.isSeeking) handleSeek(moveEvent);
        };

        const onMouseUp = () => {
          state.isSeeking = false;
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    }
  }

  function updateNowPlayingUI(track) {
    if (!track) return;

    // Track metadata text
    const titleEl = document.getElementById('np-title');
    const artistEl = document.getElementById('np-artist');
    const albumEl = document.getElementById('np-album');
    const durationEl = document.getElementById('np-duration-time');

    if (titleEl) titleEl.textContent = track.title || track.fileName || 'Unknown Title';
    if (artistEl) artistEl.textContent = track.artist || 'Unknown Artist';
    if (albumEl) albumEl.textContent = track.album || '—';
    if (durationEl) durationEl.textContent = formatTime(track.duration);

    // Disc Center Artwork
    const artImg = document.getElementById('np-album-art');
    const placeholder = document.getElementById('np-art-placeholder');

    if (track.coverArtUrl && artImg && placeholder) {
      artImg.src = track.coverArtUrl;
      artImg.style.display = 'block';
      placeholder.style.display = 'none';
    } else if (artImg && placeholder) {
      artImg.style.display = 'none';
      placeholder.style.display = 'flex';
    }

    // Sync Mini Player UI
    updateMiniPlayerUI(track);
  }

  function updatePlayButtonUI(isPlaying) {
    // 1. Spinning Vinyl Disc
    const glassDisc = document.getElementById('np-disc');
    if (glassDisc) {
      glassDisc.classList.toggle('playing', isPlaying);
    }

    // 2. Waveform bars inside placeholder
    document.querySelectorAll('.disc-waveform-bar').forEach(bar => {
      bar.style.animationPlayState = isPlaying ? 'running' : 'paused';
    });

    // 3. Now Playing Transport Play/Pause Icon
    const npIcon = document.getElementById('np-play-icon');
    if (npIcon) {
      if (isPlaying) {
        npIcon.innerHTML = `
          <rect x="5" y="4" width="4" height="16" rx="1"></rect>
          <rect x="15" y="4" width="4" height="16" rx="1"></rect>
        `;
      } else {
        npIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"></polygon>`;
      }
    }

    // 4. Mini Player Play/Pause Icon
    const miniIcon = document.getElementById('mini-play-icon');
    if (miniIcon) {
      if (isPlaying) {
        miniIcon.innerHTML = `
          <rect x="6" y="4" width="4" height="16"></rect>
          <rect x="14" y="4" width="4" height="16"></rect>
        `;
      } else {
        miniIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"></polygon>`;
      }
    }
  }

  // ─── Capture Button (System Audio Mode) ──────────────────────────────────────
  function bindCaptureButton() {
    const btn = document.getElementById('btn-capture');
    const dot = document.getElementById('capture-indicator');
    const label = document.getElementById('capture-label');
    const modeTag = document.getElementById('capture-mode-tag');

    btn?.addEventListener('click', async () => {
      if (state.capturing) {
        // Disconnect capture
        if (engine) engine.stopCapture();
        state.capturing = false;
        dot.classList.remove('active', 'error');
        if (modeTag) modeTag.textContent = 'SYSTEM AUDIO';
        label.textContent = 'WASAPI loopback not connected';
        label.classList.remove('active');
        btn.textContent = 'Connect';
        btn.classList.remove('capturing');
        if (!state.isPlayingLocal) stopVisualizer();
        updateDiagnostics();
      } else {
        // Pause local playback when starting system loopback
        if (engine && engine.isPlaying) {
          engine.pause();
        }

        btn.textContent = 'Connecting…';
        btn.disabled = true;
        label.textContent = 'Requesting audio loopback access…';

        try {
          if (!engine._isInitialized) await engine.init();

          engine.onSourceConnected = ({ trackLabel }) => {
            state.capturing = true;
            state.audioMode = 'system';
            dot.classList.add('active');
            dot.classList.remove('error');
            if (modeTag) modeTag.textContent = 'WASAPI LOOPBACK';
            label.textContent = `✓ ${trackLabel}`;
            label.classList.add('active');
            btn.textContent = 'Disconnect';
            btn.classList.add('capturing');
            btn.disabled = false;

            updateDiagnostics();
            startVisualizer();
            showToast('System Audio Loopback Connected');
          };

          engine.onSourceError = (err) => {
            state.capturing = false;
            dot.classList.add('error');
            dot.classList.remove('active');
            label.textContent = `Error: ${err.message || 'Access denied'}`;
            btn.textContent = 'Retry';
            btn.disabled = false;
          };

          await engine.captureSystemAudio();
        } catch (err) {
          state.capturing = false;
          dot.classList.add('error');
          label.textContent = `Failed: ${err.message}`;
          btn.textContent = 'Retry';
          btn.disabled = false;
        }
      }
    });
  }

  // ─── 5-Band Equalizer Builder & Presets ──────────────────────────────────────
  function buildEQBands() {
    const container = document.getElementById('eq-bands');
    if (!container) return;

    container.innerHTML = EQ_BANDS.map((band, i) => `
      <div class="eq-band-col">
        <div class="eq-db-label" id="eq-db-${i}">0.0 dB</div>
        <div class="eq-slider-wrap">
          <div class="eq-zero-line"></div>
          <input
            type="range"
            class="eq-band-slider"
            id="eq-slider-${i}"
            min="-12" max="12" step="0.5"
            value="0"
            data-band="${i}"
            aria-label="${band.freq} band"
          />
        </div>
        <div class="eq-freq-label">${band.label}</div>
      </div>
    `).join('');

    for (let i = 0; i < EQ_BANDS.length; i++) {
      const slider = document.getElementById(`eq-slider-${i}`);
      const label = document.getElementById(`eq-db-${i}`);
      if (!slider) continue;

      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        state.eqGains[i] = val;
        state.activePreset = null;
        if (label) label.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(1)} dB`;

        if (engine && !state.bypassed) {
          engine.setEQBand(i, val);
        }

        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));

        if (window.kinetixDB) {
          window.kinetixDB.saveSetting('eqGains', state.eqGains);
        }
      });
    }
  }

  function bindBypassButton() {
    const btn = document.getElementById('btn-bypass');
    btn?.addEventListener('click', () => {
      state.bypassed = !state.bypassed;
      btn.textContent = state.bypassed ? 'BYPASSED' : 'EQ ON';
      btn.classList.toggle('bypassed', state.bypassed);
      if (engine) engine.setBypassed(state.bypassed);
    });
  }

  function bindPresetButtons() {
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        applyPreset(preset);
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  function applyPreset(name) {
    const gains = EQ_PRESETS[name] || EQ_PRESETS.flat;
    state.eqGains = [...gains];
    state.activePreset = name;

    gains.forEach((g, i) => {
      const slider = document.getElementById(`eq-slider-${i}`);
      const label = document.getElementById(`eq-db-${i}`);
      if (slider) slider.value = g;
      if (label) label.textContent = `${g >= 0 ? '+' : ''}${g.toFixed(1)} dB`;
      if (engine) engine.setEQBand(i, g);
    });

    if (window.kinetixDB) {
      window.kinetixDB.saveSetting('eqGains', state.eqGains);
    }
  }

  // ─── Master Volume ──────────────────────────────────────────────────────────
  function bindMasterVolume() {
    const slider = document.getElementById('master-volume');
    const label = document.getElementById('master-vol-label');

    slider?.addEventListener('input', () => {
      const pct = parseInt(slider.value, 10);
      const v = pct / 100;
      state.volume = v;
      if (label) label.textContent = `${pct}%`;
      if (engine) engine.setVolume(v);
    });
  }

  // ─── 8D Spatial Audio Controls ──────────────────────────────────────────────
  function bindSpatialControls() {
    const toggle8D = document.getElementById('toggle-8d');
    const particle = document.getElementById('orbit-particle');
    const npParticle = document.getElementById('np-particle');
    const npOrbit = document.getElementById('np-orbit');
    const cycleSlider = document.getElementById('cycle-slider');
    const cycleVal = document.getElementById('cycle-val');
    const reverbSlider = document.getElementById('reverb-slider');
    const reverbVal = document.getElementById('reverb-val');

    toggle8D?.addEventListener('change', () => {
      state.is8D = toggle8D.checked;
      if (engine) {
        if (state.is8D) engine.enable8D();
        else engine.disable8D();
      }

      // Sync both spatial demo orbit and central vinyl disc orbit particle
      particle?.classList.toggle('active', state.is8D);
      npParticle?.classList.toggle('visible', state.is8D);

      if (state.is8D) {
        if (particle) particle.style.animationDuration = `${state.cycleTime}s`;
        if (npOrbit) npOrbit.style.setProperty('--orbit-speed', `${state.cycleTime}s`);
      }
    });

    cycleSlider?.addEventListener('input', () => {
      const val = parseFloat(cycleSlider.value);
      state.cycleTime = val;
      if (cycleVal) cycleVal.textContent = `${val.toFixed(1)}s`;
      if (engine) engine.set8DCycleTime(val);

      if (particle) particle.style.animationDuration = `${val}s`;
      if (npOrbit) npOrbit.style.setProperty('--orbit-speed', `${val}s`);
    });

    reverbSlider?.addEventListener('input', () => {
      const pct = parseInt(reverbSlider.value, 10);
      if (reverbVal) reverbVal.textContent = `${pct}%`;
      if (engine && engine._wetGain && engine.ctx) {
        engine._wetGain.gain.setTargetAtTime((pct / 100) * 0.6, engine.ctx.currentTime, 0.05);
      }
    });
  }

  // ─── Library Management & Honor Phone Storage Scanner ───────────────────────
  function bindLibraryControls() {
    const scanner = window.storageScanner;
    const btnScanDir = document.getElementById('btn-scan-dir');
    const btnAddFiles = document.getElementById('btn-add-files');
    const searchInput = document.getElementById('lib-search');
    const sortContainer = document.getElementById('lib-sort');
    const progressEl = document.getElementById('scan-progress');
    const progressFill = document.getElementById('scan-progress-fill');
    const progressText = document.getElementById('scan-progress-text');

    async function handleScan(scanMethod, modeLabel) {
      if (state.isScanning || !scanner) return;
      state.isScanning = true;

      if (progressEl) progressEl.classList.add('visible');
      if (progressFill) progressFill.style.width = '0%';
      if (progressText) progressText.textContent = `Honor Scanner: crawling ${modeLabel}…`;

      try {
        const newTracks = await scanMethod((current, total, filename) => {
          if (progressFill && total > 0) {
            const pct = Math.round((current / total) * 100);
            progressFill.style.width = `${pct}%`;
          }
          if (progressText) {
            progressText.textContent = total > 0
              ? `[${current}/${total}] ${filename}`
              : `Discovered ${current} tracks: ${filename}`;
          }
        });

        if (newTracks && newTracks.length > 0) {
          const existingIds = new Set(state.tracks.map(t => t.id));
          const unique = newTracks.filter(t => !existingIds.has(t.id));

          state.tracks.push(...unique);
          applyFilterAndSort();
          renderLibraryTracks();
          updateLibraryCount();
          updateDiagnostics();

          if (state.currentTrackIndex === -1 && state.tracks.length > 0) {
            selectTrackByIndex(0);
          }

          const countMsg = `Honor-Style Scanner: Indexed ${unique.length} track${unique.length !== 1 ? 's' : ''} from target folder`;
          showToast(countMsg, 4000);

          if (progressText) progressText.textContent = `✓ Indexed ${unique.length} new tracks`;
          setTimeout(() => progressEl?.classList.remove('visible'), 2000);
        } else {
          showToast('Scanner: No new audio files found in selection.', 2500);
          progressEl?.classList.remove('visible');
        }
      } catch (err) {
        console.error('[Library] Scan error:', err);
        showToast('Scan cancelled or failed.');
        progressEl?.classList.remove('visible');
      } finally {
        state.isScanning = false;
      }
    }

    btnScanDir?.addEventListener('click', () => {
      handleScan((onProg) => scanner.scanDirectory(onProg), 'folders');
    });

    btnAddFiles?.addEventListener('click', () => {
      handleScan((onProg) => scanner.pickFiles(onProg), 'files');
    });

    searchInput?.addEventListener('input', () => {
      state.searchQuery = searchInput.value.trim().toLowerCase();
      applyFilterAndSort();
      renderLibraryTracks();
    });

    sortContainer?.addEventListener('click', (e) => {
      const chip = e.target.closest('.sort-chip');
      if (!chip) return;
      sortContainer.querySelectorAll('.sort-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.sortKey = chip.dataset.sort;
      applyFilterAndSort();
      renderLibraryTracks();
    });
  }

  function applyFilterAndSort() {
    let list = state.tracks.slice();

    if (state.searchQuery) {
      const q = state.searchQuery;
      list = list.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.artist || '').toLowerCase().includes(q) ||
        (t.album || '').toLowerCase().includes(q)
      );
    }

    switch (state.sortKey) {
      case 'title':
        list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        break;
      case 'artist':
        list.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));
        break;
      case 'album':
        list.sort((a, b) => (a.album || '').localeCompare(b.album || ''));
        break;
      case 'duration':
        list.sort((a, b) => (b.duration || 0) - (a.duration || 0));
        break;
      case 'addedAt':
      default:
        list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        break;
    }

    state.filteredTracks = list;
  }

  function updateLibraryCount() {
    const countEl = document.getElementById('lib-count');
    const cacheEl = document.getElementById('st-cache-count');
    const countStr = `(${state.tracks.length})`;
    if (countEl) countEl.textContent = countStr;
    if (cacheEl) cacheEl.textContent = `${state.tracks.length} tracks`;
  }

  function renderLibraryTracks() {
    const container = document.getElementById('lib-track-list');
    if (!container) return;

    if (!state.filteredTracks.length) {
      container.innerHTML = `
        <div class="library-empty">
          <div class="library-empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M9 18V5l12-2v13"></path>
              <circle cx="6" cy="18" r="3"></circle>
              <circle cx="18" cy="16" r="3"></circle>
            </svg>
          </div>
          <div class="library-empty-title">Your Library is Empty</div>
          <div class="library-empty-sub">
            Use "Scan Folder" to recursively index local audio files (.mp3, .flac, .wav, .m4a, .aac, .ogg, etc.) into IndexedDB.
          </div>
        </div>
      `;
      return;
    }

    const currentId = state.currentTrack?.id;
    const isPlaying = engine?.isPlaying;

    container.innerHTML = state.filteredTracks.map((track, idx) => {
      const isCurrent = track.id === currentId;
      const isPlayingCurrent = isCurrent && isPlaying;
      const hasCover = !!track.coverArtUrl;

      return `
        <div class="library-track ${isPlayingCurrent ? 'playing' : ''}" data-index="${idx}" data-id="${track.id}">
          <div class="track-thumb">
            ${hasCover
              ? `<img src="${track.coverArtUrl}" alt="" loading="lazy" />`
              : `<div class="track-thumb-placeholder">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18V5l12-2v13"></path>
                    <circle cx="6" cy="18" r="3"></circle>
                    <circle cx="18" cy="16" r="3"></circle>
                  </svg>
                </div>`}
          </div>

          <div class="track-meta">
            <div class="track-name">${escapeHtml(track.title || track.fileName || 'Unknown Title')}</div>
            <div class="track-sub">${escapeHtml(track.artist || 'Unknown Artist')}${track.album ? ' · ' + escapeHtml(track.album) : ''}</div>
          </div>

          <div class="track-duration">${formatTime(track.duration)}</div>

          <button class="track-delete-btn" data-delete-id="${track.id}" title="Delete track from IndexedDB" aria-label="Delete track">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.library-track').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.track-delete-btn')) return;
        const idx = parseInt(row.dataset.index, 10);
        playTrackByIndex(idx);
      });
    });

    container.querySelectorAll('.track-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.deleteId;
        if (!id) return;

        if (window.kinetixDB) {
          await window.kinetixDB.deleteTrack(id);
        }

        state.tracks = state.tracks.filter(t => t.id !== id);
        applyFilterAndSort();
        renderLibraryTracks();
        updateLibraryCount();
        updateDiagnostics();
        showToast('Track removed from library cache.');
      });
    });
  }

  // ─── Playback Sequencing ────────────────────────────────────────────────────
  function selectTrackByIndex(index) {
    if (index < 0 || index >= state.filteredTracks.length) return;
    const track = state.filteredTracks[index];
    state.currentTrackIndex = index;
    state.currentTrack = track;

    updateNowPlayingUI(track);
  }

  async function playTrackByIndex(index) {
    if (index < 0 || index >= state.filteredTracks.length) return;
    const track = state.filteredTracks[index];
    state.currentTrackIndex = index;
    state.currentTrack = track;
    state.audioMode = 'local';

    // Disconnect system capture if active
    if (state.capturing && engine) {
      engine.stopCapture();
      state.capturing = false;
      const dot = document.getElementById('capture-indicator');
      const btn = document.getElementById('btn-capture');
      dot?.classList.remove('active');
      if (btn) {
        btn.textContent = 'Connect';
        btn.classList.remove('capturing');
      }
    }

    // Update banner for local mode
    const modeTag = document.getElementById('capture-mode-tag');
    const label = document.getElementById('capture-label');
    const dot = document.getElementById('capture-indicator');
    if (modeTag) modeTag.textContent = 'LOCAL PLAYBACK';
    if (label) {
      label.textContent = `♫ ${track.title} — ${track.artist}`;
      label.classList.add('active');
    }
    if (dot) dot.classList.add('active');

    // Update Now Playing & Mini Player UI
    updateNowPlayingUI(track);

    const audioBlob = track.file || track.audioBlob;
    if (audioBlob instanceof Blob) {
      try {
        await engine.loadTrack(audioBlob, track);
        await engine.play();
        updatePlayButtonUI(true);
        renderLibraryTracks();
        startVisualizer();
      } catch (err) {
        console.error('[KinetixApp] Failed to play track blob:', err);
        showToast('Playback error: Audio buffer unavailable.');
      }
    } else {
      showToast('Track file reference lost. Please re-scan your folder.');
    }

    updateDiagnostics();
  }

  function playNextTrack() {
    if (!state.filteredTracks.length) return;

    let nextIdx;
    if (state.shuffle && state.filteredTracks.length > 1) {
      do {
        nextIdx = Math.floor(Math.random() * state.filteredTracks.length);
      } while (nextIdx === state.currentTrackIndex);
    } else {
      nextIdx = (state.currentTrackIndex + 1) % state.filteredTracks.length;
    }

    playTrackByIndex(nextIdx);
  }

  function playPrevTrack() {
    if (!state.filteredTracks.length) return;
    if (engine && engine.currentTime > 3) {
      engine.seek(0);
      return;
    }

    let prevIdx;
    if (state.shuffle && state.filteredTracks.length > 1) {
      do {
        prevIdx = Math.floor(Math.random() * state.filteredTracks.length);
      } while (prevIdx === state.currentTrackIndex);
    } else {
      prevIdx = (state.currentTrackIndex - 1 + state.filteredTracks.length) % state.filteredTracks.length;
    }

    playTrackByIndex(prevIdx);
  }

  function updateMiniPlayerUI(track) {
    const titleEl = document.getElementById('mini-title');
    const artistEl = document.getElementById('mini-artist');
    const thumbEl = document.getElementById('mini-thumb');
    const totalEl = document.getElementById('mini-time-total');

    if (titleEl) titleEl.textContent = track.title || track.fileName || 'Unknown Title';
    if (artistEl) artistEl.textContent = track.artist || 'Unknown Artist';
    if (totalEl) totalEl.textContent = formatTime(track.duration);

    if (thumbEl) {
      if (track.coverArtUrl) {
        thumbEl.innerHTML = `<img src="${track.coverArtUrl}" alt="" />`;
      } else {
        thumbEl.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18V5l12-2v13"></path>
            <circle cx="6" cy="18" r="3"></circle>
            <circle cx="18" cy="16" r="3"></circle>
          </svg>
        `;
      }
    }
  }

  // ─── Mini Player Dock Controls ──────────────────────────────────────────────
  function bindMiniPlayerControls() {
    const btnPlay = document.getElementById('btn-mini-play');
    const btnPrev = document.getElementById('btn-mini-prev');
    const btnNext = document.getElementById('btn-mini-next');
    const timeline = document.getElementById('mini-timeline');

    btnPlay?.addEventListener('click', () => {
      if (!engine) return;
      if (state.currentTrackIndex === -1 && state.filteredTracks.length > 0) {
        playTrackByIndex(0);
        return;
      }
      engine.togglePlay();
    });

    btnPrev?.addEventListener('click', () => playPrevTrack());
    btnNext?.addEventListener('click', () => playNextTrack());

    timeline?.addEventListener('click', (e) => {
      if (!engine || !engine.duration) return;
      const rect = timeline.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      const targetSec = pct * engine.duration;
      engine.seek(targetSec);
    });
  }

  // ─── Settings Controls ──────────────────────────────────────────────────────
  function bindSettingsControls() {
    const togglePower = document.getElementById('toggle-power-saver');
    togglePower?.addEventListener('change', () => {
      if (engine && typeof engine.setPowerSaver === 'function') {
        engine.setPowerSaver(togglePower.checked);
      }
    });

    const btnClearCache = document.getElementById('btn-clear-cache');
    btnClearCache?.addEventListener('click', async () => {
      if (!window.kinetixDB) return;
      const ok = confirm('Clear all cached tracks and audio blobs from IndexedDB?');
      if (!ok) return;

      await window.kinetixDB.clearTracks();
      state.tracks = [];
      state.filteredTracks = [];
      state.currentTrackIndex = -1;
      state.currentTrack = null;

      if (engine && engine.isPlaying) {
        engine.pause();
      }

      applyFilterAndSort();
      renderLibraryTracks();
      updateLibraryCount();
      updateDiagnostics();
      showToast('IndexedDB audio cache completely wiped.');
    });

    document.getElementById('vb-cable-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      window.open('https://vb-audio.com/Cable/', '_blank');
    });
  }

  function updateDiagnostics() {
    const srEl = document.getElementById('st-samplerate');
    const latEl = document.getElementById('st-latency');
    const srcEl = document.getElementById('st-source');

    if (engine && engine.ctx) {
      if (srEl) srEl.textContent = `${engine.sampleRate.toLocaleString()} Hz`;
      if (latEl) latEl.textContent = engine.latency > 0
        ? `${(engine.latency * 1000).toFixed(1)} ms`
        : '< 1 ms';
    }

    if (srcEl) {
      if (state.capturing) {
        srcEl.textContent = 'WASAPI System Audio Loopback';
      } else if (state.isPlayingLocal && state.currentTrack) {
        srcEl.textContent = `Local File (${state.currentTrack.format?.toUpperCase() || 'AUDIO'})`;
      } else {
        srcEl.textContent = 'Idle (No active stream)';
      }
    }
  }

  // ─── Tray IPC Synchronization ───────────────────────────────────────────────
  function bindTrayEvents() {
    if (!window.kinetixElectron) return;

    window.kinetixElectron.onBypassToggle((checked) => {
      state.bypassed = !checked;
      const btn = document.getElementById('btn-bypass');
      if (btn) {
        btn.textContent = state.bypassed ? 'BYPASSED' : 'EQ ON';
        btn.classList.toggle('bypassed', state.bypassed);
      }
      if (engine) engine.setBypassed(state.bypassed);
    });

    window.kinetixElectron.onApplyPreset((name) => {
      applyPreset(name);
      document.querySelectorAll('.preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.preset === name);
      });
    });
  }

  // ─── Unified Spectrum Visualizer ────────────────────────────────────────────
  function initVisualizer() {
    const canvas = document.getElementById('eq-canvas');
    if (!canvas) return;
    canvasCtx = canvas.getContext('2d');
    drawFlatLine();
  }

  function drawFlatLine() {
    const canvas = document.getElementById('eq-canvas');
    if (!canvas || !canvasCtx) return;
    const W = canvas.width, H = canvas.height;
    canvasCtx.clearRect(0, 0, W, H);
    canvasCtx.strokeStyle = 'rgba(57, 255, 20, 0.2)';
    canvasCtx.lineWidth = 1.5;
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, H / 2);
    canvasCtx.lineTo(W, H / 2);
    canvasCtx.stroke();
  }

  function startVisualizer() {
    const canvas = document.getElementById('eq-canvas');
    const analyser = engine?.analyser;
    if (!canvas || !canvasCtx || !analyser) return;

    if (rafId) cancelAnimationFrame(rafId);

    const bufLen = analyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);

    function draw() {
      if (!state.capturing && !engine.isPlaying) {
        stopVisualizer();
        return;
      }

      rafId = requestAnimationFrame(draw);
      if (document.hidden) return;

      analyser.getByteFrequencyData(dataArr);

      const W = canvas.width;
      const H = canvas.height;
      canvasCtx.clearRect(0, 0, W, H);

      const bgGrad = canvasCtx.createLinearGradient(0, 0, 0, H);
      bgGrad.addColorStop(0, 'rgba(42, 8, 92, 0.15)');
      bgGrad.addColorStop(1, 'transparent');
      canvasCtx.fillStyle = bgGrad;
      canvasCtx.fillRect(0, 0, W, H);

      const barW = (W / bufLen) * 2.5;
      const grad = canvasCtx.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, 'rgba(57, 255, 20, 0.9)');
      grad.addColorStop(0.6, 'rgba(57, 255, 20, 0.5)');
      grad.addColorStop(1, 'rgba(147, 51, 234, 0.6)');

      let x = 0;
      for (let i = 0; i < bufLen; i++) {
        const barH = (dataArr[i] / 255) * H;
        canvasCtx.fillStyle = grad;
        canvasCtx.fillRect(x, H - barH, barW - 1, barH);
        x += barW + 1;
        if (x > W) break;
      }

      canvasCtx.strokeStyle = 'rgba(57, 255, 20, 0.15)';
      canvasCtx.lineWidth = 1;
      canvasCtx.beginPath();
      canvasCtx.moveTo(0, H / 2);
      canvasCtx.lineTo(W, H / 2);
      canvasCtx.stroke();
    }

    draw();
  }

  function stopVisualizer() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    drawFlatLine();
  }

})();
