/**
 * audiohide.js — AudioHide core logic
 *
 * Sections (Ctrl+F the ── label to jump):
 *   VERSION & CONSTANTS
 *   POLYFILLS
 *   STORAGE HELPER
 *   STATE
 *   DEVICE DETECTION
 *   AUDIO CONTEXT COMPAT
 *   HELPERS
 *   UI HELPERS
 *   FILE / IMAGE COMPAT
 *   SETTINGS ACCESSORS
 *   SETTINGS UI HANDLERS
 *   THEME
 *   TABS
 *   SCATTER PRNG
 *   DROP ZONES
 *   CAPACITY MATH
 *   AUDIO PROCESSING
 *   HEADER + PAYLOAD
 *   LSB ENCODE / DECODE  (Worker + fallback)
 *   SNIFF AHID MAGIC
 *   DECODE PANEL LOADER
 *   CAPACITY ANALYSIS
 *   ENCODE
 *   DECODE
 *   DOWNLOAD
 *   RESIZE CONTROLS
 *   WIRE UP
 *   STARTUP
 *
 * Browser support: Chrome 49+, Firefox 52+, Safari 11+,
 *                  iOS Safari 11+, Android Chrome 67+
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
// VERSION & CONSTANTS
// ═══════════════════════════════════════════════════════════════

var VERSION = '1.1.0';

/** Magic bytes at the start of every AudioHide payload. */
var MAGIC = [0x41, 0x48, 0x49, 0x44]; // "AHID"

/**
 * Header layout (20 bytes total):
 *   0– 3  "AHID" magic
 *   4– 7  audio data length    (uint32 big-endian)
 *   8–11  speed × 1000         (uint32 big-endian)  e.g. 1500 = 1.5x
 *  12–15  original duration ms (uint32 big-endian)
 *     16  bits per channel     (uint8)  1 or 2; 0 = legacy = 1
 *     17  audio channels       (uint8)  1 = mono, 2 = stereo; 0 = legacy = mono
 *  18–19  reserved
 */
var HEADER_BYTES = 20;

/** Candidate speeds tried in order during auto-fit. */
var SPEEDS = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0];

/** Channels per scatter segment (Fisher-Yates shuffle granularity). */
var SCATTER_SEG = 1024;

// ═══════════════════════════════════════════════════════════════
// POLYFILLS  (IE11 / old Android / old iOS)
// ═══════════════════════════════════════════════════════════════

if (!Math.imul) {
  Math.imul = function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bh + ah * bl) << 16) + (al * bl) | 0;
  };
}

if (!Math.log2) {
  Math.log2 = function (x) { return Math.log(x) / Math.LN2; };
}

if (!String.prototype.padStart) {
  String.prototype.padStart = function (n, c) {
    var s = String(this);
    c = (c === undefined) ? ' ' : String(c);
    while (s.length < n) s = c + s;
    return s;
  };
}

// ═══════════════════════════════════════════════════════════════
// STORAGE HELPER
// Wraps localStorage with try/catch (private browsing can throw).
// ═══════════════════════════════════════════════════════════════

var Store = {
  get: function (key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v !== null ? v : fallback;
    } catch (e) {
      return fallback;
    }
  },
  set: function (key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
};

// ═══════════════════════════════════════════════════════════════
// STATE  (all mutable globals in one place)
// ═══════════════════════════════════════════════════════════════

var gImgFile       = null;   // carrier image File object
var gAudFile       = null;   // audio File object to embed
var gDecFile       = null;   // encoded image to decode
var gExtracted     = null;   // Blob of extracted WAV (for download)
var gSpeed         = null;   // chosen encode speed (set by analyseCapacity)
var gAudDurSec     = null;   // duration of loaded audio in seconds
var gLastBlobSize  = 0;      // actual size of last output PNG (bytes)
var gOrigW         = null;   // original image width  (pre-resize)
var gOrigH         = null;   // original image height (pre-resize)
var gAspectLock    = true;   // whether W/H resize inputs stay locked
var gCancelEnc     = false;  // set true to abort an in-progress encode
var gCancelDec     = false;  // set true to abort an in-progress decode

// ═══════════════════════════════════════════════════════════════
// DEVICE DETECTION
// ═══════════════════════════════════════════════════════════════

var IS_IOS    = /iP(hone|ad|od)/i.test(navigator.userAgent);
var IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent);

/**
 * Workers need to be served over http(s) — file:// breaks Chrome.
 * Test at startup; fall back to main-thread chunked loops if needed.
 */
var USE_WORKER = (function () {
  if (typeof Worker === 'undefined') return false;
  // file:// protocol blocks Workers in Chrome
  if (window.location.protocol === 'file:') return false;
  return true;
}());

// ═══════════════════════════════════════════════════════════════
// AUDIO CONTEXT COMPAT  (webkit prefix for old iOS/Safari)
// ═══════════════════════════════════════════════════════════════

var AudioCtx        = window.AudioContext        || window.webkitAudioContext;
var OfflineAudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/** Shorthand for document.getElementById. */
function $(id) { return document.getElementById(id); }

/** Format bytes as human-readable string. */
function fmtB(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

/** Format milliseconds as M:SS. */
function fmtT(ms) {
  var s = Math.round(ms / 1000), m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

/** Format a remaining-time estimate as "8s" or "2m 15s". */
function fmtEta(ms) {
  var s = Math.round(ms / 1000);
  if (s < 2)  return 'almost done';
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════

/** Show a status bar with a given class (ok / err / info / warn). */
function st(id, cls, msg) {
  var el = $(id);
  el.className    = 'status ' + cls;
  el.textContent  = msg;
  el.style.display = 'block';
}

/** Hide a status bar. */
function stHide(id) { $(id).style.display = 'none'; }

/** Update a progress bar set (fill width, label, percentage text). */
function prog(fillId, lblId, pctId, pct, label) {
  $(fillId).style.width = Math.min(pct, 100) + '%';
  $(lblId).textContent  = label;
  $(pctId).textContent  = Math.round(pct) + '%';
}

/** Show or hide the cancel button for a given operation. */
function setCancelVisible(btnId, visible) {
  var el = $(btnId);
  if (el) el.style.display = visible ? 'inline-block' : 'none';
}

// ═══════════════════════════════════════════════════════════════
// FILE / IMAGE COMPAT
// ═══════════════════════════════════════════════════════════════

/**
 * Read a File as ArrayBuffer.
 * File.arrayBuffer() is not available in Safari < 14.1 — use FileReader fallback.
 */
function fileToArrayBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload  = function () { resolve(fr.result); };
    fr.onerror = function () { reject(fr.error || new Error('FileReader error')); };
    fr.readAsArrayBuffer(file);
  });
}

/**
 * Load a File or Blob as a drawable image.
 * createImageBitmap() is not in Safari < 15 — fall back to <img>.
 */
function loadImageBitmap(source) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(source);
  }
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var url = URL.createObjectURL(source);
    img.onload  = function () { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Image failed to load')); };
    img.src = url;
  });
}

/**
 * Decode audio data — wraps the callback form of decodeAudioData so it
 * returns a Promise on all browsers (old Safari only has the callback form).
 */
function decodeAudio(ac, buffer) {
  return new Promise(function (resolve, reject) {
    ac.decodeAudioData(buffer, resolve, reject);
  });
}

/** Safely close an AudioContext — throws on some old browsers. */
function safeClose(ac) {
  try { if (ac && ac.close) ac.close(); } catch (e) {}
}

/**
 * Trigger a file download.
 * iOS Safari < 13 ignores a.download on blob URLs — show a fallback tap-link.
 */
function triggerDownload(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  if (IS_IOS) {
    var note = $('iosNote');
    if (note) {
      note.style.display = 'block';
      note.innerHTML =
        '<b>iPhone/iPad:</b> If the file did not save, ' +
        '<a href="' + url + '" target="_blank">tap here to open it</a> ' +
        'then use the share icon → <b>Save to Files</b>.';
    }
  }

  // Revoke after a delay so the iOS tap-link above still works
  setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS ACCESSORS
// ═══════════════════════════════════════════════════════════════

function getOutSR() {
  var el = $('sampleRate');
  return el ? (parseInt(el.value, 10) || 22050) : 22050;
}

function getManualSpeed() {
  var sm = $('speedMode');
  if (sm && sm.value === 'manual') return parseInt($('manualSpeed').value, 10) / 100;
  return null;
}

function getLsbDepth() {
  var el = $('lsbDepth');
  return el ? (parseInt(el.value, 10) || 1) : 1;
}

/** Returns 2 if stereo mode is enabled, otherwise 1. */
function getChannels() {
  var el = $('stereoAudio');
  return (el && el.checked) ? 2 : 1;
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS UI HANDLERS
// ═══════════════════════════════════════════════════════════════

function toggleSettings() {
  $('settingsPanel').classList.toggle('open');
}

function onSettingChange() {
  $('compressQualityRow').style.display = $('compressEnabled').checked ? 'block' : 'none';
  analyseCapacity();
}

function onSpeedModeChange() {
  var manual = $('speedMode').value === 'manual';
  $('manualSpeedRow').style.display = manual ? 'block' : 'none';
  if (manual) updateSemitoneNote();
  analyseCapacity();
}

function onManualSpeedSlide() {
  var v = parseInt($('manualSpeed').value, 10) / 100;
  $('manualSpeedVal').textContent = v.toFixed(2);
  updateSemitoneNote();
  analyseCapacity();
}

function updateSemitoneNote() {
  var v         = parseInt($('manualSpeed').value, 10) / 100;
  var semitones = (12 * Math.log2(v)).toFixed(1);
  var sign      = semitones >= 0 ? '+' : '';
  $('manualSemitones').textContent = (v === 1)
    ? 'No pitch change at 1.0x'
    : 'Pitch shift: ' + sign + semitones + ' semitones';
}

function onPasskeyToggle() {
  var on = $('passkeyEnabled').checked;
  $('passkeyRow').style.display    = on ? 'block' : 'none';
  $('decPasskeyRow').style.display = on ? 'block' : 'none';
}

// ═══════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════

function getCurrentTheme() {
  return Store.get('theme-preference', 'system');
}

function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  Store.set('theme-preference', theme);
  updateThemeButton();
}

function updateThemeButton() {
  var btn = $('themeBtn');
  if (!btn) return;
  var theme = getCurrentTheme();
  var labels = { light: 'Light ☀', dark: 'Dark ☾', system: 'System' };
  var tips   = {
    light:  'Light mode active — click for Dark',
    dark:   'Dark mode active — click for System',
    system: 'Following system — click for Light'
  };
  btn.textContent = labels[theme] || 'Theme';
  btn.title       = tips[theme]   || '';
}

/** Cycle: light → dark → system → light … */
function cycleTheme() {
  var next = { light: 'dark', dark: 'system', system: 'light' };
  applyTheme(next[getCurrentTheme()] || 'light');
}

// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════

function switchTab(t) {
  ['enc', 'dec'].forEach(function (x) {
    $('tab-'   + x).classList.toggle('active', x === t);
    $('panel-' + x).classList.toggle('active', x === t);
  });
}

// ═══════════════════════════════════════════════════════════════
// SCATTER PRNG
// FNV-1a hash → Mulberry32 seed → Fisher-Yates segment shuffle
// ═══════════════════════════════════════════════════════════════

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashKey(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

/**
 * Build a scatter map for a given passkey.
 * Returns fn(channelIndex) → shuffledChannelIndex.
 */
function buildScatterMap(key, availChannels) {
  var segCount = Math.ceil(availChannels / SCATTER_SEG);
  var order    = new Uint32Array(segCount);
  for (var s = 0; s < segCount; s++) order[s] = s;

  var rand = mulberry32(hashKey(key));
  for (var i = segCount - 1; i > 0; i--) {
    var j   = Math.floor(rand() * (i + 1));
    var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }

  return function (chIdx) {
    var seg = (chIdx / SCATTER_SEG) | 0;
    var off = chIdx % SCATTER_SEG;
    var ch  = order[seg] * SCATTER_SEG + off;
    return ch < availChannels ? ch : chIdx;
  };
}

/** Returns the encode scatter map, or null if passkey is not enabled. */
function getScatterKey() {
  if (!$('passkeyEnabled') || !$('passkeyEnabled').checked) return null;
  return $('passkeyInput').value.trim() || null;
}

// ═══════════════════════════════════════════════════════════════
// DROP ZONES
// ═══════════════════════════════════════════════════════════════

function setupDrop(dropId, inputId, cb) {
  var el = $(dropId);
  el.addEventListener('dragover',  function (e) { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', function ()  { el.classList.remove('over'); });
  el.addEventListener('drop', function (e) {
    e.preventDefault(); el.classList.remove('over');
    var f = e.dataTransfer.files[0];
    if (f) cb(f);
  });
  $(inputId).addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (f) cb(f);
    e.target.value = ''; // allow re-selecting the same file
  });
}

// ═══════════════════════════════════════════════════════════════
// CAPACITY MATH
// ═══════════════════════════════════════════════════════════════

/**
 * Maximum bytes that can be stored in a W×H image.
 * bpc  = bits per channel (1 or 2)
 */
function pixelCap(w, h, bpc) {
  bpc = (bpc !== undefined) ? bpc : getLsbDepth();
  return Math.floor(w * h * 3 * bpc / 8) - HEADER_BYTES;
}

/**
 * Estimated WAV byte size for a given duration, speed, sample-rate, and channels.
 * Used to check if audio will fit before encoding.
 */
function wavEst(durSec, speed, sr, channels) {
  var rate = sr       || getOutSR();
  var ch   = channels || getChannels();
  return Math.ceil((durSec / speed) * rate) * ch * 2 + 44;
}

/** Pick the slowest speed from SPEEDS[] that fits within capacity. */
function pickSpeed(durSec, cap) {
  for (var i = 0; i < SPEEDS.length; i++) {
    if (wavEst(durSec, SPEEDS[i]) <= cap) return SPEEDS[i];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// AUDIO PROCESSING
// ═══════════════════════════════════════════════════════════════

/** Decode audio and return its duration in seconds. */
function getAudioDuration(arrayBuffer) {
  var ac = new AudioCtx();
  return decodeAudio(ac, arrayBuffer.slice(0))
    .then(function (decoded) {
      var dur = decoded.duration;
      safeClose(ac);
      return dur;
    })
    ['catch'](function (e) {
      safeClose(ac);
      throw e;
    });
}

/**
 * Decode, resample, optionally speed-up, and optionally normalise audio.
 * Returns { wav: Uint8Array, origDurMs: number }.
 */
function processAudio(arrayBuffer, speed) {
  var SR       = getOutSR();
  var numCh    = getChannels();
  var ac       = new AudioCtx();
  var origDurMs;

  return decodeAudio(ac, arrayBuffer.slice(0))
    .then(function (decoded) {
      origDurMs  = Math.round(decoded.duration * 1000);
      var newLen = Math.ceil((decoded.duration / speed) * SR);

      var off = new OfflineAudioCtx(numCh, newLen, SR);
      var src = off.createBufferSource();
      src.buffer             = decoded;
      src.playbackRate.value = speed;
      src.connect(off.destination);
      src.start(0);
      safeClose(ac);
      return off.startRendering();
    })
    .then(function (rendered) {
      // Optional normalisation — boost quiet audio to ~98% of peak
      var normalEl = $('normalizeAudio');
      if (normalEl && normalEl.checked) {
        for (var c = 0; c < rendered.numberOfChannels; c++) {
          var ch   = rendered.getChannelData(c);
          var peak = 0;
          for (var i = 0; i < ch.length; i++) {
            var a = Math.abs(ch[i]);
            if (a > peak) peak = a;
          }
          if (peak > 0.001 && peak < 0.97) {
            var gain = 0.98 / peak;
            for (var j = 0; j < ch.length; j++) ch[j] *= gain;
          }
        }
      }
      return { wav: bufToWav(rendered), origDurMs: origDurMs };
    });
}

/**
 * Reverse the speed-up applied during encoding to restore original pitch.
 * Returns a new WAV Uint8Array, or the original on error.
 */
function pitchCorrect(wavBytes, speed) {
  var ac  = new AudioCtx();
  var buf = wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength);

  return decodeAudio(ac, buf)
    .then(function (decoded) {
      var origSamples = Math.ceil(decoded.duration * speed * decoded.sampleRate);
      var off = new OfflineAudioCtx(decoded.numberOfChannels, origSamples, decoded.sampleRate);
      var src = off.createBufferSource();
      src.buffer             = decoded;
      src.playbackRate.value = 1 / speed;
      src.connect(off.destination);
      src.start(0);
      safeClose(ac);
      return off.startRendering();
    })
    .then(function (rendered) { return bufToWav(rendered); })
    ['catch'](function ()     { safeClose(ac); return wavBytes; });
}

/**
 * Convert an AudioBuffer to a PCM WAV Uint8Array.
 * Supports mono and stereo (interleaved L, R, L, R …).
 */
function bufToWav(buf) {
  var numCh    = buf.numberOfChannels;
  var sr       = buf.sampleRate;
  var ns       = buf.length;
  var dataSize = ns * numCh * 2;
  var out      = new ArrayBuffer(44 + dataSize);
  var v        = new DataView(out);

  var ws = function (o, s) {
    for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };

  // WAV RIFF header
  ws(0,  'RIFF'); v.setUint32(4,  36 + dataSize,      true);
  ws(8,  'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16,                  true);
  v.setUint16(20, 1,             true); // PCM format
  v.setUint16(22, numCh,         true); // channel count
  v.setUint32(24, sr,            true); // sample rate
  v.setUint32(28, sr * numCh * 2, true); // byte rate
  v.setUint16(32, numCh * 2,     true); // block align
  v.setUint16(34, 16,            true); // bits per sample
  ws(36, 'data'); v.setUint32(40, dataSize, true);

  // Gather channel data pointers
  var channels = [];
  for (var c = 0; c < numCh; c++) channels.push(buf.getChannelData(c));

  // Interleave samples: [L0, R0, L1, R1, …]
  var offset = 44;
  for (var i = 0; i < ns; i++) {
    for (var ch = 0; ch < numCh; ch++) {
      var x = Math.max(-1, Math.min(1, channels[ch][i]));
      v.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Uint8Array(out);
}

// ═══════════════════════════════════════════════════════════════
// HEADER + PAYLOAD
// ═══════════════════════════════════════════════════════════════

/**
 * Prepend the 20-byte AHID header to the WAV data.
 * bpc      — bits per channel (1 or 2)
 * channels — audio channels (1=mono, 2=stereo)
 */
function buildPayload(wav, speedX1000, origDurMs, bpc, channels) {
  var p  = new Uint8Array(HEADER_BYTES + wav.length);
  var dv = new DataView(p.buffer);
  MAGIC.forEach(function (b, i) { dv.setUint8(i, b); });
  dv.setUint32(4,  wav.length, false);
  dv.setUint32(8,  speedX1000, false);
  dv.setUint32(12, origDurMs,  false);
  dv.setUint8(16,  bpc      || 1);
  dv.setUint8(17,  channels || 1);
  p.set(wav, HEADER_BYTES);
  return p;
}

// ═══════════════════════════════════════════════════════════════
// LSB ENCODE / DECODE  —  Worker path + main-thread fallback
//
// Why both?  Web Workers can't run over file:// in Chrome, and not
// all old browsers support them.  USE_WORKER is checked at startup.
// ═══════════════════════════════════════════════════════════════

/**
 * Embed payload bits into imageData using a Web Worker.
 *
 * We do NOT transfer data.buffer — the main thread keeps ownership so we
 * can write the result back into the original Uint8ClampedArray when done.
 * (Transferring would detach data, making it impossible to copy back.)
 * payload IS transferred (we don't need it again after postMessage).
 */
function lsbEmbedWorker(data, payload, onProg, scatterKey, bpc, totalChannels) {
  return new Promise(function (resolve, reject) {
    var worker = new Worker('lsb-worker.js');

    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'progress') {
        onProg(msg.value, Date.now());

      } else if (msg.type === 'done') {
        // Worker returns the modified pixels as an ArrayBuffer.
        // Copy every byte back into the original Uint8ClampedArray so
        // putImageData() will pick up the changes.
        var result = new Uint8ClampedArray(msg.data);
        for (var i = 0; i < result.length; i++) data[i] = result[i];
        worker.terminate();
        resolve();

      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    // worker.onerror fires when the worker script itself fails to load or throws
    // uncaught. The argument is an ErrorEvent — read .message, not String(err).
    worker.onerror = function (ev) {
      worker.terminate();
      var msg = ev.message || ('Worker error at ' + ev.filename + ':' + ev.lineno);
      reject(new Error(msg));
    };

    // Clone data (no transfer) so the original stays usable on the main thread.
    // Transfer payload — we don't need it again.
    worker.postMessage({
      type:          'embed',
      data:          data.buffer.slice(0), // slice = clone, original stays intact
      payload:       payload.buffer,
      bpc:           bpc,
      scatterKey:    scatterKey,
      totalChannels: totalChannels
    }, [payload.buffer]);
  });
}

/**
 * Extract numBytes from imageData using a Web Worker.
 */
function lsbExtractWorker(data, numBytes, startBit, onProg, scatterKey, bpc, totalChannels) {
  return new Promise(function (resolve, reject) {
    var worker = new Worker('lsb-worker.js');

    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'progress') {
        onProg(msg.value);
      } else if (msg.type === 'done') {
        // Worker transfers result as ArrayBuffer — wrap in Uint8Array to use it
        worker.terminate();
        resolve(new Uint8Array(msg.result));
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = function (ev) {
      worker.terminate();
      var msg = ev.message || ('Worker error at ' + ev.filename + ':' + ev.lineno);
      reject(new Error(msg));
    };

    // Clone data (no transfer) — we may need it again if decode fails
    worker.postMessage({
      type:          'extract',
      data:          data.buffer.slice(0),
      numBytes:      numBytes,
      startBit:      startBit,
      bpc:           bpc,
      scatterKey:    scatterKey,
      totalChannels: totalChannels
    });
  });
}

/**
 * Fallback: embed on the main thread using setTimeout chunking
 * to keep the UI responsive.  Used when Workers are unavailable.
 * cancelFlag — reference to gCancelEnc or gCancelDec.
 */
function lsbEmbedMainThread(data, payload, onProg, scatter, bpc, cancelRef) {
  bpc = bpc || 1;
  return new Promise(function (resolve, reject) {
    var totalBits = payload.length * 8;
    var CHUNK     = 400000;
    var bit       = 0;
    var startMs   = Date.now();

    function step() {
      if (cancelRef && cancelRef.val) {
        cancelRef.val = false;
        reject(new Error('Cancelled'));
        return;
      }

      var end = Math.min(bit + CHUNK, totalBits);
      for (var i = bit; i < end; i++) {
        var b      = (payload[i >> 3] >> (7 - (i & 7))) & 1;
        var chIdx  = Math.floor(i / bpc);
        var bitPos = i % bpc;
        var ch     = scatter ? scatter(chIdx) : chIdx;
        var pixel  = Math.floor(ch / 3);
        var chan   = ch % 3;
        var di     = pixel * 4 + chan;
        var mask   = ~(1 << bitPos) & 0xFF;
        data[di]   = (data[di] & mask) | (b << bitPos);
      }
      bit = end;
      onProg(bit / totalBits, startMs);
      if (bit < totalBits) setTimeout(step, 0);
      else resolve();
    }
    step();
  });
}

/**
 * Fallback: extract on the main thread using setTimeout chunking.
 */
function lsbExtractMainThread(data, numBytes, startBit, onProg, scatter, bpc, cancelRef) {
  bpc = bpc || 1;
  return new Promise(function (resolve, reject) {
    var result    = new Uint8Array(numBytes);
    var totalBits = numBytes * 8;
    var CHUNK     = 400000;
    var bit       = 0;

    function step() {
      if (cancelRef && cancelRef.val) {
        cancelRef.val = false;
        reject(new Error('Cancelled'));
        return;
      }

      var end = Math.min(bit + CHUNK, totalBits);
      for (var i = bit; i < end; i++) {
        var absBit = startBit + i;
        var chIdx  = Math.floor(absBit / bpc);
        var bitPos = absBit % bpc;
        var ch     = scatter ? scatter(chIdx) : chIdx;
        var pixel  = Math.floor(ch / 3);
        var chan   = ch % 3;
        var di     = pixel * 4 + chan;
        var b      = (data[di] >> bitPos) & 1;
        result[i >> 3] |= (b << (7 - (i & 7)));
      }
      bit = end;
      onProg(bit / totalBits);
      if (bit < totalBits) setTimeout(step, 0);
      else resolve(result);
    }
    step();
  });
}

// Convenience wrappers that pick Worker or fallback automatically

var encCancelRef = { val: false };
var decCancelRef = { val: false };

function lsbEmbed(data, payload, onProg, scatterKey, bpc, totalChannels) {
  encCancelRef.val = false;
  if (USE_WORKER) {
    return lsbEmbedWorker(data, payload, onProg, scatterKey, bpc, totalChannels);
  }
  var scatter = scatterKey ? buildScatterMap(scatterKey, totalChannels) : null;
  return lsbEmbedMainThread(data, payload, onProg, scatter, bpc, encCancelRef);
}

function lsbExtract(data, numBytes, startBit, onProg, scatterKey, bpc, totalChannels) {
  decCancelRef.val = false;
  if (USE_WORKER) {
    return lsbExtractWorker(data, numBytes, startBit, onProg, scatterKey, bpc, totalChannels);
  }
  var scatter = scatterKey ? buildScatterMap(scatterKey, totalChannels) : null;
  return lsbExtractMainThread(data, numBytes, startBit, onProg, scatter, bpc, decCancelRef);
}

// Cancel buttons — Worker path terminates the worker (handled there);
// main-thread path checks cancelRef on each chunk.
function cancelEncode() { encCancelRef.val = true; }
function cancelDecode() { decCancelRef.val = true; }

// ═══════════════════════════════════════════════════════════════
// SNIFF AHID MAGIC
// Drop an encoded PNG on the encode zone → auto-switch to Decode tab.
// ═══════════════════════════════════════════════════════════════

/**
 * Returns a Promise<boolean> — true if the file contains an AHID header.
 * Only checks the first 4 bytes using 1-bit non-scattered LSB.
 */
function sniffAHID(file) {
  return loadImageBitmap(file)
    .then(function (bmp) {
      var cv    = document.createElement('canvas');
      cv.width  = bmp.width  || bmp.naturalWidth;
      cv.height = bmp.height || bmp.naturalHeight;
      var ctx   = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var data  = ctx.getImageData(0, 0, cv.width, cv.height).data;
      // Use main-thread extract for the 4-byte sniff (fast, no cancel needed)
      return lsbExtractMainThread(data, 4, 0, function () {}, null, 1, null);
    })
    .then(function (hdr) {
      for (var i = 0; i < 4; i++) {
        if (hdr[i] !== MAGIC[i]) return false;
      }
      return true;
    })
    ['catch'](function () { return false; });
}

// ═══════════════════════════════════════════════════════════════
// DECODE PANEL LOADER
// ═══════════════════════════════════════════════════════════════

function loadDecodeFile(f) {
  gDecFile = f;
  $('decFileLbl').textContent  = f.name + ' — ' + fmtB(f.size);
  var p = $('decPrev');
  p.src = URL.createObjectURL(f);
  p.style.display              = 'block';
  $('decBtn').disabled         = false;
  $('audioWrap').style.display = 'none';
  $('infoCard').style.display  = 'none';
  $('decProg').style.display   = 'none';
  var n = $('iosNote'); if (n) n.style.display = 'none';
  stHide('decStatus');
}

// ═══════════════════════════════════════════════════════════════
// CAPACITY ANALYSIS
// Runs 120 ms after any relevant setting changes (debounced).
// ═══════════════════════════════════════════════════════════════

var _capDebounce = null;

function analyseCapacity() {
  clearTimeout(_capDebounce);
  _capDebounce = setTimeout(_doAnalyse, 120);
}

function _doAnalyse() {
  gSpeed = null; gAudDurSec = null;
  $('encBtn').disabled = true;
  if (!gImgFile || !gOrigW || !gOrigH) return;

  var rW  = Math.max(1, parseInt($('rW').value, 10) || gOrigW);
  var rH  = Math.max(1, parseInt($('rH').value, 10) || gOrigH);
  var bpc = getLsbDepth();
  var cap = Math.floor(rW * rH * 3 * bpc / 8) - HEADER_BYTES;

  $('newCap').textContent     = fmtB(cap);
  $('estOutSize').textContent = 'approx ' + fmtB(Math.round(rW * rH * 3 * 0.82));
  $('capRow').style.display   = 'flex';

  if (!gAudFile) {
    $('capFill').className   = 'cap-fill';
    $('capFill').style.width = '0%';
    $('capVal').textContent  = 'img cap: ' + fmtB(cap);
    $('badge').style.display = 'none';
    return;
  }

  st('encStatus', 'info', 'Analysing audio…');

  fileToArrayBuffer(gAudFile)
    .then(function (ab) { return getAudioDuration(ab); })
    ['catch'](function ()  { return (gAudFile.size * 8) / 128000; }) // rough fallback
    .then(function (dur)   { _renderCapacityBadge(dur, cap, bpc); });
}

/** Update the capacity bar and fit badge after audio duration is known. */
function _renderCapacityBadge(dur, cap, bpc) {
  stHide('encStatus');
  var badge     = $('badge');
  var manualSpd = getManualSpeed();
  var SR        = getOutSR();
  var channels  = getChannels();

  // ── Manual speed ────────────────────────────────────────────
  if (manualSpd !== null) {
    var wavSz     = wavEst(dur, manualSpd, SR, channels);
    var pct       = Math.min(99, wavSz / cap * 100);
    var semitones = (12 * Math.log2(manualSpd)).toFixed(1);
    var sign      = semitones >= 0 ? '+' : '';

    if (wavSz > cap) {
      _showCapOver(cap);
      badge.className = 'badge red'; badge.style.display = 'block';
      badge.innerHTML = '<b>Does not fit at ' + manualSpd.toFixed(2) + 'x.</b><br>'
        + 'Need: ' + fmtB(wavSz) + ' — Capacity: ' + fmtB(cap) + '<br>'
        + 'Increase speed, enlarge image, or use 2-bit mode in Settings.';
      $('encBtn').disabled = true;
      return;
    }

    gSpeed = manualSpd; gAudDurSec = dur;
    _showCapBar(pct, fmtB(wavSz) + ' / ' + fmtB(cap));
    badge.className = 'badge' + (manualSpd <= 1.01 ? ' green' : '');
    badge.style.display = 'block';
    badge.innerHTML = manualSpd <= 1.01
      ? 'Manual speed: 1.0x — no pitch change.'
      : 'Manual speed: <b>' + manualSpd.toFixed(2) + 'x</b> — '
        + 'Pitch: <b>' + sign + semitones + ' sem</b>  '
        + fmtT(dur * 1000) + ' → ' + fmtT(dur / manualSpd * 1000)
        + ' — ' + fmtB(wavSz);
    $('encBtn').disabled = false;
    return;
  }

  // ── Auto speed ──────────────────────────────────────────────
  var speed = pickSpeed(dur, cap);

  if (!speed) {
    var neededPx = Math.ceil((wavEst(dur, 1.0, SR, channels) + HEADER_BYTES) * 8 / (3 * bpc));
    var sugSide  = Math.ceil(Math.sqrt(neededPx));
    _showCapOver(cap);
    badge.className = 'badge red'; badge.style.display = 'block';
    badge.innerHTML = '<b>Will not fit even at ' + SPEEDS[SPEEDS.length - 1] + 'x.</b><br>'
      + 'Capacity: ' + fmtB(cap) + '<br>'
      + '<span class="sug-link" onclick="applySuggestedSize(' + sugSide + ',' + sugSide + ')">'
      + 'Use minimum size: ' + sugSide + 'x' + sugSide + 'px</span>'
      + ' — or lower sample rate / use 2-bit in Settings.';
    $('encBtn').disabled = true;
    return;
  }

  gSpeed = speed; gAudDurSec = dur;
  var wavSz_a    = wavEst(dur, speed, SR, channels);
  var pct_a      = Math.min(99, wavSz_a / cap * 100);
  var semitones_a = (12 * Math.log2(speed)).toFixed(1);
  var sign_a      = semitones_a >= 0 ? '+' : '';

  _showCapBar(pct_a, fmtB(wavSz_a) + ' / ' + fmtB(cap));

  if (speed === 1.0) {
    badge.className = 'badge green'; badge.style.display = 'block';
    badge.innerHTML = 'Fits at 1.0x — no pitch change.';
  } else {
    var neededPx2 = Math.ceil((wavEst(dur, 1.0, SR, channels) + HEADER_BYTES) * 8 / (3 * bpc));
    var sugSide2  = Math.ceil(Math.sqrt(neededPx2));
    badge.className = 'badge'; badge.style.display = 'block';
    badge.innerHTML = 'Auto speed: <b>' + speed + 'x</b> — Pitch: <b>'
      + sign_a + semitones_a + ' sem</b><br>'
      + fmtT(dur * 1000) + ' → ' + fmtT(dur / speed * 1000) + ' — ' + fmtB(wavSz_a) + '<br>'
      + '<span class="sug-link" onclick="applySuggestedSize(' + sugSide2 + ',' + sugSide2 + ')">'
      + 'Resize to ' + sugSide2 + 'x' + sugSide2 + ' for no pitch shift</span>';
  }
  $('encBtn').disabled = false;
}

function _showCapBar(pct, label) {
  $('capFill').style.width = pct + '%';
  $('capFill').className   = 'cap-fill ' + (pct < 65 ? 'ok' : 'warn');
  $('capVal').textContent  = label;
}

function _showCapOver(cap) {
  $('capFill').style.width = '100%';
  $('capFill').className   = 'cap-fill over';
  $('capVal').textContent  = 'too small — ' + fmtB(cap);
}

// ═══════════════════════════════════════════════════════════════
// ENCODE
// ═══════════════════════════════════════════════════════════════

function doEncode() {
  if (!gImgFile || !gAudFile || gSpeed === null) {
    st('encStatus', 'err', 'Missing files or no valid speed. Check image and audio.');
    return;
  }

  var btn = $('encBtn');
  btn.disabled = true;
  stHide('encStatus');
  $('encProg').style.display = 'block';
  setCancelVisible('cancelEncBtn', !USE_WORKER); // cancel only usable in main-thread mode
  var iosNote = $('iosNote'); if (iosNote) iosNote.style.display = 'none';

  var bmp, rW, rH, cv, ctx, imgData, bpc, payload, scatterKey, channels;

  prog('encFill', 'encLbl', 'encPct', 5, 'Loading image…');
  st('encStatus', 'info', 'Loading image…');

  loadImageBitmap(gImgFile)
    .then(function (b) {
      bmp = b;
      rW  = parseInt($('rW').value, 10) || (bmp.width || bmp.naturalWidth);
      rH  = parseInt($('rH').value, 10) || (bmp.height || bmp.naturalHeight);
      cv  = document.createElement('canvas');
      cv.width = rW; cv.height = rH;
      ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0, rW, rH);

      // Optional JPEG pre-compression pass
      if ($('compressEnabled').checked) {
        var quality = Math.max(0.01, Math.min(1.0, (parseInt($('compressQuality').value, 10) || 75) / 100));
        st('encStatus', 'info', 'Pre-compressing at quality ' + Math.round(quality * 100) + '%…');
        prog('encFill', 'encLbl', 'encPct', 8, 'Compressing…');
        return new Promise(function (res, rej) {
          cv.toBlob(function (b) { b ? res(b) : rej(new Error('JPEG failed')); }, 'image/jpeg', quality);
        }).then(function (jpegBlob) {
          return new Promise(function (res, rej) {
            var img = new Image();
            var url = URL.createObjectURL(jpegBlob);
            img.onload  = function () { ctx.clearRect(0, 0, rW, rH); ctx.drawImage(img, 0, 0, rW, rH); URL.revokeObjectURL(url); res(); };
            img.onerror = function () { rej(new Error('Compressed image failed to reload')); };
            img.src = url;
          });
        });
      }
    })
    .then(function () {
      imgData    = ctx.getImageData(0, 0, rW, rH);
      bpc        = getLsbDepth();
      channels   = getChannels();
      scatterKey = getScatterKey();

      st('encStatus', 'info', gSpeed > 1 ? 'Processing audio at ' + gSpeed + 'x…' : 'Processing audio…');
      prog('encFill', 'encLbl', 'encPct', 12, 'Processing audio…');

      return fileToArrayBuffer(gAudFile);
    })
    .then(function (ab) { return processAudio(ab, gSpeed); })
    .then(function (r) {
      prog('encFill', 'encLbl', 'encPct', 30, 'Building payload…');
      payload = buildPayload(r.wav, Math.round(gSpeed * 1000), r.origDurMs, bpc, channels);

      var totalCap = Math.floor(rW * rH * 3 * bpc / 8);
      if (payload.length > totalCap) {
        throw new Error('Payload (' + fmtB(payload.length) + ') exceeds capacity (' + fmtB(totalCap) + ').');
      }

      var totalChannels = rW * rH * 3;
      st('encStatus', 'info', scatterKey
        ? 'Scatter-encoding (passkey active)…'
        : 'Encoding into pixels (' + bpc + '-bit, ' + (channels === 2 ? 'stereo' : 'mono') + ')…');

      var encStart = Date.now();
      return lsbEmbed(imgData.data, payload, function (p) {
        var pct = 30 + p * 62;
        var eta = '';
        if (p > 0.03 && p < 0.97) {
          var elapsed = Date.now() - encStart;
          eta = ' (~' + fmtEta((elapsed / p) * (1 - p)) + ')';
        }
        prog('encFill', 'encLbl', 'encPct', pct, 'Encoding ' + Math.round(pct) + '%' + eta);
      }, scatterKey, bpc, totalChannels);
    })
    .then(function () {
      prog('encFill', 'encLbl', 'encPct', 93, 'Saving PNG…');
      ctx.putImageData(imgData, 0, 0);
      return new Promise(function (resolve, reject) {
        cv.toBlob(function (blob) {
          if (!blob) { reject(new Error('toBlob returned null — canvas may be tainted.')); return; }
          gLastBlobSize = blob.size;
          triggerDownload(blob, 'audiohide_' + gImgFile.name.replace(/\.[^.]+$/, '') + '.png');
          resolve();
        }, 'image/png');
      });
    })
    .then(function () {
      prog('encFill', 'encLbl', 'encPct', 100, 'Done!');
      setCancelVisible('cancelEncBtn', false);
      var note = ' Speed: ' + (gSpeed > 1 ? gSpeed + 'x.' : '1.0x (no pitch change).')
        + ' Output: ' + fmtB(gLastBlobSize) + '.'
        + ' Mode: ' + bpc + '-bit, ' + (channels === 2 ? 'stereo' : 'mono') + '.'
        + (scatterKey ? ' Passkey: ON.' : '');
      st('encStatus', 'ok', 'Done. Image downloaded.' + note);
      btn.disabled = false;
    })
    ['catch'](function (e) {
      setCancelVisible('cancelEncBtn', false);
      if (e && e.message === 'Cancelled') {
        st('encStatus', 'warn', 'Encode cancelled.');
        prog('encFill', 'encLbl', 'encPct', 0, '');
      } else {
        st('encStatus', 'err', 'Error: ' + (e && e.message ? e.message : String(e)));
      }
      btn.disabled = false;
    });
}

// ═══════════════════════════════════════════════════════════════
// DECODE
// ═══════════════════════════════════════════════════════════════

function doDecode() {
  if (!gDecFile) return;

  var btn = $('decBtn');
  btn.disabled = true;
  stHide('decStatus');
  $('audioWrap').style.display = 'none';
  $('infoCard').style.display  = 'none';
  $('decProg').style.display   = 'block';
  setCancelVisible('cancelDecBtn', !USE_WORKER);

  var speed, bpc, channels, scatterKey;

  st('decStatus', 'info', 'Loading image…');

  loadImageBitmap(gDecFile)
    .then(function (bmp) {
      var cv    = document.createElement('canvas');
      cv.width  = bmp.width  || bmp.naturalWidth;
      cv.height = bmp.height || bmp.naturalHeight;
      var ctx   = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var data  = ctx.getImageData(0, 0, cv.width, cv.height).data;

      var decKey      = $('decPasskey') ? $('decPasskey').value.trim() : '';
      var totalCh     = cv.width * cv.height * 3;
      scatterKey      = decKey || null;

      prog('decFill', 'decLbl', 'decPct', 5, 'Reading header…');

      // Header is always 1-bit, no scatter — read it first to get bpc
      return lsbExtractMainThread(data, HEADER_BYTES, 0, function () {}, null, 1, null)
        .then(function (hdrBytes) {
          var hv = new DataView(hdrBytes.buffer);

          // Validate magic bytes
          for (var i = 0; i < 4; i++) {
            if (hdrBytes[i] !== MAGIC[i]) throw new Error('NOAHID');
          }

          var dataLen   = hv.getUint32(4,  false);
          var speedX1k  = hv.getUint32(8,  false);
          var origDurMs = hv.getUint32(12, false);
          bpc      = hv.getUint8(16) || 1;
          channels = hv.getUint8(17) || 1;
          speed    = speedX1k / 1000;
          var encDurMs  = Math.round(origDurMs / speed);

          if (dataLen === 0 || dataLen > 400 * 1024 * 1024) throw new Error('BADHDR');

          st('decStatus', 'info', 'Extracting ' + fmtB(dataLen) + '…');
          prog('decFill', 'decLbl', 'decPct', 10, 'Extracting bits…');

          var decStart = Date.now();
          return lsbExtract(data, dataLen, HEADER_BYTES * 8, function (p) {
            var pct = 10 + p * 75;
            var eta = '';
            if (p > 0.03 && p < 0.97) {
              var elapsed = Date.now() - decStart;
              eta = ' (~' + fmtEta((elapsed / p) * (1 - p)) + ')';
            }
            prog('decFill', 'decLbl', 'decPct', pct, 'Extracting ' + Math.round(pct) + '%' + eta);
          }, scatterKey, bpc, totalCh)
            .then(function (audioBytes) {
              return { audioBytes: audioBytes, dataLen: dataLen, origDurMs: origDurMs, encDurMs: encDurMs };
            });
        });
    })
    .then(function (r) {
      // Populate info card
      $('iSize').textContent    = fmtB(r.dataLen);
      $('iSpeed').textContent   = speed.toFixed(2) + 'x';
      $('iOrig').textContent    = fmtT(r.origDurMs);
      $('iEnc').textContent     = fmtT(r.encDurMs);
      $('iBpc').textContent     = bpc + '-bit ' + (channels === 2 ? 'stereo' : 'mono');
      $('infoCard').style.display = 'block';

      var note = $('iNote');
      if (speed <= 1.01) {
        note.innerHTML = '<b>No speed adjustment</b> — plays at original speed and pitch.';
      } else {
        var semi = (12 * Math.log2(speed)).toFixed(1);
        note.innerHTML = '<b>Encoded at ' + speed.toFixed(2) + 'x (' + (semi > 0 ? '+' : '') + semi + ' sem).</b><br>'
          + 'Stored: ' + fmtT(r.encDurMs) + ' — Original: ' + fmtT(r.origDurMs) + '.';
      }

      // Optional pitch correction
      var doPitch = $('pitchCorrect') && $('pitchCorrect').checked && speed > 1.01;
      if (doPitch) {
        prog('decFill', 'decLbl', 'decPct', 88, 'Pitch correcting…');
        st('decStatus', 'info', 'Restoring original pitch…');
        return pitchCorrect(r.audioBytes, speed).then(function (fixed) {
          $('iNote').innerHTML += '<br><b>Pitch correction applied</b> — audio restored to original.';
          return { bytes: fixed, dataLen: r.dataLen, pitched: true };
        });
      }
      return { bytes: r.audioBytes, dataLen: r.dataLen, pitched: false };
    })
    .then(function (r) {
      gExtracted = new Blob([r.bytes], { type: 'audio/wav' });
      $('audioOut').src = URL.createObjectURL(gExtracted);
      $('audioWrap').style.display = 'block';
      setCancelVisible('cancelDecBtn', false);
      prog('decFill', 'decLbl', 'decPct', 100, 'Done!');
      st('decStatus', 'ok', 'Extracted ' + fmtB(r.dataLen) + '.'
        + (r.pitched ? ' Pitch corrected.' : ' Press play to listen.'));
      btn.disabled = false;
    })
    ['catch'](function (e) {
      setCancelVisible('cancelDecBtn', false);
      if (e && e.message === 'NOAHID') {
        st('decStatus', 'err', 'No AudioHide data found. Not an AudioHide image, re-saved as JPEG, or wrong passkey.');
      } else if (e && e.message === 'BADHDR') {
        st('decStatus', 'err', 'Header invalid — image may have been edited after encoding.');
      } else if (e && e.message === 'Cancelled') {
        st('decStatus', 'warn', 'Decode cancelled.');
        prog('decFill', 'decLbl', 'decPct', 0, '');
      } else {
        st('decStatus', 'err', 'Error: ' + (e && e.message ? e.message : String(e)));
      }
      btn.disabled = false;
    });
}

// ═══════════════════════════════════════════════════════════════
// DOWNLOAD
// ═══════════════════════════════════════════════════════════════

function dlAudio() {
  if (!gExtracted) return;
  triggerDownload(gExtracted, 'audiohide_extracted.wav');
}

// ═══════════════════════════════════════════════════════════════
// RESIZE CONTROLS
// ═══════════════════════════════════════════════════════════════

function toggleLock() {
  gAspectLock = !gAspectLock;
  var btn = $('lockBtn');
  btn.textContent = gAspectLock ? 'Lock: ON' : 'Lock: OFF';
  btn.classList.toggle('locked', gAspectLock);
}

function updateResizeHint() {
  var w = parseInt($('rW').value, 10) || gOrigW;
  var h = parseInt($('rH').value, 10) || gOrigH;
  if (!w || !h) return;
  $('newCap').textContent     = fmtB(pixelCap(w, h));
  $('estOutSize').textContent = 'approx ' + fmtB(Math.round(w * h * 3 * 0.82));
  if (gOrigW) $('rScale').value = Math.round(w / gOrigW * 100);
}

function applyScale(pct) {
  if (!gOrigW || !gOrigH) return;
  $('rScale').value = pct;
  $('rW').value = Math.max(1, Math.round(gOrigW * pct / 100));
  $('rH').value = Math.max(1, Math.round(gOrigH * pct / 100));
  updateResizeHint(); analyseCapacity();
}

function onResizeScale() {
  var pct = parseFloat($('rScale').value);
  if (!pct || !gOrigW || !gOrigH) return;
  $('rW').value = Math.max(1, Math.round(gOrigW * pct / 100));
  $('rH').value = Math.max(1, Math.round(gOrigH * pct / 100));
  updateResizeHint(); analyseCapacity();
}

function onResizeW() {
  var w = parseInt($('rW').value, 10);
  if (!w || !gOrigW || !gOrigH) return;
  if (gAspectLock) $('rH').value = Math.max(1, Math.round(w * gOrigH / gOrigW));
  updateResizeHint(); analyseCapacity();
}

function onResizeH() {
  var h = parseInt($('rH').value, 10);
  if (!h || !gOrigW || !gOrigH) return;
  if (gAspectLock) $('rW').value = Math.max(1, Math.round(h * gOrigW / gOrigH));
  updateResizeHint(); analyseCapacity();
}

function resetResize() {
  if (!gOrigW || !gOrigH) return;
  $('rW').value = gOrigW; $('rH').value = gOrigH; $('rScale').value = 100;
  updateResizeHint(); analyseCapacity();
}

function applySuggestedSize(w, h) {
  $('rW').value = w; $('rH').value = h;
  $('rScale').value = gOrigW ? Math.round(w / gOrigW * 100) : 100;
  $('newCap').textContent     = fmtB(pixelCap(w, h));
  $('estOutSize').textContent = 'approx ' + fmtB(Math.round(w * h * 3 * 0.82));
  analyseCapacity();
}

// ═══════════════════════════════════════════════════════════════
// WIRE UP DROP ZONES
// ═══════════════════════════════════════════════════════════════

setupDrop('imgDrop', 'imgInput', function (f) {
  // Reject non-PNG/BMP immediately before doing anything else
  var ok = (f.type === 'image/png' || f.type === 'image/bmp' ||
            /\.(png|bmp)$/i.test(f.name));
  if (!ok) {
    st('encStatus', 'err',
      'Only PNG or BMP files can be used as the carrier image. ' +
      'JPEG compression destroys hidden data — please choose a .png or .bmp file.');
    return;
  }

  // Auto-route: if the PNG already contains AudioHide data, switch to Decode
  sniffAHID(f).then(function (isEncoded) {
    if (isEncoded) {
      switchTab('dec');
      loadDecodeFile(f);
      st('decStatus', 'info', 'AudioHide image detected — tap "Extract Audio" to decode.');
      return;
    }

    // Otherwise treat it as a carrier for encoding
    gImgFile = f;
    $('imgFileLbl').textContent  = f.name + ' — ' + fmtB(f.size);
    var p = $('imgPrev');
    var prevUrl = p.src;
    p.src = URL.createObjectURL(f);
    if (prevUrl) URL.revokeObjectURL(prevUrl);
    p.style.display = 'block';
    $('encBtn').disabled     = true;
    $('badge').style.display = 'none';
    gSpeed = null;

    var img = new Image();
    img.onload = function () {
      gOrigW = img.width; gOrigH = img.height;
      $('rW').value               = gOrigW;
      $('rH').value               = gOrigH;
      $('rScale').value           = 100;
      $('origDims').textContent   = gOrigW + ' × ' + gOrigH + ' px';
      $('newCap').textContent     = fmtB(pixelCap(gOrigW, gOrigH));
      $('estOutSize').textContent = 'approx ' + fmtB(Math.round(gOrigW * gOrigH * 3 * 0.82));
      $('resizeWrap').style.display = 'block';
      analyseCapacity();
    };
    img.src = URL.createObjectURL(f);
  });
});

setupDrop('audDrop', 'audInput', function (f) {
  gAudFile = f;
  $('audFileLbl').textContent = f.name + ' — ' + fmtB(f.size);
  $('encBtn').disabled        = true;
  gSpeed = null;
  analyseCapacity();
});

setupDrop('decDrop', 'decInput', function (f) {
  loadDecodeFile(f);
});

// ═══════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════

(function init() {
  // Show version number in footer
  var vd = $('versionDisplay');
  if (vd) vd.textContent = VERSION;

  // Warn if Web Audio is missing (very old browser)
  if (!AudioCtx) {
    var warn = $('compatWarn');
    if (warn) {
      warn.style.display = 'block';
      warn.textContent   = 'Your browser does not support Web Audio. Please update to a modern browser.';
    }
  }

  // Note when running in file:// mode (Workers disabled)
  if (!USE_WORKER && window.location.protocol === 'file:') {
    var warn2 = $('compatWarn');
    if (warn2) {
      warn2.style.display = 'block';
      warn2.textContent   = 'Tip: serve this over http:// (e.g. "npx serve .") for faster encoding via Web Workers.';
    }
  }

  // Mobile: change drop zone text to "Tap to select"
  if (IS_MOBILE) {
    var hints = document.querySelectorAll('.dz-hint');
    for (var i = 0; i < hints.length; i++) hints[i].textContent = 'Tap to select a file';
  }

  // Apply saved or system theme
  applyTheme(getCurrentTheme());
}());