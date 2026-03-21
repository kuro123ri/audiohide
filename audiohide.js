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
 *   APNG HELPERS
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

var VERSION = '1.0.31';

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
// STATE
// ═══════════════════════════════════���═══════════════════════════

var gImgFile       = null;
var gAudFile       = null;
var gDecFile       = null;
var gExtracted     = null;
var gSpeed         = null;
var gAudDurSec     = null;
var gLastBlobSize  = 0;
var gOrigW         = null;
var gOrigH         = null;
var gAspectLock    = true;
var _resizeLock    = false;
var gCancelEnc     = false;
var gCancelDec     = false;

// ═══════════════════════════════════════════════════════════════
// DEVICE DETECTION
// ═══════════════════════════════════════════════════════════════

var IS_IOS    = /iP(hone|ad|od)/i.test(navigator.userAgent);
var IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent);

var USE_WORKER = (function () {
  if (typeof Worker === 'undefined') return false;
  if (window.location.protocol === 'file:') return false;
  return true;
}());

var gDebugLog = [];

// ═══════════════════════════════════════════════════════════════
// AUDIO CONTEXT COMPAT
// ═══════════════════════════════════════════════════════════════

var AudioCtx        = window.AudioContext        || window.webkitAudioContext;
var OfflineAudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function $(id) { return document.getElementById(id); }

function dbg(msg) {
  var ts  = new Date().toISOString().substr(11, 12);
  var line = '[' + ts + '] ' + msg;
  gDebugLog.push(line);
  if (gDebugLog.length > 50) gDebugLog.shift();
  var el = $('debugLog');
  if (el) el.textContent = gDebugLog.join('\n');
}

function fmtB(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function fmtT(ms) {
  var s = Math.round(ms / 1000), m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function fmtEta(ms) {
  var s = Math.round(ms / 1000);
  if (s < 2)  return 'almost done';
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════

function st(id, cls, msg) {
  var el = $(id);
  el.className    = 'status ' + cls;
  el.textContent  = msg;
  el.style.display = 'block';
}

function stHide(id) { $(id).style.display = 'none'; }

function prog(fillId, lblId, pctId, pct, label) {
  $(fillId).style.width = Math.min(pct, 100) + '%';
  $(lblId).textContent  = label;
  $(pctId).textContent  = Math.round(pct) + '%';
}

function setCancelVisible(btnId, visible) {
  var el = $(btnId);
  if (el) el.style.display = visible ? 'inline-block' : 'none';
}

// ═══════════════════════════════════════════════════════════════
// FILE / IMAGE COMPAT
// ═══════════════════════════════════════════════════════════════

function fileToArrayBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload  = function () { resolve(fr.result); };
    fr.onerror = function () { reject(fr.error || new Error('FileReader error')); };
    fr.readAsArrayBuffer(file);
  });
}

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

function decodeAudio(ac, buffer) {
  return new Promise(function (resolve, reject) {
    ac.decodeAudioData(buffer, resolve, reject);
  });
}

function safeClose(ac) {
  try { if (ac && ac.close) ac.close(); } catch (e) {}
}

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

function onMultiFrameToggle() {
  var on = $('multiFrameMode') && $('multiFrameMode').checked;
  var opts = $('mfOptions');
  if (opts) opts.style.display = on ? 'block' : 'none';
  var btn = $('encBtn');
  if (btn) btn.textContent = on ? 'Encode and Download APNG' : 'Encode and Download Image';
  analyseCapacity();
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
    e.target.value = '';
  });
}

// ═══════════════════════════════════════════════════════════════
// CAPACITY MATH
// ═══════════════════════════════════════════════════════════════

function pixelCap(w, h, bpc) {
  bpc = (bpc !== undefined) ? bpc : getLsbDepth();
  return Math.floor(w * h * 3 * bpc / 8) - HEADER_BYTES;
}

function wavEst(durSec, speed, sr, channels) {
  var rate = sr       || getOutSR();
  var ch   = channels || getChannels();
  return Math.ceil((durSec / speed) * rate) * ch * 2 + 44;
}

function pickSpeed(durSec, cap) {
  for (var i = 0; i < SPEEDS.length; i++) {
    if (wavEst(durSec, SPEEDS[i]) <= cap) return SPEEDS[i];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// AUDIO PROCESSING
// ═══════════════════════════════════════════════════════════════

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
 * processAudio variant for multi-frame — always mono, optionally different SR.
 */
function processAudioMF(arrayBuffer, speed) {
  var SR    = getOutSR();
  var ac    = new AudioCtx();
  var origDurMs;

  return decodeAudio(ac, arrayBuffer.slice(0))
    .then(function (decoded) {
      origDurMs  = Math.round(decoded.duration * 1000);
      var newLen = Math.ceil((decoded.duration / speed) * SR);

      // Multi-frame always uses mono
      var off = new OfflineAudioCtx(1, newLen, SR);
      var src = off.createBufferSource();
      src.buffer             = decoded;
      src.playbackRate.value = speed;
      src.connect(off.destination);
      src.start(0);
      safeClose(ac);
      return off.startRendering();
    })
    .then(function (rendered) {
      var normalEl = $('normalizeAudio');
      if (normalEl && normalEl.checked) {
        var ch   = rendered.getChannelData(0);
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
      return { wav: bufToWavMono(rendered), origDurMs: origDurMs };
    });
}

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

  ws(0,  'RIFF'); v.setUint32(4,  36 + dataSize,      true);
  ws(8,  'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16,                  true);
  v.setUint16(20, 1,             true);
  v.setUint16(22, numCh,         true);
  v.setUint32(24, sr,            true);
  v.setUint32(28, sr * numCh * 2, true);
  v.setUint16(32, numCh * 2,     true);
  v.setUint16(34, 16,            true);
  ws(36, 'data'); v.setUint32(40, dataSize, true);

  var channels = [];
  for (var c = 0; c < numCh; c++) channels.push(buf.getChannelData(c));

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

/** Mono-only WAV builder (for multi-frame) */
function bufToWavMono(buf) {
  var sr       = buf.sampleRate;
  var ns       = buf.length;
  var dataSize = ns * 2;
  var out      = new ArrayBuffer(44 + dataSize);
  var v        = new DataView(out);

  var ws = function (o, s) {
    for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };

  ws(0,  'RIFF'); v.setUint32(4,  36 + dataSize, true);
  ws(8,  'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, dataSize, true);

  var ch = buf.getChannelData(0);
  var offset = 44;
  for (var i = 0; i < ns; i++) {
    var x = Math.max(-1, Math.min(1, ch[i]));
    v.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
    offset += 2;
  }

  return new Uint8Array(out);
}

// ═══════════════════════════════════════════════════════════════
// HEADER + PAYLOAD
// ═══════════════════════════════════════════════════════════════

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
// LSB ENCODE / DECODE
// ═══════════════════════════════════════════════════════════════

function lsbEmbedWorker(data, payload, onProg, scatterKey, bpc, totalChannels) {
  return new Promise(function (resolve, reject) {
    var worker;
    try {
      worker = new Worker('lsb-worker.js');
    } catch (e) {
      dbg('Worker() constructor threw: ' + e.message + ' — falling back to main thread');
      USE_WORKER = false;
      var scatter = scatterKey ? buildScatterMap(scatterKey, totalChannels) : null;
      lsbEmbedMainThread(data, payload, onProg, scatter, bpc, encCancelRef).then(
        function () { resolve(data); }, reject
      );
      return;
    }

    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'progress') {
        onProg(msg.value, Date.now());
      } else if (msg.type === 'done') {
        worker.terminate();
        dbg('Worker embed done.');
        resolve(new Uint8ClampedArray(msg.data));
      } else if (msg.type === 'error') {
        worker.terminate();
        dbg('Worker embed error: ' + msg.message);
        reject(new Error(msg.message));
      }
    };

    worker.onerror = function (ev) {
      worker.terminate();
      var isLoadFailure = !ev.filename && !ev.lineno;
      if (isLoadFailure) {
        dbg('Worker script failed to load — disabling Workers, retrying on main thread.');
        USE_WORKER = false;
        var scatter = scatterKey ? buildScatterMap(scatterKey, totalChannels) : null;
        lsbEmbedMainThread(data, payload, onProg, scatter, bpc, encCancelRef).then(
          function () { resolve(data); }, reject
        );
      } else {
        var errMsg = ev.message + ' (' + ev.filename + ':' + ev.lineno + ')';
        dbg('Worker onerror: ' + errMsg);
        reject(new Error(errMsg));
      }
    };

    dbg('Worker embed start — ' + fmtB(payload.length) + ', bpc=' + bpc + ', scatter=' + !!scatterKey);

    var dataCopy    = data.buffer.slice(0);
    var payloadCopy = payload.buffer.slice(0);

    worker.postMessage({
      type:          'embed',
      data:          dataCopy,
      payload:       payloadCopy,
      bpc:           bpc,
      scatterKey:    scatterKey,
      totalChannels: totalChannels
    }, [dataCopy, payloadCopy]);
  });
}

function lsbExtractWorker(data, numBytes, startBit, onProg, scatterKey, bpc, totalChannels) {
  return new Promise(function (resolve, reject) {
    var worker;
    try {
      worker = new Worker('lsb-worker.js');
    } catch (e) {
      dbg('Worker() constructor threw: ' + e.message + ' — falling back to main thread');
      USE_WORKER = false;
      var scatter = scatterKey ? buildScatterMap(scatterKey, totalChannels) : null;
      lsbExtractMainThread(data, numBytes, startBit, onProg, scatter, bpc, decCancelRef).then(resolve, reject);
      return;
    }

    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'progress') {
        onProg(msg.value);
      } else if (msg.type === 'done') {
        worker.terminate();
        dbg('Worker extract done — ' + fmtB(numBytes));
        resolve(new Uint8Array(msg.result));
      } else if (msg.type === 'error') {
        worker.terminate();
        dbg('Worker extract error: ' + msg.message);
        reject(new Error(msg.message));
      }
    };

    worker.onerror = function (ev) {
      worker.terminate();
      var isLoadFailure = !ev.filename && !ev.lineno;
      if (isLoadFailure) {
        dbg('Worker script failed to load — disabling Workers, retrying on main thread.');
        USE_WORKER = false;
        var scatter = scatterKey ? buildScatterMap(scatterKey, totalChannels) : null;
        lsbExtractMainThread(data, numBytes, startBit, onProg, scatter, bpc, decCancelRef).then(resolve, reject);
      } else {
        var errMsg = ev.message + ' (' + ev.filename + ':' + ev.lineno + ')';
        dbg('Worker onerror: ' + errMsg);
        reject(new Error(errMsg));
      }
    };

    dbg('Worker extract start — ' + fmtB(numBytes) + ', bpc=' + bpc + ', scatter=' + !!scatterKey);

    var dataCopy = data.buffer.slice(0);
    worker.postMessage({
      type:          'extract',
      data:          dataCopy,
      numBytes:      numBytes,
      startBit:      startBit,
      bpc:           bpc,
      scatterKey:    scatterKey,
      totalChannels: totalChannels
    }, [dataCopy]);
  });
}

function lsbEmbedMainThread(data, payload, onProg, scatter, bpc, cancelRef) {
  bpc = bpc || 1;
  return new Promise(function (resolve, reject) {
    var totalBits = payload.length * 8;
    var CHUNK     = 600000;
    var bit       = 0;
    var startMs   = Date.now();

    function step() {
      if (cancelRef && cancelRef.val) {
        cancelRef.val = false;
        reject(new Error('Cancelled'));
        return;
      }

      var end = Math.min(bit + CHUNK, totalBits);

      if (bpc === 1 && !scatter) {
        for (var i = bit; i < end; i++) {
          var b  = (payload[i >> 3] >> (7 - (i & 7))) & 1;
          var di = (((i / 3) | 0) << 2) + (i % 3);
          data[di] = (data[di] & 0xFE) | b;
        }
      } else {
        for (var i2 = bit; i2 < end; i2++) {
          var b2     = (payload[i2 >> 3] >> (7 - (i2 & 7))) & 1;
          var chIdx  = (i2 / bpc) | 0;
          var bitPos = i2 % bpc;
          var ch     = scatter ? scatter(chIdx) : chIdx;
          var di2    = (((ch / 3) | 0) << 2) + (ch % 3);
          var mask   = ~(1 << bitPos) & 0xFF;
          data[di2]  = (data[di2] & mask) | (b2 << bitPos);
        }
      }

      bit = end;
      onProg(bit / totalBits, startMs);
      if (bit < totalBits) setTimeout(step, 0);
      else resolve(data);
    }
    step();
  });
}

function lsbExtractMainThread(data, numBytes, startBit, onProg, scatter, bpc, cancelRef) {
  bpc = bpc || 1;
  return new Promise(function (resolve, reject) {
    var result    = new Uint8Array(numBytes);
    var totalBits = numBytes * 8;
    var CHUNK     = 600000;
    var bit       = 0;

    function step() {
      if (cancelRef && cancelRef.val) {
        cancelRef.val = false;
        reject(new Error('Cancelled'));
        return;
      }

      var end = Math.min(bit + CHUNK, totalBits);

      if (bpc === 1 && !scatter) {
        var abs = startBit + bit;
        for (var i = bit; i < end; i++, abs++) {
          var di = (((abs / 3) | 0) << 2) + (abs % 3);
          var b  = data[di] & 1;
          result[i >> 3] |= (b << (7 - (i & 7)));
        }
      } else {
        for (var i2 = bit; i2 < end; i2++) {
          var absBit = startBit + i2;
          var chIdx  = (absBit / bpc) | 0;
          var bitPos = absBit % bpc;
          var ch     = scatter ? scatter(chIdx) : chIdx;
          var di2    = (((ch / 3) | 0) << 2) + (ch % 3);
          var b2     = (data[di2] >> bitPos) & 1;
          result[i2 >> 3] |= (b2 << (7 - (i2 & 7)));
        }
      }

      bit = end;
      onProg(bit / totalBits);
      if (bit < totalBits) setTimeout(step, 0);
      else resolve(result);
    }
    step();
  });
}

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

function cancelEncode() { encCancelRef.val = true; }
function cancelDecode() { decCancelRef.val = true; }

// ═══════════════════════════════════════════════════════════════
// APNG HELPERS
// ═══════════════════════════════════════════════════════════════

function _hasAPNG() {
  return typeof detectAPNG === 'function' && typeof parseAPNG === 'function' && typeof encodeAPNG === 'function';
}

function _isAPNG(buffer) {
  if (typeof detectAPNG === 'function') {
    try { return detectAPNG(buffer); } catch (e) { return false; }
  }
  return false;
}

function _isGIF(buffer) {
  if (typeof detectGIF === 'function') {
    try { return detectGIF(buffer); } catch (e) { return false; }
  }
  var d = new Uint8Array(buffer, 0, 6);
  var sig = String.fromCharCode(d[0],d[1],d[2],d[3],d[4],d[5]);
  return sig === 'GIF87a' || sig === 'GIF89a';
}

// ═══════════════════════════════════════════════════════════════
// SNIFF AHID MAGIC
// ═══════════════════════════════════════════════════════════════

function sniffAHID(file) {
  return loadImageBitmap(file)
    .then(function (bmp) {
      var cv    = document.createElement('canvas');
      cv.width  = bmp.width  || bmp.naturalWidth;
      cv.height = bmp.height || bmp.naturalHeight;
      var ctx   = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var data  = ctx.getImageData(0, 0, cv.width, cv.height).data;
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

  // In multi-frame mode, capacity is effectively unlimited (many frames)
  // Show per-frame capacity and total capacity based on original dimensions
  var isMulti = $('multiFrameMode') && $('multiFrameMode').checked;

  if (isMulti) {
    // Multi-frame: use original image dims for per-frame capacity (always bpc=1, mono)
    var mfCap = mfFrameCapacity(rW, rH);
    $('newCap').textContent     = fmtB(mfCap) + '/frame (multi-frame, up to 500 frames = ' + fmtB(mfCap * 500) + ')';
    $('estOutSize').textContent = 'depends on frame count';
    $('capRow').style.display   = 'flex';
  } else {
    var cap = Math.floor(rW * rH * 3 * bpc / 8) - HEADER_BYTES;
    $('newCap').textContent     = fmtB(cap);
    $('estOutSize').textContent = 'approx ' + fmtB(Math.round(rW * rH * 3 * 0.82));
    $('capRow').style.display   = 'flex';
  }

  if (!gAudFile) {
    $('capFill').className   = 'cap-fill';
    $('capFill').style.width = '0%';
    if (!isMulti) {
      var cap2 = Math.floor(rW * rH * 3 * bpc / 8) - HEADER_BYTES;
      $('capVal').textContent  = 'img cap: ' + fmtB(cap2);
    } else {
      $('capVal').textContent  = 'waiting for audio…';
    }
    $('badge').style.display = 'none';
    return;
  }

  st('encStatus', 'info', 'Analysing audio…');

  fileToArrayBuffer(gAudFile)
    .then(function (ab) { return getAudioDuration(ab); })
    ['catch'](function ()  { return (gAudFile.size * 8) / 128000; })
    .then(function (dur)   {
      if (isMulti) {
        _renderCapacityBadgeMF(dur, rW, rH);
      } else {
        var cap3 = Math.floor(rW * rH * 3 * bpc / 8) - HEADER_BYTES;
        _renderCapacityBadge(dur, cap3, bpc);
      }
    });
}

/** Capacity badge for multi-frame mode */
function _renderCapacityBadgeMF(dur, rW, rH) {
  stHide('encStatus');
  var badge     = $('badge');
  var manualSpd = getManualSpeed();
  var SR        = getOutSR();

  // Multi-frame always uses mono, bpc=1
  var mfCap  = mfFrameCapacity(rW, rH);
  var speed  = manualSpd || 1.0;

  // Estimate WAV size in mono
  var wavSz  = Math.ceil((dur / speed) * SR) * 2 + 44;
  var payloadSz = wavSz + HEADER_BYTES;
  var numFrames = Math.ceil(payloadSz / mfCap);

  if (manualSpd === null) {
    // Auto: try speeds to minimize frames, prefer 1.0x if reasonable
    speed = 1.0;
    for (var si = 0; si < SPEEDS.length; si++) {
      var testWav = Math.ceil((dur / SPEEDS[si]) * SR) * 2 + 44;
      var testPay = testWav + HEADER_BYTES;
      var testFrames = Math.ceil(testPay / mfCap);
      if (testFrames <= 500) {
        speed = SPEEDS[si];
        wavSz = testWav;
        payloadSz = testPay;
        numFrames = testFrames;
        break;
      }
    }
  } else {
    speed = manualSpd;
    wavSz  = Math.ceil((dur / speed) * SR) * 2 + 44;
    payloadSz = wavSz + HEADER_BYTES;
    numFrames = Math.ceil(payloadSz / mfCap);
  }

  if (numFrames > 500) {
    _showCapOver(mfCap);
    badge.className = 'badge red'; badge.style.display = 'block';
    badge.innerHTML = '<b>Too many frames needed: ' + numFrames + ' (max 500).</b><br>'
      + 'Payload: ' + fmtB(payloadSz) + ', ' + fmtB(mfCap) + '/frame.<br>'
      + 'Increase speed, lower sample rate, or enlarge image.';
    $('encBtn').disabled = true;
    return;
  }

  gSpeed = speed; gAudDurSec = dur;

  var pctPerFrame = Math.min(99, (1 / numFrames) * 100);
  _showCapBar(Math.min(99, payloadSz / (mfCap * numFrames) * 100),
    fmtB(payloadSz) + ' across ' + numFrames + ' frames');

  if (speed <= 1.01) {
    badge.className = 'badge green'; badge.style.display = 'block';
    badge.innerHTML = 'Fits at 1.0x in <b>' + numFrames + ' frames</b> — no pitch change.<br>'
      + 'Payload: ' + fmtB(payloadSz) + ', ' + fmtB(mfCap) + '/frame.';
  } else {
    var semitones = (12 * Math.log2(speed)).toFixed(1);
    var sign      = semitones >= 0 ? '+' : '';
    badge.className = 'badge'; badge.style.display = 'block';
    badge.innerHTML = 'Speed: <b>' + speed.toFixed(2) + 'x</b> (' + sign + semitones + ' sem) — <b>' + numFrames + ' frames</b><br>'
      + fmtT(dur * 1000) + ' → ' + fmtT(dur / speed * 1000) + ' — '
      + fmtB(payloadSz) + ', ' + fmtB(mfCap) + '/frame.';
  }
  $('encBtn').disabled = false;
}

/** Update the capacity bar and fit badge after audio duration is known. */
function _renderCapacityBadge(dur, cap, bpc) {
  stHide('encStatus');
  var badge     = $('badge');
  var manualSpd = getManualSpeed();
  var SR        = getOutSR();
  var channels  = getChannels();

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
// MULTI-FRAME
// ═══════════════════════════════════════════════════════════════

function mfFrameCapacity(w, h) {
  return Math.floor(w * h * 3 / 8);
}

/**
 * Encode audio into an animated APNG with audio spread across frames.
 *
 * KEY CHANGE: Uses the original frame dimensions (not resize) for per-frame
 * capacity. This ensures the payload is actually split across multiple frames
 * instead of fitting in one giant upscaled frame.
 *
 * frameW, frameH — the actual pixel dimensions of each output frame
 * sourceFrames   — array of {rgba, delayMs} from GIF, or null for static
 * sourceImg      — loaded bitmap for static images
 * payload        — full Uint8Array (AHID header + WAV)
 * delayMs        — per-frame delay
 * baseName       — filename base
 */
function doEncodeMultiFrame(sourceFrames, sourceImg, frameW, frameH, payload, delayMs, baseName) {
  if (!_hasAPNG()) {
    return Promise.reject(new Error('APNG support not available — apng.js not loaded.'));
  }

  var cap       = mfFrameCapacity(frameW, frameH);
  var numFrames = Math.ceil(payload.length / cap);
  var btn       = $('encBtn');

  dbg('Multi-frame encode: ' + numFrames + ' frames, ' + fmtB(payload.length) + ' payload, ' + fmtB(cap) + '/frame, ' + frameW + 'x' + frameH);

  if (numFrames < 2) {
    dbg('Warning: only 1 frame needed — this is normal for small audio + large image.');
  }

  if (numFrames > 500) {
    st('encStatus', 'err', 'Audio too long for this image size — needs ' + numFrames + ' frames (max 500). Enlarge image or increase speed.');
    btn.disabled = false;
    return Promise.resolve();
  }

  prog('encFill', 'encLbl', 'encPct', 10, 'Encoding frames…');
  st('encStatus', 'info', 'Encoding ' + numFrames + ' frames (' + frameW + '×' + frameH + ')…');

  var resultFrames = new Array(numFrames);
  var chain = Promise.resolve();

  for (var f = 0; f < numFrames; f++) {
    (function (frameIdx) {
      chain = chain.then(function () {
        var payloadStart = frameIdx * cap;
        var payloadEnd   = Math.min(payloadStart + cap, payload.length);
        var chunk        = payload.subarray(payloadStart, payloadEnd);

        var baseRGBA;
        if (sourceFrames && sourceFrames.length > 0) {
          // GIF input: cycle frames if more audio frames than GIF frames
          var srcFrame = sourceFrames[frameIdx % sourceFrames.length];
          baseRGBA = new Uint8ClampedArray(srcFrame.rgba);
        } else {
          // Static image: draw onto canvas at frame dimensions
          var cv2  = document.createElement('canvas');
          cv2.width = frameW; cv2.height = frameH;
          cv2.getContext('2d').drawImage(sourceImg, 0, 0, frameW, frameH);
          baseRGBA = new Uint8ClampedArray(cv2.getContext('2d').getImageData(0, 0, frameW, frameH).data);
        }

        return lsbEmbedMainThread(baseRGBA, chunk, function () {}, null, 1, null)
          .then(function (modified) {
            prog('encFill', 'encLbl', 'encPct',
              10 + ((frameIdx + 1) / numFrames) * 75,
              'Encoding frame ' + (frameIdx + 1) + ' / ' + numFrames + '…');
            resultFrames[frameIdx] = modified;
          });
      });
    }(f));
  }

  return chain
    .then(function () {
      prog('encFill', 'encLbl', 'encPct', 87, 'Building APNG…');
      st('encStatus', 'info', 'Building animated PNG (' + numFrames + ' frames)…');
      dbg('All ' + numFrames + ' frames encoded, building APNG…');
      return encodeAPNG(resultFrames, frameW, frameH, delayMs);
    })
    .then(function (apngBytes) {
      prog('encFill', 'encLbl', 'encPct', 98, 'Saving…');
      var blob = new Blob([apngBytes], { type: 'image/png' });
      gLastBlobSize = blob.size;
      triggerDownload(blob, 'audiohide_' + baseName + '.apng.png');
      return blob.size;
    });
}

/**
 * Decode audio from a multi-frame APNG.
 */
function doDecodeMultiFrame(buffer) {
  if (!_hasAPNG()) {
    return Promise.reject(new Error('APNG support not available �� apng.js not loaded.'));
  }

  prog('decFill', 'decLbl', 'decPct', 5, 'Parsing APNG frames…');
  st('decStatus', 'info', 'Parsing animated PNG…');
  dbg('Multi-frame decode: parsing APNG…');

  return parseAPNG(buffer).then(function (apng) {
    var frames = apng.frames;
    var rW = apng.width, rH = apng.height;
    var cap = mfFrameCapacity(rW, rH);

    dbg('APNG: ' + frames.length + ' frames, ' + rW + 'x' + rH + ', cap=' + fmtB(cap) + '/frame');

    if (frames.length === 0) throw new Error('No frames found in APNG');

    prog('decFill', 'decLbl', 'decPct', 15, 'Reading frame 1 / ' + frames.length + '…');

    return lsbExtractMainThread(frames[0], HEADER_BYTES, 0, function () {}, null, 1, null)
      .then(function (hdrBytes) {
        var hv = new DataView(hdrBytes.buffer);

        for (var i = 0; i < 4; i++) {
          if (hdrBytes[i] !== MAGIC[i]) throw new Error('NOAHID');
        }

        var dataLen   = hv.getUint32(4,  false);
        var speedX1k  = hv.getUint32(8,  false);
        var origDurMs = hv.getUint32(12, false);
        var bpc       = hv.getUint8(16) || 1;
        var channels  = hv.getUint8(17) || 1;
        var speed     = speedX1k / 1000;

        if (dataLen === 0 || dataLen > 400 * 1024 * 1024) throw new Error('BADHDR');

        dbg('Header: dataLen=' + fmtB(dataLen) + ', speed=' + speed.toFixed(2) + 'x, bpc=' + bpc);
        st('decStatus', 'info', 'Found ' + frames.length + '-frame APNG, extracting ' + fmtB(dataLen) + '…');

        var totalNeeded = HEADER_BYTES + dataLen;
        var allChunks   = [];
        var accumulated = 0;

        var extractChain = Promise.resolve();
        for (var f = 0; f < frames.length && accumulated < totalNeeded; f++) {
          (function (fi, frameData) {
            var bytesInFrame = Math.min(cap, totalNeeded - accumulated);
            accumulated += bytesInFrame;

            extractChain = extractChain.then(function () {
              var pct = 15 + ((fi + 1) / frames.length) * 70;
              prog('decFill', 'decLbl', 'decPct', pct,
                'Extracting frame ' + (fi + 1) + ' / ' + frames.length + '…');
              return lsbExtractMainThread(frameData, bytesInFrame, 0, function () {}, null, 1, null);
            }).then(function (chunk) {
              allChunks.push(chunk);
            });
          }(f, frames[f]));
        }

        return extractChain.then(function () {
          var totalExtracted = allChunks.reduce(function (s, c) { return s + c.length; }, 0);
          var flat = new Uint8Array(totalExtracted);
          var off  = 0;
          allChunks.forEach(function (c) { flat.set(c, off); off += c.length; });

          var audioBytes = flat.subarray(HEADER_BYTES, HEADER_BYTES + dataLen);

          return {
            audioBytes: audioBytes,
            dataLen:    dataLen,
            origDurMs:  origDurMs,
            encDurMs:   Math.round(origDurMs / speed),
            speed:      speed,
            bpc:        bpc,
            channels:   channels,
            numFrames:  frames.length
          };
        });
      });
  });
}

// ═══════════════════════════════════════════════════════════════
// ENCODE
// ═══════════════════════════════════════════════════════════════

function doEncode() {
  if (!gImgFile || !gAudFile || gSpeed === null) {
    st('encStatus', 'err', 'Missing files or no valid speed. Check image and audio.');
    return;
  }

  var multiFrame = $('multiFrameMode') && $('multiFrameMode').checked;
  if (multiFrame) { doEncodeMultiFrameStart(); return; }

  var btn = $('encBtn');
  btn.disabled = true;
  stHide('encStatus');
  $('encProg').style.display = 'block';
  setCancelVisible('cancelEncBtn', !USE_WORKER);
  var iosNote = $('iosNote'); if (iosNote) iosNote.style.display = 'none';

  var bmp, rW, rH, cv, ctx, bpc, payload, scatterKey, channels;

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

      var pixelData = ctx.getImageData(0, 0, rW, rH).data;

      var encStart = Date.now();
      return lsbEmbed(pixelData, payload, function (p) {
        var pct = 30 + p * 62;
        var eta = '';
        if (p > 0.03 && p < 0.97) {
          var elapsed = Date.now() - encStart;
          eta = ' (~' + fmtEta((elapsed / p) * (1 - p)) + ')';
        }
        prog('encFill', 'encLbl', 'encPct', pct, 'Encoding ' + Math.round(pct) + '%' + eta);
      }, scatterKey, bpc, totalChannels);
    })
    .then(function (modifiedPixels) {
      prog('encFill', 'encLbl', 'encPct', 93, 'Saving PNG…');

      if (!modifiedPixels || modifiedPixels.length === 0) {
        throw new Error('Encoding produced empty pixel data. Please try again.');
      }
      if (modifiedPixels.length !== rW * rH * 4) {
        throw new Error('Pixel data size mismatch: expected ' + (rW * rH * 4) + ', got ' + modifiedPixels.length);
      }

      ctx.putImageData(new ImageData(modifiedPixels, rW, rH), 0, 0);
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
        dbg('Encode error: ' + (e && e.message ? e.message : String(e)));
      }
      btn.disabled = false;
    });
}

/**
 * Multi-frame APNG encode entry point.
 *
 * KEY FIX: For GIF input, use the ORIGINAL GIF frame dimensions (not the
 * resize dimensions). This ensures the audio payload is split across the
 * actual number of GIF frames (e.g. 245 frames) rather than squeezed into
 * 1 giant upscaled frame.
 *
 * For static images, the resize dimensions are used (since there's only
 * one source frame, we replicate it at the chosen size).
 */
function doEncodeMultiFrameStart() {
  var btn = $('encBtn');
  btn.disabled = true;
  stHide('encStatus');
  $('encProg').style.display = 'block';
  var iosNote = $('iosNote'); if (iosNote) iosNote.style.display = 'none';

  var rW = parseInt($('rW').value, 10) || gOrigW;
  var rH = parseInt($('rH').value, 10) || gOrigH;
  var delayMs = parseInt($('mfDelay').value, 10) || 200;
  var baseName = gImgFile.name.replace(/\.[^.]+$/, '');
  var isGIF    = gImgFile.type === 'image/gif' || /\.gif$/i.test(gImgFile.name);

  prog('encFill', 'encLbl', 'encPct', 3, 'Loading…');
  st('encStatus', 'info', 'Processing audio…');

  fileToArrayBuffer(gAudFile)
    .then(function (ab) { return processAudioMF(ab, gSpeed); })
    .then(function (r) {
      prog('encFill', 'encLbl', 'encPct', 20, 'Building payload…');
      var payload = buildPayload(r.wav, Math.round(gSpeed * 1000), r.origDurMs, 1, 1);
      dbg('Multi-frame payload: ' + fmtB(payload.length) + ', speed=' + gSpeed.toFixed(2) + 'x');

      if (isGIF) {
        if (typeof parseGIF !== 'function') {
          throw new Error('GIF parsing not available — apng.js not loaded.');
        }
        prog('encFill', 'encLbl', 'encPct', 25, 'Parsing GIF frames…');
        st('encStatus', 'info', 'Parsing GIF…');
        return fileToArrayBuffer(gImgFile).then(function (gifBuf) {
          var gifData = parseGIF(gifBuf);
          dbg('GIF: ' + gifData.frames.length + ' frames, ' + gifData.width + 'x' + gifData.height);

          // Use ORIGINAL GIF dimensions for frame encoding —
          // this is what makes multi-frame actually produce multiple frames
          var frameW = gifData.width;
          var frameH = gifData.height;

          // Check if user wants to resize — only resize if explicitly changed
          // from the original GIF dimensions
          if (rW !== gOrigW || rH !== gOrigH) {
            // User explicitly resized — use their dimensions
            frameW = rW;
            frameH = rH;
            dbg('User resized to ' + frameW + 'x' + frameH + ' — using for multi-frame');

            // Scale GIF frames to target size
            var scaledFrames = gifData.frames.map(function (f) {
              var cv2 = document.createElement('canvas');
              cv2.width = frameW; cv2.height = frameH;
              var ctx2 = cv2.getContext('2d');
              var tmpCv = document.createElement('canvas');
              tmpCv.width = gifData.width; tmpCv.height = gifData.height;
              tmpCv.getContext('2d').putImageData(
                new ImageData(new Uint8ClampedArray(f.rgba), gifData.width, gifData.height), 0, 0);
              ctx2.drawImage(tmpCv, 0, 0, frameW, frameH);
              return {
                rgba: new Uint8ClampedArray(ctx2.getImageData(0, 0, frameW, frameH).data),
                delayMs: f.delayMs
              };
            });
            return doEncodeMultiFrame(scaledFrames, null, frameW, frameH, payload, delayMs, baseName);
          }

          // No resize — use original GIF frame data directly
          return doEncodeMultiFrame(gifData.frames, null, frameW, frameH, payload,
            gifData.frames[0].delayMs || delayMs, baseName);
        });
      } else {
        // Static image: use resize dimensions, replicate across frames
        return loadImageBitmap(gImgFile).then(function (bmp) {
          return doEncodeMultiFrame(null, bmp, rW, rH, payload, delayMs, baseName);
        });
      }
    })
    .then(function (blobSize) {
      prog('encFill', 'encLbl', 'encPct', 100, 'Done!');
      st('encStatus', 'ok', 'Done. APNG downloaded.'
        + ' Output: ' + fmtB(blobSize || 0) + '. Speed: ' + gSpeed.toFixed(2) + 'x.'
        + ' Tip: drop this file into the Decode tab to extract the audio.');
      btn.disabled = false;
    })
    ['catch'](function (e) {
      st('encStatus', 'err', 'Error: ' + (e && e.message ? e.message : String(e)));
      dbg('Multi-frame encode error: ' + (e && e.message ? e.message : String(e)));
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
  setCancelVisible('cancelDecBtn', false);

  st('decStatus', 'info', 'Loading…');
  dbg('Decode start: ' + gDecFile.name + ' (' + fmtB(gDecFile.size) + ')');

  fileToArrayBuffer(gDecFile)
    .then(function (buf) {
      if (_isAPNG(buf)) {
        dbg('Detected animated APNG — multi-frame decode');
        return doDecodeMultiFrame(buf).then(function (r) {
          return finishDecode(r.audioBytes, r.dataLen, r.origDurMs, r.encDurMs,
                              r.speed, r.bpc, r.channels, r.numFrames);
        });
      }
      dbg('Single-frame decode (standard PNG/BMP)');
      return doDecodeSingleFrame(buf);
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
        dbg('Decode error: ' + (e && e.message ? e.message : String(e)));
      }
      btn.disabled = false;
    });
}

function doDecodeSingleFrame(buf) {
  var btn = $('decBtn');
  var speed, bpc, channels, scatterKey;

  return loadImageBitmap(gDecFile)
    .then(function (bmp) {
      var cv    = document.createElement('canvas');
      cv.width  = bmp.width  || bmp.naturalWidth;
      cv.height = bmp.height || bmp.naturalHeight;
      var ctx   = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var data  = ctx.getImageData(0, 0, cv.width, cv.height).data;

      var decKey  = $('decPasskey') ? $('decPasskey').value.trim() : '';
      var totalCh = cv.width * cv.height * 3;
      scatterKey  = decKey || null;

      prog('decFill', 'decLbl', 'decPct', 5, 'Reading header…');
      setCancelVisible('cancelDecBtn', !USE_WORKER);

      /**
       * Try all combinations of bpc (1, 2) and scatter (off, on) to find valid header.
       * Order: bpc=1 plain → bpc=2 plain → bpc=1 scatter → bpc=2 scatter
       * This auto-detects the encoding mode without requiring the user to set it.
       */
      var attempts = [
        { bpc: 1, scatter: null,       label: 'bpc=1, no scatter' },
        { bpc: 2, scatter: null,       label: 'bpc=2, no scatter' }
      ];
      if (scatterKey) {
        attempts.push({ bpc: 1, scatter: scatterKey, label: 'bpc=1, scatter' });
        attempts.push({ bpc: 2, scatter: scatterKey, label: 'bpc=2, scatter' });
      }

      var attemptIdx = 0;

      function tryNextAttempt() {
        if (attemptIdx >= attempts.length) {
          throw new Error('NOAHID');
        }

        var att = attempts[attemptIdx];
        attemptIdx++;

        var scatterMap = att.scatter ? buildScatterMap(att.scatter, totalCh) : null;

        return lsbExtractMainThread(data, HEADER_BYTES, 0, function () {}, scatterMap, att.bpc, null)
          .then(function (hdrBytes) {
            // Check AHID magic
            for (var i = 0; i < 4; i++) {
              if (hdrBytes[i] !== MAGIC[i]) {
                dbg('Header attempt ' + att.label + ' — magic mismatch');
                return tryNextAttempt();
              }
            }

            var hv = new DataView(hdrBytes.buffer);
            var dataLen   = hv.getUint32(4,  false);
            var speedX1k  = hv.getUint32(8,  false);
            var origDurMs = hv.getUint32(12, false);
            var hdrBpc    = hv.getUint8(16) || 1;
            var hdrCh     = hv.getUint8(17) || 1;
            var spd       = speedX1k / 1000;

            // Sanity check header values — reject if they look corrupt
            if (dataLen === 0 || dataLen > 400 * 1024 * 1024) {
              dbg('Header attempt ' + att.label + ' — bad dataLen: ' + dataLen);
              return tryNextAttempt();
            }
            if (speedX1k === 0 || speedX1k > 10000) {
              dbg('Header attempt ' + att.label + ' — bad speed: ' + speedX1k);
              return tryNextAttempt();
            }
            if (hdrBpc !== 1 && hdrBpc !== 2) {
              dbg('Header attempt ' + att.label + ' — bad bpc: ' + hdrBpc);
              return tryNextAttempt();
            }
            if (hdrCh !== 1 && hdrCh !== 2) {
              dbg('Header attempt ' + att.label + ' — bad channels: ' + hdrCh);
              return tryNextAttempt();
            }

            // Check that payload fits in image
            var maxCap = Math.floor(totalCh * att.bpc / 8);
            if (dataLen + HEADER_BYTES > maxCap) {
              dbg('Header attempt ' + att.label + ' — dataLen exceeds capacity');
              return tryNextAttempt();
            }

            dbg('Header found via ' + att.label + ': dataLen=' + fmtB(dataLen) +
                ', speed=' + spd.toFixed(2) + 'x, bpc=' + hdrBpc + ', ch=' + hdrCh);

            return {
              dataLen:   dataLen,
              speed:     spd,
              origDurMs: origDurMs,
              encDurMs:  Math.round(origDurMs / spd),
              bpc:       att.bpc,       // use the bpc we successfully decoded with
              channels:  hdrCh,
              useScatter: !!att.scatter
            };
          });
      }

      return tryNextAttempt()
        .then(function (hdr) {
          bpc      = hdr.bpc;
          channels = hdr.channels;
          speed    = hdr.speed;

          st('decStatus', 'info', 'Extracting ' + fmtB(hdr.dataLen) + ' (' + bpc + '-bit mode)…');
          prog('decFill', 'decLbl', 'decPct', 10, 'Extracting bits…');

          var extractScatter = hdr.useScatter ? scatterKey : null;
          var decStart = Date.now();

          return lsbExtract(data, hdr.dataLen, HEADER_BYTES * 8, function (p) {
            var pct = 10 + p * 75;
            var eta = p > 0.03 && p < 0.97
              ? ' (~' + fmtEta(((Date.now() - decStart) / p) * (1 - p)) + ')' : '';
            prog('decFill', 'decLbl', 'decPct', pct, 'Extracting ' + Math.round(pct) + '%' + eta);
          }, extractScatter, bpc, totalCh)
          .then(function (audioBytes) {
            return finishDecode(audioBytes, hdr.dataLen, hdr.origDurMs, hdr.encDurMs,
                                speed, bpc, channels, 1);
          });
        });
    });
}

function finishDecode(audioBytes, dataLen, origDurMs, encDurMs, speed, bpc, channels, numFrames) {
  var btn = $('decBtn');
  $('iSize').textContent    = fmtB(dataLen) + (numFrames > 1 ? ' (' + numFrames + ' frames)' : '');
  $('iSpeed').textContent   = speed.toFixed(2) + 'x';
  $('iOrig').textContent    = fmtT(origDurMs);
  $('iEnc').textContent     = fmtT(encDurMs);
  $('iBpc').textContent     = bpc + '-bit ' + (channels === 2 ? 'stereo' : 'mono')
    + (numFrames > 1 ? ', ' + numFrames + '-frame APNG' : '');
  $('infoCard').style.display = 'block';

  var note = $('iNote');
  if (speed <= 1.01) {
    note.innerHTML = '<b>No speed adjustment</b> — plays at original speed and pitch.';
  } else {
    var semi = (12 * Math.log2(speed)).toFixed(1);
    note.innerHTML = '<b>Encoded at ' + speed.toFixed(2) + 'x (' + (semi > 0 ? '+' : '') + semi + ' sem).</b><br>'
      + 'Stored: ' + fmtT(encDurMs) + ' — Original: ' + fmtT(origDurMs) + '.';
  }

  var doPitch = $('pitchCorrect') && $('pitchCorrect').checked && speed > 1.01;
  var chain   = doPitch
    ? (prog('decFill', 'decLbl', 'decPct', 88, 'Pitch correcting…'),
       st('decStatus', 'info', 'Restoring original pitch…'),
       pitchCorrect(audioBytes, speed).then(function (fixed) {
         $('iNote').innerHTML += '<br><b>Pitch correction applied</b> — audio restored to original.';
         return { bytes: fixed, pitched: true };
       }))
    : Promise.resolve({ bytes: audioBytes, pitched: false });

  return chain.then(function (r) {
    gExtracted = new Blob([r.bytes], { type: 'audio/wav' });
    $('audioOut').src = URL.createObjectURL(gExtracted);
    $('audioWrap').style.display = 'block';
    setCancelVisible('cancelDecBtn', false);
    prog('decFill', 'decLbl', 'decPct', 100, 'Done!');
    st('decStatus', 'ok', 'Extracted ' + fmtB(dataLen) + '.'
      + (numFrames > 1 ? ' Multi-frame APNG (' + numFrames + ' frames).' : '')
      + (r.pitched ? ' Pitch corrected.' : ' Press play to listen.'));
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
  _resizeLock = true;
  $('rScale').value = pct;
  $('rW').value = Math.max(1, Math.round(gOrigW * pct / 100));
  $('rH').value = Math.max(1, Math.round(gOrigH * pct / 100));
  _resizeLock = false;
  updateResizeHint(); analyseCapacity();
}

function onResizeScale() {
  var pct = parseFloat($('rScale').value);
  if (!pct || !gOrigW || !gOrigH) return;
  _resizeLock = true;
  $('rW').value = Math.max(1, Math.round(gOrigW * pct / 100));
  $('rH').value = Math.max(1, Math.round(gOrigH * pct / 100));
  _resizeLock = false;
  updateResizeHint(); analyseCapacity();
}

function onResizeW() {
  if (_resizeLock) return;
  var w = parseInt($('rW').value, 10);
  if (!w || !gOrigW || !gOrigH) return;
  if (gAspectLock) $('rH').value = Math.max(1, Math.round(w * gOrigH / gOrigW));
  updateResizeHint(); analyseCapacity();
}

function onResizeH() {
  if (_resizeLock) return;
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
  var ok = (f.type === 'image/png' || f.type === 'image/bmp' || f.type === 'image/gif' ||
            /\.(png|bmp|gif)$/i.test(f.name));
  if (!ok) {
    st('encStatus', 'err',
      'Only PNG, BMP, or GIF files can be used as the carrier image. ' +
      'JPEG compression destroys hidden data. Output is always saved as PNG.');
    return;
  }

  sniffAHID(f).then(function (isEncoded) {
    if (isEncoded) {
      switchTab('dec');
      loadDecodeFile(f);
      st('decStatus', 'info', 'AudioHide image detected — tap "Extract Audio" to decode.');
      return;
    }

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
      _resizeLock = true;
      $('rW').value               = gOrigW;
      $('rH').value               = gOrigH;
      _resizeLock = false;
      $('rScale').value           = 100;
      $('origDims').textContent   = gOrigW + ' × ' + gOrigH + ' px'
        + (f.type === 'image/gif' ? ' (GIF — first frame only for single PNG, all frames for APNG mode)' : '');
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
  var vd = $('versionDisplay');
  if (vd) vd.textContent = VERSION;

  dbg('AudioHide v' + VERSION);
  dbg('UA: ' + navigator.userAgent);
  dbg('Protocol: ' + window.location.protocol);
  dbg('Worker API: ' + (typeof Worker !== 'undefined' ? 'yes' : 'NO'));
  dbg('USE_WORKER: ' + USE_WORKER);
  dbg('AudioContext: ' + (AudioCtx ? 'yes' : 'NO'));
  dbg('OfflineAudioContext: ' + (OfflineAudioCtx ? 'yes' : 'NO'));
  dbg('createImageBitmap: ' + (typeof createImageBitmap === 'function' ? 'yes' : 'no (fallback active)'));
  dbg('File.arrayBuffer: ' + (typeof File !== 'undefined' && File.prototype.arrayBuffer ? 'yes' : 'no (FileReader fallback active)'));
  dbg('CompressionStream:   ' + (typeof CompressionStream   !== 'undefined' ? 'yes' : 'NO (APNG encode uses STORE fallback)'));
  dbg('DecompressionStream: ' + (typeof DecompressionStream !== 'undefined' ? 'yes' : 'NO (APNG decode not available)'));
  dbg('apng.js loaded: ' + _hasAPNG());

  if (!AudioCtx) {
    var warn = $('compatWarn');
    if (warn) {
      warn.style.display = 'block';
      warn.textContent   = 'Your browser does not support Web Audio. Please update to a modern browser.';
    }
  }

  if (!USE_WORKER && window.location.protocol === 'file:') {
    var warn2 = $('compatWarn');
    if (warn2) {
      warn2.style.display = 'block';
      warn2.textContent   = 'Tip: serve this over http:// (e.g. "npx serve .") for faster encoding via Web Workers.';
    }
  }

  if (IS_MOBILE) {
    var hints = document.querySelectorAll('.dz-hint');
    for (var i = 0; i < hints.length; i++) hints[i].textContent = 'Tap to select a file';
  }

  applyTheme(getCurrentTheme());
}());

// ═══════════════════════════════════════════════════════════════
// DEBUG PANEL
// ═══════════════════════════════════════════════════════════════

function toggleDebug() {
  var panel = $('debugPanel');
  var open  = panel.classList.toggle('open');
  if (open) refreshDebugPanel();
}

function refreshDebugPanel() {
  var workerStatus;
  if (typeof Worker === 'undefined')             workerStatus = 'NO';
  else if (window.location.protocol === 'file:') workerStatus = 'Disabled (file:// — serve over http)';
  else if (!USE_WORKER)                          workerStatus = 'Disabled (load failure — using main thread)';
  else                                           workerStatus = 'OK';

  $('dbgWorker').textContent  = workerStatus;
  $('dbgAudio').textContent   = AudioCtx        ? 'OK (' + (window.AudioContext ? 'standard' : 'webkit prefix') + ')' : 'NO';
  $('dbgOffline').textContent = OfflineAudioCtx ? 'OK (' + (window.OfflineAudioContext ? 'standard' : 'webkit prefix') + ')' : 'NO';
  $('dbgBitmap').textContent  = typeof createImageBitmap === 'function' ? 'OK (native)' : 'Fallback (<img> element)';
  $('dbgArrBuf').textContent  = (typeof File !== 'undefined' && File.prototype.arrayBuffer) ? 'OK (native)' : 'Fallback (FileReader)';
  $('dbgProto').textContent   = window.location.protocol;
  $('dbgMobile').textContent  = IS_MOBILE ? (IS_IOS ? 'iOS' : 'Android') : 'No';
  $('dbgVer').textContent     = VERSION;
  $('dbgCompress').textContent = (typeof CompressionStream   !== 'undefined') ? 'OK (native)' : 'NO (zlib STORE fallback — larger files)';
  $('dbgDecompress').textContent = (typeof DecompressionStream !== 'undefined') ? 'OK (native)' : 'NO — multi-frame decode will fail';

  var el = $('debugLog');
  if (el) el.textContent = gDebugLog.length ? gDebugLog.join('\n') : '(no events yet)';
}

function copyDebugInfo() {
  var lines = [
    'AudioHide Debug Report — ' + new Date().toISOString(),
    'Version:      ' + VERSION,
    'UA:           ' + navigator.userAgent,
    'Protocol:     ' + window.location.protocol,
    'Worker:       ' + $('dbgWorker').textContent,
    'AudioContext: ' + $('dbgAudio').textContent,
    'OfflineACtx:  ' + $('dbgOffline').textContent,
    'ImageBitmap:  ' + $('dbgBitmap').textContent,
    'File.arrBuf:  ' + $('dbgArrBuf').textContent,
    'Mobile:       ' + $('dbgMobile').textContent,
    '',
    '--- Event log ---',
    gDebugLog.join('\n')
  ];
  var text = lines.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      $('copyDebugBtn').textContent = 'Copied!';
      setTimeout(function () { $('copyDebugBtn').textContent = 'Copy to clipboard'; }, 2000);
    });
  } else {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0'; ta.style.left = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); $('copyDebugBtn').textContent = 'Copied!'; } catch (e) {}
    document.body.removeChild(ta);
    setTimeout(function () { $('copyDebugBtn').textContent = 'Copy to clipboard'; }, 2000);
  }
}