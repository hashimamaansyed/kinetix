/**
 * @file db.js
 * @description IndexedDB offline storage service for KINETIX.
 * Stores track metadata (including cover art blobs) and user preferences.
 * Database: KinetixDB (v1)
 * Object stores: 'tracks' (keyPath: 'id'), 'settings' (keyPath: 'key')
 */

(function (root, factory) {
  const lib = factory();
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = lib;
  } else {
    root.kinetixDB = lib;
    // Backwards-compatible namespace
    root.KinetixDB = lib;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const DB_NAME = 'KinetixDB';
  const DB_VERSION = 1;
  let dbInstance = null;

  // ─── Initialization ──────────────────────────────────────────────────────────

  function initDB() {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) {
        return reject(new Error('IndexedDB is not supported in this browser environment.'));
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function (event) {
        const db = event.target.result;

        // Tracks store
        if (!db.objectStoreNames.contains('tracks')) {
          const trackStore = db.createObjectStore('tracks', { keyPath: 'id' });
          trackStore.createIndex('title', 'title', { unique: false });
          trackStore.createIndex('artist', 'artist', { unique: false });
          trackStore.createIndex('album', 'album', { unique: false });
          trackStore.createIndex('addedAt', 'addedAt', { unique: false });
        }

        // Settings store
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = function (event) {
        dbInstance = event.target.result;
        dbInstance.onclose = function () { dbInstance = null; };
        dbInstance.onerror = function (e) { console.error('[KinetixDB] Unhandled error:', e); };
        resolve(dbInstance);
      };

      request.onerror = function (event) {
        console.error('[KinetixDB] Open failed:', event.target.error);
        reject(event.target.error);
      };

      request.onblocked = function () {
        console.warn('[KinetixDB] Database upgrade blocked by another open tab.');
      };
    });
  }

  async function getDB() {
    if (dbInstance) return dbInstance;
    return initDB();
  }

  // ─── Serialization Helpers ──────────────────────────────────────────────────

  function serializeTrack(track) {
    // Exclude live DOM objects / handles that cannot be cloned reliably into IDB
    const clone = {
      id: track.id,
      title: track.title || 'Unknown Title',
      artist: track.artist || 'Unknown Artist',
      album: track.album || 'Unknown Album',
      duration: track.duration || 0,
      format: track.format || 'mp3',
      fileName: track.fileName || track.filePath || '',
      fileSize: track.fileSize || (track.file ? track.file.size : 0),
      addedAt: track.addedAt || Date.now()
    };

    // Store cover art as raw Blob
    if (track.coverArtBlob instanceof Blob) {
      clone.coverArtBlob = track.coverArtBlob;
    }

    // Store audio binary as raw Blob for persistent offline playback
    if (track.audioBlob instanceof Blob) {
      clone.audioBlob = track.audioBlob;
    } else if (track.file instanceof Blob) {
      clone.audioBlob = track.file;
    }

    return clone;
  }

  function deserializeTrack(record) {
    const audioBlob = record.audioBlob || null;
    const track = Object.assign({}, record, {
      file: audioBlob,
      audioBlob: audioBlob,
      fileHandle: null,
      coverArtUrl: null
    });

    if (track.coverArtBlob instanceof Blob) {
      try {
        track.coverArtUrl = URL.createObjectURL(track.coverArtBlob);
      } catch {
        track.coverArtUrl = null;
      }
    }
    return track;
  }

  // ─── Tracks Store Operations ─────────────────────────────────────────────────

  async function getAllTracks() {
    const db = await getDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('tracks', 'readonly');
      const store = tx.objectStore('tracks');
      const index = store.index('addedAt');
      const request = index.getAll();

      request.onsuccess = function () {
        const rows = request.result || [];
        resolve(rows.map(deserializeTrack));
      };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function addTrack(track) {
    const db = await getDB();
    const storable = serializeTrack(track);

    return new Promise(function (resolve, reject) {
      const tx = db.transaction('tracks', 'readwrite');
      const store = tx.objectStore('tracks');
      const request = store.put(storable);

      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function deleteTrack(id) {
    const db = await getDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('tracks', 'readwrite');
      const store = tx.objectStore('tracks');
      const request = store.delete(id);

      request.onsuccess = function () { resolve(); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function clearTracks() {
    const db = await getDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('tracks', 'readwrite');
      const store = tx.objectStore('tracks');
      const request = store.clear();

      request.onsuccess = function () { resolve(); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function getTrackById(id) {
    const db = await getDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('tracks', 'readonly');
      const store = tx.objectStore('tracks');
      const request = store.get(id);

      request.onsuccess = function () {
        resolve(request.result ? deserializeTrack(request.result) : null);
      };
      request.onerror = function () { reject(request.error); };
    });
  }

  // ─── Settings Store Operations ───────────────────────────────────────────────

  async function saveSetting(key, value) {
    const db = await getDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const request = store.put({ key: key, value: value });

      request.onsuccess = function () { resolve(); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function getSetting(key, defaultValue) {
    const db = await getDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const request = store.get(key);

      request.onsuccess = function () {
        const val = request.result !== undefined ? request.result.value : defaultValue;
        resolve(val);
      };
      request.onerror = function () {
        resolve(defaultValue);
      };
    });
  }

  async function getAllSettings() {
    const db = await getDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const request = store.getAll();

      request.onsuccess = function () {
        const result = {};
        const records = request.result || [];
        for (let i = 0; i < records.length; i++) {
          result[records[i].key] = records[i].value;
        }
        resolve(result);
      };
      request.onerror = function () { reject(request.error); };
    });
  }

  return {
    initDB: initDB,
    getAllTracks: getAllTracks,
    addTrack: addTrack,
    deleteTrack: deleteTrack,
    clearTracks: clearTracks,
    getTrackById: getTrackById,
    saveSetting: saveSetting,
    getSetting: getSetting,
    getAllSettings: getAllSettings
  };
});
