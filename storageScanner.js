/**
 * @file storageScanner.js
 * @description Honor Phone Music Player grade local file system scanner for KINETIX.
 * Supports HTML5 File System Access API (showDirectoryPicker / showOpenFilePicker)
 * with deep auto-targeted recursive folder traversal and universal fallback
 * <input type="file" webkitdirectory directory multiple accept="...">.
 *
 * Supported Formats Whitelist:
 * ['.mp3', '.m4a', '.wav', '.amr', '.awb', '.ogg', '.aac', '.mka', '.flac', '.ape', '.3gp', '.3g2', '.mid', '.smf', '.xmf']
 *
 * Zero-byte, encrypted, or unsupported files are safely ignored without interrupting batches.
 * Raw binary audio Blobs are automatically cached into IndexedDB for persistent offline playback.
 */

(function (root, factory) {
  const lib = factory();
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = lib;
  } else {
    root.storageScanner = lib;
    root.KinetixStorageScanner = lib;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  // Honor Phone Music Player Grade Whitelist
  const HONOR_AUDIO_EXTENSIONS = [
    '.mp3', '.m4a', '.wav', '.amr', '.awb', '.ogg', '.aac',
    '.mka', '.flac', '.ape', '.3gp', '.3g2', '.mid', '.smf', '.xmf'
  ];

  const SUPPORTED_EXTS = new Set(
    HONOR_AUDIO_EXTENSIONS.map(function (ext) { return ext.replace(/^\./, '').toLowerCase(); })
  );

  const FILE_INPUT_ACCEPT = HONOR_AUDIO_EXTENSIONS.join(',') + ',audio/*';

  function getExtension(name) {
    if (!name) return '';
    const parts = name.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  }

  function isAudioFile(file) {
    if (!file || !file.size || file.size <= 0) return false;
    const ext = getExtension(file.name);
    return SUPPORTED_EXTS.has(ext) || /^audio\//i.test(file.type || '');
  }

  function isEncryptedTrack(buffer, ext) {
    if (['m4p', 'drm'].includes(ext)) return true;
    if (!buffer || buffer.byteLength < 4) return false;
    const bytes = new Uint8Array(buffer);

    // Common proprietary encrypted audio headers
    // NCM (CTENFDAM)
    if (bytes[0] === 0x43 && bytes[1] === 0x54 && bytes[2] === 0x45 && bytes[3] === 0x4e) return true;
    // KGM / KGMOR (0x7c, 0xd5, 0x32, 0xeb)
    if (bytes[0] === 0x7c && bytes[1] === 0xd5 && bytes[2] === 0x32 && bytes[3] === 0xeb) return true;

    // Fast check for DRM signatures like 'drms', 'sinf', 'enca', 'encv'
    let str = '';
    const maxLen = Math.min(bytes.length, 64);
    for (let i = 0; i < maxLen; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    if (str.includes('drms') || str.includes('sinf') || str.includes('enca') || str.includes('encv')) {
      return true;
    }

    return false;
  }

  function generateTrackId(file) {
    const raw = `${file.name}-${file.size}-${file.lastModified}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return `track_${(hash >>> 0).toString(36)}_${file.size.toString(36)}`;
  }

  async function processFiles(files, onProgress) {
    const parser = (typeof window !== 'undefined' && window.id3Parser) ? window.id3Parser : null;
    const db = (typeof window !== 'undefined' && window.kinetixDB) ? window.kinetixDB : null;

    const tracks = [];
    const total = files.length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // 1. Safely ignore zero-byte or null files
      if (!file || !file.size || file.size <= 0) {
        console.warn('[HonorScanner] Safely ignoring zero-byte file:', file ? file.name : 'unknown');
        continue;
      }

      // 2. Validate extension against Honor whitelist
      const ext = getExtension(file.name);
      if (!SUPPORTED_EXTS.has(ext) && (!file.type || !/^audio\//i.test(file.type))) {
        console.warn('[HonorScanner] Safely ignoring unsupported format:', file.name);
        continue;
      }

      if (onProgress) {
        onProgress(i + 1, total, file.name);
      }

      try {
        // 3. Quick probe slice to detect encryption / unreadable files
        const probeSlice = file.slice(0, Math.min(file.size, 128));
        const probeBuffer = await probeSlice.arrayBuffer();
        if (!probeBuffer || probeBuffer.byteLength === 0) {
          console.warn('[HonorScanner] Safely ignoring empty/unreadable file:', file.name);
          continue;
        }

        if (isEncryptedTrack(probeBuffer, ext)) {
          console.warn('[HonorScanner] Safely ignoring encrypted/DRM track:', file.name);
          continue;
        }

        // 4. Extract audio metadata (title, artist, album, cover art) via id3Parser
        let meta = {
          title: file.name.replace(/\.[^/.]+$/, ''),
          artist: 'Unknown Artist',
          album: 'Unknown Album',
          duration: 0,
          coverArtBlob: null,
          format: ext || 'mp3'
        };

        if (parser && typeof parser.parseAudioFile === 'function') {
          try {
            meta = await parser.parseAudioFile(file);
          } catch (pErr) {
            console.warn('[HonorScanner] Metadata parse fallback for:', file.name, pErr);
          }
        }

        let coverArtUrl = null;
        if (meta.coverArtBlob instanceof Blob) {
          try {
            coverArtUrl = URL.createObjectURL(meta.coverArtBlob);
          } catch {
            coverArtUrl = null;
          }
        }

        // 5. Build track object with raw binary audio Blob attached for offline persistence
        const track = {
          id: generateTrackId(file),
          title: meta.title || file.name.replace(/\.[^/.]+$/, ''),
          artist: meta.artist || 'Unknown Artist',
          album: meta.album || 'Unknown Album',
          duration: meta.duration || 0,
          format: meta.format || ext || 'mp3',
          fileName: file.name,
          filePath: file._relativePath || file.webkitRelativePath || file.name,
          fileSize: file.size,
          coverArtBlob: meta.coverArtBlob || null,
          coverArtUrl: coverArtUrl,
          file: file, // in-memory live reference
          audioBlob: file, // raw binary audio Blob for IndexedDB persistence
          fileHandle: file._fileHandle || null,
          addedAt: Date.now()
        };

        // 6. Automatically save raw binary audio Blob into IndexedDB
        if (db && typeof db.addTrack === 'function') {
          try {
            await db.addTrack(track);
          } catch (dbErr) {
            console.warn('[HonorScanner] DB cache warning for', track.title, dbErr);
          }
        }

        tracks.push(track);
      } catch (err) {
        // Safely ignore errors without interrupting the scanning batch
        console.warn('[HonorScanner] Safely skipped problematic file:', file.name, err);
      }
    }

    return tracks;
  }

  // ─── Auto-Targeted Recursive Directory Scanner ─────────────────────────────────

  async function collectFilesFromDirHandle(dirHandle, accumulator = [], depth = 0, onProgress = null, currentPath = '') {
    if (depth > 50) return accumulator;

    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file') {
        const ext = getExtension(name);
        if (SUPPORTED_EXTS.has(ext)) {
          try {
            const file = await handle.getFile();
            // Verify not zero-byte
            if (file && file.size > 0) {
              file._fileHandle = handle;
              file._relativePath = currentPath ? `${currentPath}/${name}` : name;
              accumulator.push(file);
              if (onProgress && accumulator.length % 5 === 0) {
                onProgress(accumulator.length, 0, `Discovered ${accumulator.length} tracks (${name})…`);
              }
            }
          } catch (e) {
            console.warn('[HonorScanner] File read error:', name, e);
          }
        }
      } else if (handle.kind === 'directory') {
        // Skip hidden and system directories
        const isSystemOrHidden = name.startsWith('.') || name.startsWith('$') ||
          name === 'node_modules' || name === 'System Volume Information' || name === '.thumbnails';
        if (!isSystemOrHidden) {
          const nextPath = currentPath ? `${currentPath}/${name}` : name;
          await collectFilesFromDirHandle(handle, accumulator, depth + 1, onProgress, nextPath);
        }
      }
    }
    return accumulator;
  }

  function pickDirectoryInput(onProgress) {
    return new Promise(function (resolve) {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
      input.multiple = true;
      input.accept = FILE_INPUT_ACCEPT;
      input.style.display = 'none';

      input.addEventListener('change', async function () {
        const fileList = input.files ? Array.from(input.files) : [];
        input.remove();

        // Filter valid audio files, ignore zero-byte files
        const valid = fileList.filter(function (f) { return isAudioFile(f) && f.size > 0; });
        if (!valid.length) {
          resolve([]);
          return;
        }
        const tracks = await processFiles(valid, onProgress);
        resolve(tracks);
      });

      input.addEventListener('cancel', function () {
        input.remove();
        resolve([]);
      });

      document.body.appendChild(input);
      input.click();
    });
  }

  async function scanDirectory(onProgress) {
    if ('showDirectoryPicker' in window) {
      let dirHandle;
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      } catch (err) {
        if (err.name === 'AbortError') return [];
        console.warn('[HonorScanner] showDirectoryPicker error, using input fallback:', err);
        return pickDirectoryInput(onProgress);
      }

      if (onProgress) onProgress(0, 0, 'Recursively crawling directory tree…');

      const files = await collectFilesFromDirHandle(dirHandle, [], 0, onProgress);
      if (!files.length) return [];

      return processFiles(files, onProgress);
    } else {
      return pickDirectoryInput(onProgress);
    }
  }

  // ─── File Picker (showOpenFilePicker + input fallback) ───────────────────────

  async function pickFiles(onProgress) {
    if ('showOpenFilePicker' in window) {
      let handles = [];
      try {
        handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{
            description: 'Honor-Grade Audio Files',
            accept: {
              'audio/*': HONOR_AUDIO_EXTENSIONS
            }
          }]
        });
      } catch (err) {
        if (err.name === 'AbortError') return [];
        return pickFilesLegacy(onProgress);
      }

      const files = [];
      for (const h of handles) {
        try {
          const file = await h.getFile();
          if (isAudioFile(file) && file.size > 0) {
            file._fileHandle = h;
            files.push(file);
          }
        } catch (e) {
          console.warn('[HonorScanner] File read error:', e);
        }
      }
      return processFiles(files, onProgress);
    } else {
      return pickFilesLegacy(onProgress);
    }
  }

  function pickFilesLegacy(onProgress) {
    return new Promise(function (resolve) {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = FILE_INPUT_ACCEPT;
      input.style.display = 'none';

      input.addEventListener('change', async function () {
        const fileList = input.files ? Array.from(input.files) : [];
        input.remove();
        const valid = fileList.filter(function (f) { return isAudioFile(f) && f.size > 0; });
        if (!valid.length) {
          resolve([]);
          return;
        }
        const tracks = await processFiles(valid, onProgress);
        resolve(tracks);
      });

      input.addEventListener('cancel', function () {
        input.remove();
        resolve([]);
      });

      document.body.appendChild(input);
      input.click();
    });
  }

  function isFSAAvailable() {
    return 'showDirectoryPicker' in window || 'showOpenFilePicker' in window;
  }

  return {
    scanDirectory: scanDirectory,
    pickFiles: pickFiles,
    pickFilesLegacy: pickFilesLegacy,
    isFSAAvailable: isFSAAvailable,
    isAudioFile: isAudioFile,
    generateTrackId: generateTrackId,
    HONOR_AUDIO_EXTENSIONS: HONOR_AUDIO_EXTENSIONS,
    SUPPORTED_EXTS: SUPPORTED_EXTS
  };
});
