/**
 * @file id3Parser.js
 * @description Client-side ID3v2 (v2.3, v2.4) tag parser, FLAC Vorbis Comment reader,
 * embedded APIC album art extractor, and audio duration detector for KINETIX.
 * Pure browser JavaScript — zero dependencies, zero build step.
 */

(function (root, factory) {
  const lib = factory();
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = lib;
  } else {
    root.id3Parser = lib;
    // Backwards-compatible namespace
    root.KinetixID3 = lib;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  // ─── Binary Helpers ──────────────────────────────────────────────────────────

  function readUint32BE(view, offset) {
    return (
      ((view.getUint8(offset) << 24) |
        (view.getUint8(offset + 1) << 16) |
        (view.getUint8(offset + 2) << 8) |
        view.getUint8(offset + 3)) >>>
      0
    );
  }

  function readSynchsafe(view, offset) {
    return (
      ((view.getUint8(offset) & 0x7f) << 21) |
      ((view.getUint8(offset + 1) & 0x7f) << 14) |
      ((view.getUint8(offset + 2) & 0x7f) << 7) |
      (view.getUint8(offset + 3) & 0x7f)
    );
  }

  function bytesToAscii(bytes, offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(bytes[offset + i]);
    }
    return s;
  }

  function decodeLatin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) break;
      s += String.fromCharCode(bytes[i]);
    }
    return s.trim();
  }

  function decodeTextFrame(bytes) {
    if (!bytes || bytes.length < 2) return '';
    const encoding = bytes[0];
    const textBytes = bytes.slice(1);

    try {
      switch (encoding) {
        case 0:
          return decodeLatin1(textBytes);
        case 1: {
          const isBE = textBytes.length >= 2 && textBytes[0] === 0xfe && textBytes[1] === 0xff;
          const isLE = textBytes.length >= 2 && textBytes[0] === 0xff && textBytes[1] === 0xfe;
          const codec = isBE ? 'utf-16be' : 'utf-16le';
          const payload = isBE || isLE ? textBytes.slice(2) : textBytes;
          return new TextDecoder(codec).decode(payload).replace(/\0+$/, '').trim();
        }
        case 2:
          return new TextDecoder('utf-16be').decode(textBytes).replace(/\0+$/, '').trim();
        case 3:
        default:
          return new TextDecoder('utf-8').decode(textBytes).replace(/\0+$/, '').trim();
      }
    } catch {
      return decodeLatin1(textBytes);
    }
  }

  // ─── ID3v2 Parser ────────────────────────────────────────────────────────────

  function parseID3v2(buffer) {
    const result = { title: null, artist: null, album: null, coverArtBlob: null };
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    if (bytes.length < 10) return result;
    if (bytesToAscii(bytes, 0, 3) !== 'ID3') return result;

    const majorVersion = bytes[3]; // 3 = ID3v2.3, 4 = ID3v2.4
    const flags = bytes[5];
    const hasExtHeader = (flags & 0x40) !== 0;
    const tagSize = readSynchsafe(view, 6) + 10;

    let offset = 10;
    if (hasExtHeader) {
      if (majorVersion === 3) {
        const extSize = readUint32BE(view, offset);
        offset += 4 + extSize;
      } else if (majorVersion === 4) {
        const extSize = readSynchsafe(view, offset);
        offset += extSize;
      }
    }

    while (offset < tagSize - 10 && offset < bytes.length - 10) {
      const frameId = bytesToAscii(bytes, offset, 4);
      if (!frameId || frameId.charCodeAt(0) === 0) break;

      let frameSize;
      if (majorVersion === 4) {
        frameSize = readSynchsafe(view, offset + 4);
      } else {
        frameSize = readUint32BE(view, offset + 4);
      }

      if (frameSize <= 0 || offset + 10 + frameSize > bytes.length) break;
      const frameData = bytes.slice(offset + 10, offset + 10 + frameSize);

      switch (frameId) {
        case 'TIT2':
          result.title = decodeTextFrame(frameData);
          break;
        case 'TPE1':
          result.artist = decodeTextFrame(frameData);
          break;
        case 'TALB':
          result.album = decodeTextFrame(frameData);
          break;
        case 'APIC':
          result.coverArtBlob = parseAPIC(frameData);
          break;
      }

      offset += 10 + frameSize;
    }

    return result;
  }

  function parseAPIC(data) {
    if (!data || data.length < 4) return null;
    try {
      const encoding = data[0];
      let pos = 1;

      let mimeEnd = pos;
      while (mimeEnd < data.length && data[mimeEnd] !== 0) mimeEnd++;
      const mimeType = decodeLatin1(data.slice(pos, mimeEnd)) || 'image/jpeg';
      pos = mimeEnd + 1;
      if (pos >= data.length) return null;

      // Picture type byte
      pos += 1;

      // Description (null-terminated)
      if (encoding === 0 || encoding === 3) {
        while (pos < data.length && data[pos] !== 0) pos++;
        pos += 1;
      } else {
        while (pos + 1 < data.length && !(data[pos] === 0 && data[pos + 1] === 0)) pos++;
        pos += 2;
      }

      if (pos >= data.length) return null;
      const imgBytes = data.slice(pos);
      return new Blob([imgBytes], { type: mimeType });
    } catch {
      return null;
    }
  }

  // ─── FLAC Parser ─────────────────────────────────────────────────────────────

  function parseFLACMetadata(buffer) {
    const result = { title: null, artist: null, album: null, coverArtBlob: null };
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    if (bytes.length < 4 || bytesToAscii(bytes, 0, 4) !== 'fLaC') return result;

    let offset = 4;
    let isLast = false;

    while (!isLast && offset + 4 <= bytes.length) {
      const headerByte = bytes[offset];
      isLast = (headerByte & 0x80) !== 0;
      const blockType = headerByte & 0x7f;
      const blockLength =
        (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      offset += 4;

      if (offset + blockLength > bytes.length) break;

      if (blockType === 4) {
        // VORBIS_COMMENT
        try {
          let pos = offset;
          const vendorLen = view.getUint32(pos, true);
          pos += 4 + vendorLen;
          const userCommentCount = view.getUint32(pos, true);
          pos += 4;

          for (let i = 0; i < userCommentCount && pos + 4 <= offset + blockLength; i++) {
            const commentLen = view.getUint32(pos, true);
            pos += 4;
            if (pos + commentLen > offset + blockLength) break;
            const commentStr = new TextDecoder('utf-8').decode(
              bytes.slice(pos, pos + commentLen)
            );
            pos += commentLen;

            const eqIdx = commentStr.indexOf('=');
            if (eqIdx !== -1) {
              const key = commentStr.slice(0, eqIdx).toUpperCase();
              const val = commentStr.slice(eqIdx + 1).trim();
              if (key === 'TITLE') result.title = val;
              else if (key === 'ARTIST') result.artist = val;
              else if (key === 'ALBUM') result.album = val;
            }
          }
        } catch {
          /* ignore */
        }
      } else if (blockType === 6) {
        // PICTURE
        try {
          let p = offset;
          // picture type (4 bytes)
          p += 4;
          const mimeLen = view.getUint32(p, false);
          p += 4;
          const mime = bytesToAscii(bytes, p, mimeLen) || 'image/jpeg';
          p += mimeLen;
          const descLen = view.getUint32(p, false);
          p += 4 + descLen;
          // width(4), height(4), depth(4), colors(4)
          p += 16;
          const dataLen = view.getUint32(p, false);
          p += 4;
          if (p + dataLen <= bytes.length) {
            result.coverArtBlob = new Blob([bytes.slice(p, p + dataLen)], { type: mime });
          }
        } catch {
          /* ignore */
        }
      }

      offset += blockLength;
    }

    return result;
  }

  // ─── Filename Parser Fallback ────────────────────────────────────────────────

  function parseFilename(filename) {
    const name = filename.replace(/\.[^/.]+$/, '');
    const dashMatch = name.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (dashMatch) {
      return { artist: dashMatch[1].trim(), title: dashMatch[2].trim() };
    }
    const numMatch = name.match(/^[\d\s._-]+(.+)$/);
    if (numMatch && numMatch[1].trim()) {
      return { artist: 'Unknown Artist', title: numMatch[1].trim() };
    }
    return { artist: 'Unknown Artist', title: name.trim() || filename };
  }

  // ─── Fast Duration Detector ─────────────────────────────────────────────────

  function detectDuration(file) {
    return new Promise(function (resolve) {
      try {
        const audio = new Audio();
        const url = URL.createObjectURL(file);
        audio.preload = 'metadata';

        const timer = setTimeout(function () {
          try { URL.revokeObjectURL(url); } catch {}
          resolve(0);
        }, 1200);

        audio.onloadedmetadata = function () {
          clearTimeout(timer);
          const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
          try { URL.revokeObjectURL(url); } catch {}
          resolve(dur);
        };

        audio.onerror = function () {
          clearTimeout(timer);
          try { URL.revokeObjectURL(url); } catch {}
          resolve(0);
        };

        audio.src = url;
      } catch {
        resolve(0);
      }
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async function parseAudioFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const format = ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg'].includes(ext) ? ext : 'mp3';

    let meta = { title: null, artist: null, album: null, coverArtBlob: null };

    try {
      // Read header chunk (up to 2MB for tags + embedded artwork)
      const readSize = Math.min(file.size, 2 * 1024 * 1024);
      const slice = file.slice(0, readSize);
      const buffer = await slice.arrayBuffer();

      if (format === 'flac') {
        meta = parseFLACMetadata(buffer);
      } else if (format === 'mp3' || format === 'm4a' || format === 'aac') {
        meta = parseID3v2(buffer);
      }
    } catch (err) {
      console.warn('[id3Parser] Tag extraction warning for', file.name, err);
    }

    // Filename fallback for missing title/artist
    if (!meta.title || !meta.artist) {
      const fromFilename = parseFilename(file.name);
      if (!meta.title) meta.title = fromFilename.title;
      if (!meta.artist) meta.artist = fromFilename.artist;
    }
    if (!meta.album) meta.album = 'Unknown Album';

    // Fast duration detection via audio metadata header
    const duration = await detectDuration(file);

    return {
      title: meta.title || file.name.replace(/\.[^/.]+$/, ''),
      artist: meta.artist || 'Unknown Artist',
      album: meta.album || 'Unknown Album',
      coverArtBlob: meta.coverArtBlob || null,
      duration: duration || 0,
      format: format
    };
  }

  function extractCoverArt(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length >= 3 && bytesToAscii(bytes, 0, 3) === 'ID3') {
      return parseID3v2(arrayBuffer).coverArtBlob;
    }
    if (bytes.length >= 4 && bytesToAscii(bytes, 0, 4) === 'fLaC') {
      return parseFLACMetadata(arrayBuffer).coverArtBlob;
    }
    return null;
  }

  return {
    parseAudioFile: parseAudioFile,
    extractCoverArt: extractCoverArt,
    parseFilename: parseFilename
  };
});
