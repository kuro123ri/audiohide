/* =============================================================
   AudioHide — audiohide.js
   Browser support: Chrome 49+, Firefox 52+, Safari 11+,
                    iOS Safari 11+, Android Chrome 67+
   ============================================================= */

// ── Polyfills (IE11 / old Android / old iOS) ──────────────────

// Math.imul — used in Mulberry32 PRNG (not in IE11)
if (!Math.imul) {
  Math.imul = function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bh + ah * bl) << 16) + (al * bl) | 0;
  };
}

// Math.log2 — not in IE11
if (!Math.log2) {
  Math.log2 = function (x) { return Math.log(x) / Math.LN2; };
}

// String.prototype.padStart — not in IE11
if (!String.prototype.padStart) {
  String.prototype.padStart = function (n, c) {
    var s = String(this);
    c = c === undefined ? ' ' : String(c);
    while (s.length < n) s = c + s;
    return s;
  };
}

// Array.prototype.forEach on Uint8Array — works everywhere modern,
// kept for safety
// ─────────────────────────────────────────────────────────────

// ── Constants ─────────────────────────────────────────────────
var MAGIC        = [0x41, 0x48, 0x49, 0x44]; // "AHID"
var HEADER_BYTES = 20; // magic(4) + dataLen(4) + speedX1k(4) + origDurMs(4) + bpc(1) + reserved(3)
var SPEEDS       = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0];
var SCATTER_SEG  = 1024;

// ── State ─────────────────────────────────────────────────────
var gImgFile      = null;
var gAudFile      = null;
var gDecFile      = null;
var gExtracted    = null;
var gSpeed        = null;
var gAudDurSec    = null;
var gLastBlobSize = 0;
var gOrigW        = null;
var gOrigH        = null;
var gAspectLock   = true;

// ── Detect mobile / iOS ───────────────────────────────────────
var IS_IOS     = /iP(hone|ad|od)/i.test(navigator.userAgent);
var IS_MOBILE  = IS_IOS || /Android/i.test(navigator.userAgent);
var IS_SAFARI  = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// ── Compat: Audio context constructors ───────────────────────
var AudioCtx         = window.AudioContext        || window.webkitAudioContext;
var OfflineAudioCtx  = window.OfflineAudioContext || window.webkitOfflineAudioContext;

// ── Helpers ───────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

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

// ── UI helpers ────────────────────────────────────────────────
function st(id, cls, msg) {
  var el = $(id);
  el.className   = 'status ' + cls;
  el.textContent = msg;
  el.style.display = 'block';
}
function stHide(id) { $(id).style.display = 'none'; }

function prog(fillId, lblId, pctId, pct, label) {
  $(fillId).style.width  = Math.min(pct, 100) + '%';
  $(lblId).textContent   = label;
  $(pctId).textContent   = Math.round(pct) + '%';
}

// ── Compat: read File as ArrayBuffer ─────────────────────────
// File.arrayBuffer() not in Safari<14.1 — use FileReader fallback
function fileToArrayBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload  = function () { resolve(fr.result); };
    fr.onerror = function () { reject(fr.error || new Error('FileReader error')); };
    fr.readAsArrayBuffer(file);
  });
}

// ── Compat: createImageBitmap fallback for old Safari ─────────
// createImageBitmap not in Safari<15; <img> works fine with ctx.drawImage
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

// ── Compat: decodeAudioData (callback form for old Safari) ────
// Old Safari does not return a Promise from decodeAudioData.
function decodeAudio(ac, buffer) {
  return new Promise(function (resolve, reject) {
    // Callback form works everywhere; modern browsers also fire the Promise but
    // wrapping in our own Promise avoids double-resolve issues.
    ac.decodeAudioData(buffer, resolve, reject);
  });
}

// ── Compat: safely close AudioContext ────────────────────────
function safeClose(ac) {
  try { if (ac && ac.close) ac.close(); } catch (e) {}
}

// ── Compat: iOS-safe file download ───────────────────────────
// iOS Safari <13 ignores a.download on blob URLs entirely.
// Strategy: try normal download; if iOS show a persistent notice.
function triggerDownload(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  if (IS_IOS) {
    // Show the blob in a new tab so the user can long-press to save
    var iosNote = $('iosNote');
    if (iosNote) {
      iosNote.style.display = 'block';
      iosNote.innerHTML =
        '<b>iPhone/iPad tip:</b> If the file did not save, ' +
        '<a href="' + url + '" target="_blank">tap here to open the image</a> ' +
        'then tap the share icon and choose <b>Save to Photos</b> or <b>Save to Files</b>.';
    }
  }

  // Revoke after a delay so the tab link still works
  setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
}

// ── Settings accessors ────────────────────────────────────────
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

// ── Settings UI handlers ──────────────────────────────────────
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
  var v        = parseInt($('manualSpeed').value, 10) / 100;
  var semitones = (12 * Math.log2(v)).toFixed(1);
  var sign      = semitones >= 0 ? '+' : '';
  $('manualSemitones').textContent = v === 1
    ? 'No pitch change at 1.0x'
    : 'Pitch shift: ' + sign + semitones + ' semitones';
}

function onPasskeyToggle() {
  var on = $('passkeyEnabled').checked;
  $('passkeyRow').style.display    = on ? 'block' : 'none';
  $('decPasskeyRow').style.display = on ? 'block' : 'none';
}

// ── Tabs ──────────────────────────────────────────────────────
function switchTab(t) {
  ['enc', 'dec'].forEach(function (x) {
    $('tab-'   + x).classList.toggle('active', x === t);
    $('panel-' + x).classList.toggle('active', x === t);
  });
}

// ── Scatter PRNG ──────────────────────────────────────────────
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
  for (var i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function buildScatterMap(key, availChannels) {
  var segCount = Math.ceil(availChannels / SCATTER_SEG);
  var order    = new Uint32Array(segCount);
  for (var i = 0; i < segCount; i++) order[i] = i;

  var rand = mulberry32(hashKey(key));
  for (var i = segCount - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }

  return function (chIdx) {
    var seg = (chIdx / SCATTER_SEG) | 0;
    var off = chIdx % SCATTER_SEG;
    var ch  = order[seg] * SCATTER_SEG + off;
    return ch < availChannels ? ch : chIdx;
  };
}

function getScatter(totalChannels) {
  if (!$('passkeyEnabled') || !$('passkeyEnabled').checked) return null;
  var key = $('passkeyInput').value.trim();
  if (!key) return null;
  return buildScatterMap(key, totalChannels);
}

// ── Drop zones ────────────────────────────────────────────────
function setupDrop(dropId, inputId, cb) {
  var el = $(dropId);
  el.addEventListener('dragover',  function (e) { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', function ()  { el.classList.remove('over'); });
  el.addEventListener('drop', function (e) {
    e.preventDefault(); el.classList.remove('over');
    var f = e.dataTransfer.files[0]; if (f) cb(f);
  });
  $(inputId).addEventListener('change', function (e) {
    var f = e.target.files[0]; if (f) cb(f);
    // Reset input so same file can be chosen again
    e.target.value = '';
  });
}

// ── Capacity math ─────────────────────────────────────────────
function pixelCap(w, h, bpc) {
  bpc = bpc !== undefined ? bpc : getLsbDepth();
  return Math.floor(w * h * 3 * bpc / 8) - HEADER_BYTES;
}

function wavEst(durSec, speed, sr) {
  var rate = sr !== undefined ? sr : getOutSR();
  return Math.ceil((durSec / speed) * rate) * 2 + 44;
}

function pickSpeed(durSec, cap) {
  for (var i = 0; i < SPEEDS.length; i++) {
    if (wavEst(durSec, SPEEDS[i]) <= cap) return SPEEDS[i];
  }
  return null;
}

// ── Audio processing ──────────────────────────────────────────
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
  var SR = getOutSR();
  var ac = new AudioCtx();
  var origDurMs;

  return decodeAudio(ac, arrayBuffer.slice(0))
    .then(function (decoded) {
      origDurMs      = Math.round(decoded.duration * 1000);
      var newLen     = Math.ceil((decoded.duration / speed) * SR);
      var off        = new OfflineAudioCtx(1, newLen, SR);
      var src        = off.createBufferSource();
      src.buffer             = decoded;
      src.playbackRate.value = speed;
      src.connect(off.destination);
      src.start(0);
      safeClose(ac);
      return off.startRendering();
    })
    .then(function (rendered) {
      // Normalize if enabled
      var normalEl = $('normalizeAudio');
      if (normalEl && normalEl.checked) {
        var ch = rendered.getChannelData(0);
        var peak = 0;
        for (var i = 0; i < ch.length; i++) { var a = Math.abs(ch[i]); if (a > peak) peak = a; }
        if (peak > 0.001 && peak < 0.97) {
          var gain = 0.98 / peak;
          for (var i = 0; i < ch.length; i++) ch[i] *= gain;
        }
      }
      return { wav: bufToWav(rendered), origDurMs: origDurMs };
    });
}

// Pitch-correct: reverse the speed-up after extraction
function pitchCorrect(wavBytes, speed) {
  var ac = new AudioCtx();
  var buf = wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength);

  return decodeAudio(ac, buf)
    .then(function (decoded) {
      var origSamples = Math.ceil(decoded.duration * speed * decoded.sampleRate);
      var off = new OfflineAudioCtx(1, origSamples, decoded.sampleRate);
      var src = off.createBufferSource();
      src.buffer             = decoded;
      src.playbackRate.value = 1 / speed;
      src.connect(off.destination);
      src.start(0);
      safeClose(ac);
      return off.startRendering();
    })
    .then(function (rendered) {
      return bufToWav(rendered);
    })
    ['catch'](function () {
      safeClose(ac);
      return wavBytes; // fallback: return unchanged
    });
}

function bufToWav(buf) {
  var ch  = buf.getChannelData(0);
  var sr  = buf.sampleRate;
  var ns  = ch.length;
  var out = new ArrayBuffer(44 + ns * 2);
  var v   = new DataView(out);
  var ws  = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

  ws(0, 'RIFF'); v.setUint32(4, 36 + ns * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, ns * 2, true);

  var off = 44;
  for (var i = 0; i < ns; i++) {
    var x = Math.max(-1, Math.min(1, ch[i]));
    v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
    off += 2;
  }
  return new Uint8Array(out);
}

// ── Header / payload ──────────────────────────────────────────
// Layout: 0-3 magic | 4-7 dataLen | 8-11 speedX1k | 12-15 origDurMs | 16 bpc | 17-19 reserved
function buildPayload(wav, speedX1000, origDurMs, bpc) {
  var p  = new Uint8Array(HEADER_BYTES + wav.length);
  var dv = new DataView(p.buffer);
  MAGIC.forEach(function (b, i) { dv.setUint8(i, b); });
  dv.setUint32(4,  wav.length, false);
  dv.setUint32(8,  speedX1000, false);
  dv.setUint32(12, origDurMs,  false);
  dv.setUint8(16,  bpc);
  p.set(wav, HEADER_BYTES);
  return p;
}

// ── LSB embed ─────────────────────────────────────────────────
function lsbEmbed(data, payload, onProg, scatter, bpc) {
  bpc = bpc || 1;
  return new Promise(function (resolve) {
    var totalBits = payload.length * 8;
    var CHUNK     = 400000;
    var bit       = 0;
    var startMs   = Date.now();

    function step() {
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

// ── LSB extract ───────────────────────────────────────────────
function lsbExtract(data, numBytes, startBit, onProg, scatter, bpc) {
  bpc = bpc || 1;
  return new Promise(function (resolve) {
    var result    = new Uint8Array(numBytes);
    var totalBits = numBytes * 8;
    var CHUNK     = 400000;
    var bit       = 0;

    function step() {
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

// ── AHID sniff (auto-route encoded images to Decode tab) ──────
function sniffAHID(file) {
  return loadImageBitmap(file)
    .then(function (bmp) {
      var cv  = document.createElement('canvas');
      cv.width  = bmp.width || bmp.naturalWidth;
      cv.height = bmp.height || bmp.naturalHeight;
      var ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      return lsbExtract(data, 4, 0, function () {}, null, 1);
    })
    .then(function (hdr) {
      for (var i = 0; i < 4; i++) { if (hdr[i] !== MAGIC[i]) return false; }
      return true;
    })
    ['catch'](function () { return false; });
}

// ── Load file into decode panel ───────────────────────────────
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

// ── Capacity analysis ─────────────────────────────────────────
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

  st('encStatus', 'info', 'Analysing audio...');

  fileToArrayBuffer(gAudFile)
    .then(function (ab) { return getAudioDuration(ab); })
    ['catch'](function () { return (gAudFile.size * 8) / 128000; })
    .then(function (dur) { _finishAnalyse(dur, cap, bpc); });
}

function _finishAnalyse(dur, cap, bpc) {
  stHide('encStatus');
  var badge      = $('badge');
  var manualSpd  = getManualSpeed();
  var SR         = getOutSR();

  // ── Manual speed ──────────────────────────────────────────
  if (manualSpd !== null) {
    var wavSz    = wavEst(dur, manualSpd, SR);
    var pct      = Math.min(99, wavSz / cap * 100);
    var semitones = (12 * Math.log2(manualSpd)).toFixed(1);
    var sign      = semitones >= 0 ? '+' : '';

    if (wavSz > cap) {
      $('capFill').style.width = '100%';
      $('capFill').className   = 'cap-fill over';
      $('capVal').textContent  = 'too large at ' + manualSpd.toFixed(2) + 'x';
      badge.className = 'badge red'; badge.style.display = 'block';
      badge.innerHTML = '<b>Does not fit at ' + manualSpd.toFixed(2) + 'x.</b><br>'
        + 'Need: ' + fmtB(wavSz) + ' — Capacity: ' + fmtB(cap) + '<br>'
        + 'Increase speed, enlarge image, or use 2-bit mode in Settings.';
      $('encBtn').disabled = true;
      return;
    }
    gSpeed = manualSpd; gAudDurSec = dur;
    $('capFill').style.width = pct + '%';
    $('capFill').className   = 'cap-fill ' + (pct < 65 ? 'ok' : 'warn');
    $('capVal').textContent  = fmtB(wavSz) + ' / ' + fmtB(cap);
    badge.className = 'badge' + (manualSpd <= 1.01 ? ' green' : '');
    badge.style.display = 'block';
    badge.innerHTML = manualSpd <= 1.01
      ? 'Manual speed: 1.0x — no pitch change. Fits fine.'
      : 'Manual speed: <b>' + manualSpd.toFixed(2) + 'x</b> — '
        + 'Pitch: <b>' + sign + semitones + ' semitones</b><br>'
        + fmtT(dur * 1000) + ' → ' + fmtT(dur / manualSpd * 1000) + ' — ' + fmtB(wavSz);
    $('encBtn').disabled = false;
    return;
  }

  // ── Auto speed ────────────────────────────────────────────
  var speed = pickSpeed(dur, cap);
  if (!speed) {
    var neededPx = Math.ceil((wavEst(dur, 1.0, SR) + HEADER_BYTES) * 8 / (3 * bpc));
    var sugSide  = Math.ceil(Math.sqrt(neededPx));
    $('capFill').style.width = '100%';
    $('capFill').className   = 'cap-fill over';
    $('capVal').textContent  = 'too small';
    badge.className = 'badge red'; badge.style.display = 'block';
    badge.innerHTML = '<b>Will not fit even at ' + SPEEDS[SPEEDS.length - 1] + 'x speed.</b><br>'
      + 'Capacity: ' + fmtB(cap) + '<br>'
      + '<span class="sug-link" onclick="applySuggestedSize(' + sugSide + ',' + sugSide + ')">Use minimum size: ' + sugSide + 'x' + sugSide + 'px</span>'
      + ' — or lower sample rate / try 2-bit in Settings.';
    $('encBtn').disabled = true;
    return;
  }

  gSpeed = speed; gAudDurSec = dur;
  var wavSz    = wavEst(dur, speed, SR);
  var pct      = Math.min(99, wavSz / cap * 100);
  var semitones = (12 * Math.log2(speed)).toFixed(1);
  var sign      = semitones >= 0 ? '+' : '';

  $('capFill').style.width = pct + '%';
  $('capFill').className   = 'cap-fill ' + (pct < 65 ? 'ok' : 'warn');
  $('capVal').textContent  = fmtB(wavSz) + ' / ' + fmtB(cap);

  if (speed === 1.0) {
    badge.className = 'badge green'; badge.style.display = 'block';
    badge.innerHTML = 'Fits at 1.0x speed — no pitch change.';
  } else {
    var neededPx = Math.ceil((wavEst(dur, 1.0, SR) + HEADER_BYTES) * 8 / (3 * bpc));
    var sugSide  = Math.ceil(Math.sqrt(neededPx));
    badge.className = 'badge'; badge.style.display = 'block';
    badge.innerHTML = 'Auto speed: <b>' + speed + 'x</b> — Pitch: <b>' + sign + semitones + ' semitones</b><br>'
      + fmtT(dur * 1000) + ' → ' + fmtT(dur / speed * 1000) + ' — ' + fmtB(wavSz) + '<br>'
      + '<span class="sug-link" onclick="applySuggestedSize(' + sugSide + ',' + sugSide + ')">Resize to ' + sugSide + 'x' + sugSide + ' for no pitch shift</span>';
  }
  $('encBtn').disabled = false;
}

// ── ENCODE ────────────────────────────────────────────────────
function doEncode() {
  if (!gImgFile || !gAudFile || gSpeed === null) {
    st('encStatus', 'err', 'Missing files or no valid speed. Check image and audio.'); return;
  }

  var btn = $('encBtn');
  btn.disabled = true;
  stHide('encStatus');
  $('encProg').style.display = 'block';
  var iosNote = $('iosNote'); if (iosNote) iosNote.style.display = 'none';

  var bmp, rW, rH, cv, ctx, imgData, bpc, payload, scatter;

  prog('encFill', 'encLbl', 'encPct', 5, 'Loading image...');
  st('encStatus', 'info', 'Loading image...');

  loadImageBitmap(gImgFile)
    .then(function (b) {
      bmp = b;
      rW  = parseInt($('rW').value, 10) || (bmp.width || bmp.naturalWidth);
      rH  = parseInt($('rH').value, 10) || (bmp.height || bmp.naturalHeight);
      cv  = document.createElement('canvas');
      cv.width = rW; cv.height = rH;
      ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0, rW, rH);

      // Optional JPEG pre-compress
      if ($('compressEnabled').checked) {
        var quality = Math.max(0.01, Math.min(1.0, (parseInt($('compressQuality').value, 10) || 75) / 100));
        st('encStatus', 'info', 'Pre-compressing at quality ' + Math.round(quality * 100) + '%...');
        prog('encFill', 'encLbl', 'encPct', 8, 'Compressing...');

        return new Promise(function (res, rej) { cv.toBlob(function (b) { b ? res(b) : rej(new Error('JPEG failed')); }, 'image/jpeg', quality); })
          .then(function (jpegBlob) {
            return new Promise(function (res, rej) {
              var img = new Image();
              var url = URL.createObjectURL(jpegBlob);
              img.onload = function () { ctx.clearRect(0, 0, rW, rH); ctx.drawImage(img, 0, 0, rW, rH); URL.revokeObjectURL(url); res(); };
              img.onerror = function () { rej(new Error('Compressed image reload failed')); };
              img.src = url;
            });
          });
      }
    })
    .then(function () {
      imgData = ctx.getImageData(0, 0, rW, rH);
      bpc     = getLsbDepth();
      var totalCap = Math.floor(rW * rH * 3 * bpc / 8);

      st('encStatus', 'info', gSpeed > 1 ? 'Processing audio at ' + gSpeed + 'x...' : 'Processing audio...');
      prog('encFill', 'encLbl', 'encPct', 12, 'Processing audio...');

      return fileToArrayBuffer(gAudFile);
    })
    .then(function (ab) { return processAudio(ab, gSpeed); })
    .then(function (result) {
      var wav = result.wav, origDurMs = result.origDurMs;
      prog('encFill', 'encLbl', 'encPct', 30, 'Building payload...');
      payload = buildPayload(wav, Math.round(gSpeed * 1000), origDurMs, bpc);

      var totalCap = Math.floor(rW * rH * 3 * bpc / 8);
      if (payload.length > totalCap) throw new Error('Payload (' + fmtB(payload.length) + ') exceeds capacity (' + fmtB(totalCap) + ').');

      scatter = getScatter(rW * rH * 3);
      st('encStatus', 'info', scatter ? 'Scatter-encoding (passkey active)...' : 'Encoding into pixels (' + bpc + '-bit mode)...');

      var encStart = Date.now();
      return lsbEmbed(imgData.data, payload, function (p, startMs) {
        var pct = 30 + p * 62, eta = '';
        if (p > 0.03 && p < 0.97) {
          var elapsed = Date.now() - encStart;
          eta = ' (~' + fmtEta((elapsed / p) * (1 - p)) + ')';
        }
        prog('encFill', 'encLbl', 'encPct', pct, 'Encoding ' + Math.round(pct) + '%' + eta);
      }, scatter, bpc);
    })
    .then(function () {
      prog('encFill', 'encLbl', 'encPct', 93, 'Saving PNG...');
      ctx.putImageData(imgData, 0, 0);
      return new Promise(function (resolve, reject) {
        cv.toBlob(function (blob) {
          if (!blob) { reject(new Error('toBlob returned null — canvas may be tainted')); return; }
          gLastBlobSize = blob.size;
          triggerDownload(blob, 'audiohide_' + gImgFile.name.replace(/\.[^.]+$/, '') + '.png');
          resolve();
        }, 'image/png');
      });
    })
    .then(function () {
      prog('encFill', 'encLbl', 'encPct', 100, 'Done!');
      var note = ' Speed: ' + (gSpeed > 1 ? gSpeed + 'x.' : '1.0x (no pitch change).')
        + ' Output: ' + fmtB(gLastBlobSize) + '.'
        + ' Mode: ' + bpc + '-bit LSB.'
        + (scatter ? ' Passkey: ON.' : '');
      st('encStatus', 'ok', 'Done. Image downloaded.' + note);
      btn.disabled = false;
    })
    ['catch'](function (e) {
      st('encStatus', 'err', 'Error: ' + (e && e.message ? e.message : String(e)));
      btn.disabled = false;
    });
}

// ── DECODE ────────────────────────────────────────────────────
function doDecode() {
  if (!gDecFile) return;
  var btn = $('decBtn');
  btn.disabled = true;
  stHide('decStatus');
  $('audioWrap').style.display = 'none';
  $('infoCard').style.display  = 'none';
  $('decProg').style.display   = 'block';

  var speed, bpc, scatter;

  st('decStatus', 'info', 'Loading image...');

  loadImageBitmap(gDecFile)
    .then(function (bmp) {
      var cv    = document.createElement('canvas');
      cv.width  = bmp.width || bmp.naturalWidth;
      cv.height = bmp.height || bmp.naturalHeight;
      var ctx   = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var data  = ctx.getImageData(0, 0, cv.width, cv.height).data;

      var decKey  = $('decPasskey') ? $('decPasskey').value.trim() : '';
      var totalCh = cv.width * cv.height * 3;
      scatter     = decKey ? buildScatterMap(decKey, totalCh) : null;

      prog('decFill', 'decLbl', 'decPct', 5, 'Reading header...');
      return lsbExtract(data, HEADER_BYTES, 0, function () {}, scatter, 1)
        .then(function (hdrBytes) {
          var hv = new DataView(hdrBytes.buffer);
          for (var i = 0; i < 4; i++) {
            if (hdrBytes[i] !== MAGIC[i]) throw new Error('NOAHID');
          }
          var dataLen   = hv.getUint32(4,  false);
          var speedX1k  = hv.getUint32(8,  false);
          var origDurMs = hv.getUint32(12, false);
          bpc   = hv.getUint8(16) || 1;
          speed = speedX1k / 1000;
          var encDurMs  = Math.round(origDurMs / speed);

          if (dataLen === 0 || dataLen > 400 * 1024 * 1024) throw new Error('BADHDR');

          st('decStatus', 'info', 'Extracting ' + fmtB(dataLen) + '...');
          prog('decFill', 'decLbl', 'decPct', 10, 'Extracting bits...');

          var decStart = Date.now();
          return lsbExtract(data, dataLen, HEADER_BYTES * 8, function (p) {
            var pct = 10 + p * 75, eta = '';
            if (p > 0.03 && p < 0.97) {
              var elapsed = Date.now() - decStart;
              eta = ' (~' + fmtEta((elapsed / p) * (1 - p)) + ')';
            }
            prog('decFill', 'decLbl', 'decPct', pct, 'Extracting ' + Math.round(pct) + '%' + eta);
          }, scatter, bpc)
            .then(function (audioBytes) {
              return { audioBytes: audioBytes, dataLen: dataLen, origDurMs: origDurMs, encDurMs: encDurMs };
            });
        });
    })
    .then(function (r) {
      $('iSize').textContent  = fmtB(r.dataLen);
      $('iSpeed').textContent = speed.toFixed(2) + 'x';
      $('iOrig').textContent  = fmtT(r.origDurMs);
      $('iEnc').textContent   = fmtT(r.encDurMs);
      $('iBpc').textContent   = bpc + '-bit LSB';

      var note = $('iNote');
      if (speed <= 1.01) {
        note.innerHTML = '<b>No speed adjustment</b> — plays at original speed and pitch.';
      } else {
        var semi = (12 * Math.log2(speed)).toFixed(1);
        note.innerHTML = '<b>Encoded at ' + speed.toFixed(2) + 'x speed (' + (semi > 0 ? '+' : '') + semi + ' semitones).</b><br>'
          + 'Stored: ' + fmtT(r.encDurMs) + ' — Original: ' + fmtT(r.origDurMs) + '.';
      }
      $('infoCard').style.display = 'block';

      var doPitch = $('pitchCorrect') && $('pitchCorrect').checked && speed > 1.01;
      if (doPitch) {
        prog('decFill', 'decLbl', 'decPct', 88, 'Pitch correcting...');
        st('decStatus', 'info', 'Restoring original pitch and speed...');
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
      prog('decFill', 'decLbl', 'decPct', 100, 'Done!');
      st('decStatus', 'ok', 'Extracted ' + fmtB(r.dataLen) + '.' + (r.pitched ? ' Pitch corrected.' : ' Press play to listen.'));
      btn.disabled = false;
    })
    ['catch'](function (e) {
      if (e && e.message === 'NOAHID') {
        st('decStatus', 'err', 'No AudioHide data found. Causes: not an AudioHide image, re-saved as JPEG, or wrong passkey.');
      } else if (e && e.message === 'BADHDR') {
        st('decStatus', 'err', 'Header invalid — image may have been edited or re-encoded after hiding.');
      } else {
        st('decStatus', 'err', 'Error: ' + (e && e.message ? e.message : String(e)));
      }
      btn.disabled = false;
    });
}

// ── Download extracted audio ──────────────────────────────────
function dlAudio() {
  if (!gExtracted) return;
  triggerDownload(gExtracted, 'audiohide_extracted.wav');
}

// ── Resize controls ───────────────────────────────────────────
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

// ── Wire up drop zones ────────────────────────────────────────
setupDrop('imgDrop', 'imgInput', function (f) {
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
    p.src = URL.createObjectURL(f);
    p.style.display              = 'block';
    $('encBtn').disabled         = true;
    $('badge').style.display     = 'none';
    gSpeed = null;

    var img = new Image();
    img.onload = function () {
      gOrigW = img.width; gOrigH = img.height;
      $('rW').value               = gOrigW;
      $('rH').value               = gOrigH;
      $('rScale').value           = 100;
      $('origDims').textContent   = gOrigW + ' x ' + gOrigH + ' px';
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

// ── Startup checks ────────────────────────────────────────────
(function () {
  // Warn if AudioContext not available (very old browser)
  if (!AudioCtx) {
    var w = $('compatWarn');
    if (w) {
      w.style.display = 'block';
      w.textContent   = 'Your browser does not support Web Audio. Please update to a modern browser.';
    }
  }
  // Mobile: tweak drop zone hint text to "Tap to select"
  if (IS_MOBILE) {
    var hints = document.querySelectorAll('.dz-hint');
    for (var i = 0; i < hints.length; i++) hints[i].textContent = 'Tap to select a file';
  }
})();