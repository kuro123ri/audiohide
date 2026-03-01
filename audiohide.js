// ── Constants ─────────────────────────────────────────────────
const MAGIC        = [0x41, 0x48, 0x49, 0x44]; // "AHID"
const HEADER_BYTES = 20; // 4 magic + 4 dataLen + 4 speedX1k + 4 origDurMs + 1 bpc + 3 reserved
const SPEEDS       = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0];
const SCATTER_SEG  = 1024; // channels per scatter segment

// ── State ─────────────────────────────────────────────────────
let gImgFile      = null;
let gAudFile      = null;
let gDecFile      = null;
let gExtracted    = null;   // Blob for download
let gSpeed        = null;   // chosen speed
let gAudDurSec    = null;   // original audio duration
let gLastBlobSize = 0;      // actual output PNG size
let gOrigW        = null;
let gOrigH        = null;
let gAspectLock   = true;

// ── Helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmtB = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB';
const fmtT = ms => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };

function fmtEta(ms) {
  const s = Math.round(ms / 1000);
  if (s < 2)  return 'almost done';
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

// ── UI helpers ────────────────────────────────────────────────
function st(id, cls, msg) {
  const el = $(id);
  el.className  = 'status ' + cls;
  el.textContent = msg;
  el.style.display = 'block';
}
function stHide(id) { $(id).style.display = 'none'; }

function prog(fillId, lblId, pctId, pct, label) {
  $(fillId).style.width   = Math.min(pct, 100) + '%';
  $(lblId).textContent    = label;
  $(pctId).textContent    = Math.round(pct) + '%';
}

// ── Settings accessors ────────────────────────────────────────
function getOutSR() {
  const el = $('sampleRate');
  return el ? (parseInt(el.value) || 22050) : 22050;
}

function getManualSpeed() {
  if ($('speedMode') && $('speedMode').value === 'manual') {
    return parseInt($('manualSpeed').value) / 100;
  }
  return null;
}

function getLsbDepth() {
  const el = $('lsbDepth');
  return el ? (parseInt(el.value) || 1) : 1;
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
  const manual = $('speedMode').value === 'manual';
  $('manualSpeedRow').style.display = manual ? 'block' : 'none';
  if (manual) updateSemitoneNote();
  analyseCapacity();
}

function onManualSpeedSlide() {
  const v = parseInt($('manualSpeed').value) / 100;
  $('manualSpeedVal').textContent = v.toFixed(2);
  updateSemitoneNote();
  analyseCapacity();
}

function updateSemitoneNote() {
  const v = parseInt($('manualSpeed').value) / 100;
  const semitones = (12 * Math.log2(v)).toFixed(1);
  const sign = semitones >= 0 ? '+' : '';
  $('manualSemitones').textContent = v === 1
    ? 'No pitch change at 1.0x'
    : 'Pitch shift: ' + sign + semitones + ' semitones';
}

function onPasskeyToggle() {
  const on = $('passkeyEnabled').checked;
  $('passkeyRow').style.display    = on ? 'block' : 'none';
  $('decPasskeyRow').style.display = on ? 'block' : 'none';
}

// ── Tabs ──────────────────────────────────────────────────────
function switchTab(t) {
  ['enc', 'dec'].forEach(x => {
    $('tab-' + x).classList.toggle('active', x === t);
    $('panel-' + x).classList.toggle('active', x === t);
  });
}

// ── Scatter (keyed pseudo-random channel permutation) ─────────
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashKey(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

// Segment-level Fisher-Yates shuffle seeded from key.
// Returns fn(channelIndex) -> shuffledChannelIndex.
function buildScatterMap(key, availChannels) {
  const segCount = Math.ceil(availChannels / SCATTER_SEG);
  const order    = new Uint32Array(segCount);
  for (let i = 0; i < segCount; i++) order[i] = i;

  const rand = mulberry32(hashKey(key));
  for (let i = segCount - 1; i > 0; i--) {
    const j   = Math.floor(rand() * (i + 1));
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }

  return function (chIdx) {
    const seg = (chIdx / SCATTER_SEG) | 0;
    const off = chIdx % SCATTER_SEG;
    const ch  = order[seg] * SCATTER_SEG + off;
    return ch < availChannels ? ch : chIdx; // safety fallback
  };
}

function getScatter(totalChannels) {
  if (!$('passkeyEnabled') || !$('passkeyEnabled').checked) return null;
  const key = $('passkeyInput').value.trim();
  if (!key) return null;
  return buildScatterMap(key, totalChannels);
}

// ── Drop zones ────────────────────────────────────────────────
function setupDrop(dropId, inputId, cb) {
  const el = $(dropId);
  el.addEventListener('dragover',  e => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', ()  => el.classList.remove('over'));
  el.addEventListener('drop', e => {
    e.preventDefault(); el.classList.remove('over');
    const f = e.dataTransfer.files[0]; if (f) cb(f);
  });
  $(inputId).addEventListener('change', e => {
    const f = e.target.files[0]; if (f) cb(f);
  });
}

// ── Capacity & audio math ─────────────────────────────────────
// bpc = bits per channel (1 or 2). Reads from setting if not provided.
function pixelCap(w, h, bpc) {
  bpc = bpc !== undefined ? bpc : getLsbDepth();
  return Math.floor(w * h * 3 * bpc / 8) - HEADER_BYTES;
}

function wavEst(durSec, speed, sr) {
  const rate = sr !== undefined ? sr : getOutSR();
  return Math.ceil((durSec / speed) * rate) * 2 + 44;
}

function pickSpeed(durSec, cap) {
  for (const s of SPEEDS) {
    if (wavEst(durSec, s) <= cap) return s;
  }
  return null;
}

// ── Audio processing ──────────────────────────────────────────
async function getAudioDuration(arrayBuffer) {
  const ac = new AudioContext();
  try {
    const decoded = await ac.decodeAudioData(arrayBuffer.slice(0));
    const dur = decoded.duration;
    await ac.close();
    return dur;
  } catch (e) {
    await ac.close();
    throw e;
  }
}

async function processAudio(arrayBuffer, speed) {
  const SR = getOutSR();
  const ac = new AudioContext();
  let decoded;
  try {
    decoded = await ac.decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    await ac.close();
    throw new Error('Could not decode audio: ' + e.message);
  }

  const origDurMs = Math.round(decoded.duration * 1000);
  const newLen    = Math.ceil((decoded.duration / speed) * SR);

  const off = new OfflineAudioContext(1, newLen, SR);
  const src = off.createBufferSource();
  src.buffer             = decoded;
  src.playbackRate.value = speed;
  src.connect(off.destination);
  src.start(0);

  const rendered = await off.startRendering();
  await ac.close();

  // Normalize: boost audio to 98% of peak if enabled
  if ($('normalizeAudio') && $('normalizeAudio').checked) {
    const ch = rendered.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
    if (peak > 0.001 && peak < 0.97) {
      const gain = 0.98 / peak;
      for (let i = 0; i < ch.length; i++) ch[i] *= gain;
    }
  }

  return { wav: bufToWav(rendered), origDurMs };
}

// Reverse speed-up: slow audio back to original pitch + duration.
async function pitchCorrect(wavBytes, speed) {
  const ac = new AudioContext();
  let decoded;
  try {
    const buf = wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength);
    decoded = await ac.decodeAudioData(buf);
  } catch (e) {
    await ac.close();
    return wavBytes; // fallback: return unchanged on error
  }

  // Output length = stored duration * speed * sampleRate = original duration * sampleRate
  const origSamples = Math.ceil(decoded.duration * speed * decoded.sampleRate);
  const off = new OfflineAudioContext(1, origSamples, decoded.sampleRate);
  const src = off.createBufferSource();
  src.buffer             = decoded;
  src.playbackRate.value = 1 / speed; // undo the speed-up
  src.connect(off.destination);
  src.start(0);

  const rendered = await off.startRendering();
  await ac.close();
  return bufToWav(rendered);
}

function bufToWav(buf) {
  const ch  = buf.getChannelData(0);
  const sr  = buf.sampleRate;
  const ns  = ch.length;
  const out = new ArrayBuffer(44 + ns * 2);
  const v   = new DataView(out);
  const ws  = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

  ws(0, 'RIFF'); v.setUint32(4, 36 + ns * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, ns * 2, true);

  let off = 44;
  for (let i = 0; i < ns; i++) {
    const x = Math.max(-1, Math.min(1, ch[i]));
    v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
    off += 2;
  }
  return new Uint8Array(out);
}

// ── Header builder ────────────────────────────────────────────
// Byte layout: 0-3 magic, 4-7 dataLen, 8-11 speedX1k, 12-15 origDurMs,
//              16 bitsPerChannel, 17-19 reserved
function buildPayload(wav, speedX1000, origDurMs, bpc) {
  const p  = new Uint8Array(HEADER_BYTES + wav.length);
  const dv = new DataView(p.buffer);
  MAGIC.forEach((b, i) => dv.setUint8(i, b));
  dv.setUint32(4,  wav.length, false);
  dv.setUint32(8,  speedX1000, false);
  dv.setUint32(12, origDurMs,  false);
  dv.setUint8(16,  bpc);       // 1 or 2; 0 = legacy (treated as 1)
  p.set(wav, HEADER_BYTES);
  return p;
}

// ── LSB embed ─────────────────────────────────────────────────
// bpc=1: 1 bit per channel (LSB). bpc=2: 2 bits per channel (2 LSBs).
// scatter: optional fn(channelIndex) -> shuffledChannelIndex.
// onProg: fn(progress 0..1, startMs) called every chunk.
function lsbEmbed(data, payload, onProg, scatter, bpc) {
  bpc = bpc || 1;
  return new Promise(resolve => {
    const totalBits = payload.length * 8;
    const CHUNK     = 400000;
    let bit = 0;
    const startMs = Date.now();

    function step() {
      const end = Math.min(bit + CHUNK, totalBits);
      for (let i = bit; i < end; i++) {
        const b      = (payload[i >> 3] >> (7 - (i & 7))) & 1;
        const chIdx  = Math.floor(i / bpc);
        const bitPos = i % bpc;                     // 0 = LSB, 1 = second bit
        const ch     = scatter ? scatter(chIdx) : chIdx;
        const pixel  = Math.floor(ch / 3);
        const chan   = ch % 3;
        const di     = pixel * 4 + chan;
        const mask   = ~(1 << bitPos) & 0xFF;
        data[di]     = (data[di] & mask) | (b << bitPos);
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
// startBit: absolute bit-sequence offset to begin reading from.
function lsbExtract(data, numBytes, startBit, onProg, scatter, bpc) {
  bpc = bpc || 1;
  return new Promise(resolve => {
    const result    = new Uint8Array(numBytes);
    const totalBits = numBytes * 8;
    const CHUNK     = 400000;
    let bit = 0;

    function step() {
      const end = Math.min(bit + CHUNK, totalBits);
      for (let i = bit; i < end; i++) {
        const absBit = startBit + i;
        const chIdx  = Math.floor(absBit / bpc);
        const bitPos = absBit % bpc;
        const ch     = scatter ? scatter(chIdx) : chIdx;
        const pixel  = Math.floor(ch / 3);
        const chan   = ch % 3;
        const di     = pixel * 4 + chan;
        const b      = (data[di] >> bitPos) & 1;
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

// ── Sniff for AHID magic (1-bit, no scatter) ──────────────────
// Used to auto-route encoded images dropped on encode zone to decode tab.
async function sniffAHID(file) {
  try {
    const bmp = await createImageBitmap(file);
    const cv  = document.createElement('canvas');
    cv.width  = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    // Read first 4 bytes using 1-bit mode, no scatter
    const hdr = await lsbExtract(data, 4, 0, () => {}, null, 1);
    for (let i = 0; i < 4; i++) {
      if (hdr[i] !== MAGIC[i]) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ── Load file into decode panel ───────────────────────────────
function loadDecodeFile(f) {
  gDecFile = f;
  $('decFileLbl').textContent  = f.name + ' - ' + fmtB(f.size);
  const p = $('decPrev');
  p.src = URL.createObjectURL(f);
  p.style.display              = 'block';
  $('decBtn').disabled         = false;
  $('audioWrap').style.display = 'none';
  $('infoCard').style.display  = 'none';
  $('decProg').style.display   = 'none';
  stHide('decStatus');
}

// ── Capacity analysis ─────────────────────────────────────────
let _capDebounce = null;
function analyseCapacity() {
  clearTimeout(_capDebounce);
  _capDebounce = setTimeout(_doAnalyse, 120);
}

async function _doAnalyse() {
  gSpeed = null;
  gAudDurSec = null;
  $('encBtn').disabled = true;

  if (!gImgFile || !gOrigW || !gOrigH) return;

  const rW  = Math.max(1, parseInt($('rW').value) || gOrigW);
  const rH  = Math.max(1, parseInt($('rH').value) || gOrigH);
  const bpc = getLsbDepth();
  const cap = Math.floor(rW * rH * 3 * bpc / 8) - HEADER_BYTES;

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

  let dur;
  try {
    const ab = await gAudFile.arrayBuffer();
    dur = await getAudioDuration(ab);
  } catch (e) {
    dur = (gAudFile.size * 8) / 128000;
  }

  stHide('encStatus');

  const badge     = $('badge');
  const manualSpd = getManualSpeed();
  const SR        = getOutSR();

  // ── Manual speed mode ──────────────────────────────────────
  if (manualSpd !== null) {
    const wavSz    = wavEst(dur, manualSpd, SR);
    const pct      = Math.min(99, wavSz / cap * 100);
    const semitones = (12 * Math.log2(manualSpd)).toFixed(1);
    const sign      = semitones >= 0 ? '+' : '';

    if (wavSz > cap) {
      $('capFill').style.width = '100%';
      $('capFill').className   = 'cap-fill over';
      $('capVal').textContent  = 'too large at ' + manualSpd.toFixed(2) + 'x';
      badge.className = 'badge red';
      badge.style.display = 'block';
      badge.innerHTML = '<b>Audio does not fit at ' + manualSpd.toFixed(2) + 'x speed.</b><br>'
        + 'Needed: ' + fmtB(wavSz) + ' &nbsp;|&nbsp; Capacity: ' + fmtB(cap) + '<br>'
        + 'Increase speed, resize the image larger, or switch to 2-bit mode.';
      $('encBtn').disabled = true;
      return;
    }

    gSpeed     = manualSpd;
    gAudDurSec = dur;
    $('capFill').style.width = pct + '%';
    $('capFill').className   = 'cap-fill ' + (pct < 65 ? 'ok' : 'warn');
    $('capVal').textContent  = fmtB(wavSz) + ' / ' + fmtB(cap);
    badge.className = 'badge' + (manualSpd <= 1.01 ? ' green' : '');
    badge.style.display = 'block';
    badge.innerHTML = manualSpd <= 1.01
      ? 'Manual speed: 1.0x &mdash; no pitch change. Fits fine.'
      : 'Manual speed: <b>' + manualSpd.toFixed(2) + 'x</b> &nbsp;|&nbsp; '
        + 'Pitch: <b>' + sign + semitones + ' semitones</b><br>'
        + 'Original: ' + fmtT(dur * 1000) + ' &rarr; Encoded: ' + fmtT(dur / manualSpd * 1000)
        + ' &nbsp;|&nbsp; ' + fmtB(wavSz);
    $('encBtn').disabled = false;
    return;
  }

  // ── Auto speed mode ────────────────────────────────────────
  const speed = pickSpeed(dur, cap);

  if (!speed) {
    const minCap   = wavEst(dur, SPEEDS[SPEEDS.length - 1], SR);
    const neededPx = Math.ceil((wavEst(dur, 1.0, SR) + HEADER_BYTES) * 8 / (3 * bpc));
    const sugSide  = Math.ceil(Math.sqrt(neededPx));
    $('capFill').style.width = '100%';
    $('capFill').className   = 'cap-fill over';
    $('capVal').textContent  = 'too small';
    badge.className = 'badge red';
    badge.style.display = 'block';
    badge.innerHTML = '<b>Will not fit even at ' + SPEEDS[SPEEDS.length - 1] + 'x speed.</b><br>'
      + 'Min needed: ' + fmtB(minCap) + ' &nbsp;|&nbsp; Current capacity: ' + fmtB(cap) + '<br>'
      + '<span class="sug-link" onclick="applySuggestedSize(' + sugSide + ',' + sugSide + ')">Apply minimum size: ' + sugSide + ' x ' + sugSide + ' px</span>'
      + ' &nbsp;or lower sample rate / switch to 2-bit in Settings.';
    $('encBtn').disabled = true;
    return;
  }

  gSpeed     = speed;
  gAudDurSec = dur;

  const wavSz    = wavEst(dur, speed, SR);
  const pct      = Math.min(99, wavSz / cap * 100);
  const semitones = (12 * Math.log2(speed)).toFixed(1);
  const sign      = semitones >= 0 ? '+' : '';

  $('capFill').style.width = pct + '%';
  $('capFill').className   = 'cap-fill ' + (pct < 65 ? 'ok' : 'warn');
  $('capVal').textContent  = fmtB(wavSz) + ' / ' + fmtB(cap);

  if (speed === 1.0) {
    badge.className = 'badge green';
    badge.style.display = 'block';
    badge.innerHTML = 'Fits at 1.0x speed &mdash; no pitch change.';
  } else {
    const neededPx = Math.ceil((wavEst(dur, 1.0, SR) + HEADER_BYTES) * 8 / (3 * bpc));
    const sugSide  = Math.ceil(Math.sqrt(neededPx));
    badge.className = 'badge';
    badge.style.display = 'block';
    badge.innerHTML = 'Auto speed: <b>' + speed + 'x</b> &nbsp;|&nbsp; '
      + 'Pitch: <b>' + sign + semitones + ' semitones</b><br>'
      + 'Original: ' + fmtT(dur * 1000) + ' &rarr; Encoded: ' + fmtT(dur / speed * 1000)
      + ' &nbsp;|&nbsp; ' + fmtB(wavSz) + '<br>'
      + '<span class="sug-link" onclick="applySuggestedSize(' + sugSide + ',' + sugSide + ')">Resize to ' + sugSide + ' x ' + sugSide + ' px for 1x (no pitch shift)</span>';
  }

  $('encBtn').disabled = false;
}

// ── ENCODE ────────────────────────────────────────────────────
async function doEncode() {
  if (!gImgFile || !gAudFile) return;
  if (gSpeed === null) {
    st('encStatus', 'err', 'No valid speed found. Please check your image and audio files.');
    return;
  }

  const btn = $('encBtn');
  btn.disabled = true;
  stHide('encStatus');
  $('encProg').style.display = 'block';

  try {
    // Step 1: Load image
    st('encStatus', 'info', 'Loading image...');
    prog('encFill', 'encLbl', 'encPct', 5, 'Loading image...');

    const bmp = await createImageBitmap(gImgFile);
    const cv  = document.createElement('canvas');
    const rW  = parseInt($('rW').value) || bmp.width;
    const rH  = parseInt($('rH').value) || bmp.height;
    cv.width  = rW;
    cv.height = rH;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, rW, rH);

    // Step 2 (optional): pre-compress via JPEG pass
    const doCompress = $('compressEnabled').checked;
    if (doCompress) {
      const quality = Math.max(0.01, Math.min(1.0, (parseInt($('compressQuality').value) || 75) / 100));
      st('encStatus', 'info', 'Pre-compressing image at quality ' + Math.round(quality * 100) + '%...');
      prog('encFill', 'encLbl', 'encPct', 8, 'Compressing...');

      const jpegBlob = await new Promise((res, rej) => {
        cv.toBlob(b => b ? res(b) : rej(new Error('JPEG conversion failed')), 'image/jpeg', quality);
      });
      await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, rW, rH);
          ctx.drawImage(img, 0, 0, rW, rH);
          URL.revokeObjectURL(img.src);
          res();
        };
        img.onerror = () => rej(new Error('Failed to load compressed image back'));
        img.src = URL.createObjectURL(jpegBlob);
      });
    }

    const imgData   = ctx.getImageData(0, 0, cv.width, cv.height);
    const bpc       = getLsbDepth();
    const totalCap  = Math.floor(rW * rH * 3 * bpc / 8);

    // Step 3: Process audio
    st('encStatus', 'info', gSpeed > 1 ? 'Processing audio at ' + gSpeed + 'x speed...' : 'Processing audio...');
    prog('encFill', 'encLbl', 'encPct', 12, 'Processing audio...');

    const ab = await gAudFile.arrayBuffer();
    const { wav, origDurMs } = await processAudio(ab, gSpeed);

    prog('encFill', 'encLbl', 'encPct', 30, 'Building payload...');

    // Step 4: Build payload with bpc stored in header
    const payload = buildPayload(wav, Math.round(gSpeed * 1000), origDurMs, bpc);

    if (payload.length > totalCap) {
      st('encStatus', 'err',
        'Payload (' + fmtB(payload.length) + ') exceeds image capacity (' + fmtB(totalCap) + '). Use a larger image.');
      btn.disabled = false;
      return;
    }

    // Step 5: LSB encode with scatter + ETA
    const totalChannels = rW * rH * 3;
    const scatter = getScatter(totalChannels);
    st('encStatus', 'info', scatter
      ? 'Scatter-encoding into pixels (passkey active)...'
      : 'Encoding audio into pixels (' + bpc + '-bit mode)...');

    const encStart = Date.now();
    await lsbEmbed(imgData.data, payload, (p, startMs) => {
      const pct = 30 + p * 62;
      let eta   = '';
      if (p > 0.03 && p < 0.97) {
        const elapsed = Date.now() - encStart;
        const rem     = (elapsed / p) * (1 - p);
        eta = ' (~' + fmtEta(rem) + ')';
      }
      prog('encFill', 'encLbl', 'encPct', pct, 'Encoding... ' + Math.round(pct) + '%' + eta);
    }, scatter, bpc);

    // Step 6: Export PNG
    prog('encFill', 'encLbl', 'encPct', 93, 'Saving PNG...');
    ctx.putImageData(imgData, 0, 0);

    await new Promise((resolve, reject) => {
      cv.toBlob(blob => {
        if (!blob) { reject(new Error('toBlob returned null - canvas may be tainted.')); return; }
        try {
          gLastBlobSize = blob.size;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'audiohide_' + gImgFile.name.replace(/\.[^.]+$/, '') + '.png';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          resolve();
        } catch (e) { reject(e); }
      }, 'image/png');
    });

    prog('encFill', 'encLbl', 'encPct', 100, 'Done!');
    const speedNote   = gSpeed > 1 ? ' Speed: ' + gSpeed + 'x.' : ' Speed: 1.0x (no pitch change).';
    const sizeNote    = ' Output PNG: ' + fmtB(gLastBlobSize) + '.';
    const modeNote    = ' Mode: ' + bpc + '-bit LSB.';
    const scatterNote = scatter ? ' Passkey scatter: ON.' : '';
    st('encStatus', 'ok', 'Done. Image downloaded.' + speedNote + sizeNote + modeNote + scatterNote);
    btn.disabled = false;

  } catch (e) {
    st('encStatus', 'err', 'Error: ' + (e && e.message ? e.message : String(e)));
    btn.disabled = false;
  }
}

// ── DECODE ────────────────────────────────────────────────────
async function doDecode() {
  if (!gDecFile) return;

  const btn = $('decBtn');
  btn.disabled = true;
  stHide('decStatus');
  $('audioWrap').style.display = 'none';
  $('infoCard').style.display  = 'none';
  $('decProg').style.display   = 'block';

  try {
    // Step 1: Load image
    st('decStatus', 'info', 'Loading image...');
    const bmp = await createImageBitmap(gDecFile);
    const cv  = document.createElement('canvas');
    cv.width  = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;

    const decKey    = $('decPasskey') ? $('decPasskey').value.trim() : '';
    const totalCh   = cv.width * cv.height * 3;
    const scatter   = decKey ? buildScatterMap(decKey, totalCh) : null;

    // Step 2: Read header (always 1-bit for header so bpc field can be read first)
    prog('decFill', 'decLbl', 'decPct', 5, 'Reading header...');
    const hdrBytes = await lsbExtract(data, HEADER_BYTES, 0, () => {}, scatter, 1);
    const hv       = new DataView(hdrBytes.buffer);

    // Check magic
    for (let i = 0; i < 4; i++) {
      if (hdrBytes[i] !== MAGIC[i]) {
        st('decStatus', 'err',
          'No AudioHide data found. Possible causes: not an AudioHide image, re-saved as JPEG, or wrong passkey.');
        btn.disabled = false;
        return;
      }
    }

    const dataLen   = hv.getUint32(4,  false);
    const speedX1k  = hv.getUint32(8,  false);
    const origDurMs = hv.getUint32(12, false);
    const bpc       = hv.getUint8(16) || 1;  // 0 = legacy = 1-bit
    const speed     = speedX1k / 1000;
    const encDurMs  = Math.round(origDurMs / speed);

    if (dataLen === 0 || dataLen > 400 * 1024 * 1024) {
      st('decStatus', 'err',
        'Header values look invalid. The image may have been modified after hiding.');
      btn.disabled = false;
      return;
    }

    // Step 3: Extract audio bytes
    st('decStatus', 'info', 'Extracting ' + fmtB(dataLen) + ' of audio...');
    prog('decFill', 'decLbl', 'decPct', 10, 'Extracting bits...');

    // Audio starts after header: header used HEADER_BYTES*8 bits in 1-bit space,
    // so startBit = HEADER_BYTES*8 regardless of bpc (bit-sequence indexing is consistent)
    const decStart  = Date.now();
    const audioBytes = await lsbExtract(data, dataLen, HEADER_BYTES * 8, p => {
      const pct = 10 + p * 75;
      let eta   = '';
      if (p > 0.03 && p < 0.97) {
        const elapsed = Date.now() - decStart;
        const rem     = (elapsed / p) * (1 - p);
        eta = ' (~' + fmtEta(rem) + ')';
      }
      prog('decFill', 'decLbl', 'decPct', pct, 'Extracting... ' + Math.round(pct) + '%' + eta);
    }, scatter, bpc);

    // Step 4: Populate info card
    $('iSize').textContent  = fmtB(dataLen);
    $('iSpeed').textContent = speed.toFixed(2) + 'x';
    $('iOrig').textContent  = fmtT(origDurMs);
    $('iEnc').textContent   = fmtT(encDurMs);
    $('iBpc').textContent   = bpc + '-bit LSB';

    const note = $('iNote');
    if (speed <= 1.01) {
      note.innerHTML = '<b>No speed adjustment</b> &mdash; plays at original speed and pitch.';
    } else {
      const semitones  = (12 * Math.log2(speed)).toFixed(1);
      note.innerHTML   =
        '<b>Audio was encoded at ' + speed.toFixed(2) + 'x speed (' + (semitones > 0 ? '+' : '') + semitones + ' semitones).</b><br>'
        + 'Encoded duration: ' + fmtT(encDurMs) + ' &nbsp;|&nbsp; Original: ' + fmtT(origDurMs) + '.';
    }
    $('infoCard').style.display = 'block';

    // Step 5: Pitch correct if needed + enabled
    const doPitchCorrect = $('pitchCorrect') && $('pitchCorrect').checked && speed > 1.01;
    let finalBytes = audioBytes;

    if (doPitchCorrect) {
      prog('decFill', 'decLbl', 'decPct', 88, 'Applying pitch correction...');
      st('decStatus', 'info', 'Pitch-correcting audio back to original speed...');
      finalBytes = await pitchCorrect(audioBytes, speed);
      $('iNote').innerHTML +=
        '<br><b>Pitch correction applied</b> &mdash; audio restored to original speed and pitch.';
    }

    gExtracted = new Blob([finalBytes], { type: 'audio/wav' });
    $('audioOut').src = URL.createObjectURL(gExtracted);
    $('audioWrap').style.display = 'block';

    prog('decFill', 'decLbl', 'decPct', 100, 'Done!');
    st('decStatus', 'ok',
      'Audio extracted (' + fmtB(dataLen) + ').'
      + (doPitchCorrect ? ' Pitch corrected to original.' : ' Press play to listen.'));
    btn.disabled = false;

  } catch (e) {
    st('decStatus', 'err', 'Error: ' + (e && e.message ? e.message : String(e)));
    btn.disabled = false;
  }
}

// ── Download extracted audio ──────────────────────────────────
function dlAudio() {
  if (!gExtracted) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(gExtracted);
  a.download = 'audiohide_extracted.wav';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Resize controls ───────────────────────────────────────────
function toggleLock() {
  gAspectLock = !gAspectLock;
  const btn = $('lockBtn');
  btn.textContent = gAspectLock ? 'Lock ratio: ON' : 'Lock ratio: OFF';
  btn.classList.toggle('locked', gAspectLock);
}

function updateResizeHint() {
  const w = parseInt($('rW').value) || gOrigW;
  const h = parseInt($('rH').value) || gOrigH;
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
  updateResizeHint();
  analyseCapacity();
}

function onResizeScale() {
  const pct = parseFloat($('rScale').value);
  if (!pct || !gOrigW || !gOrigH) return;
  $('rW').value = Math.max(1, Math.round(gOrigW * pct / 100));
  $('rH').value = Math.max(1, Math.round(gOrigH * pct / 100));
  updateResizeHint();
  analyseCapacity();
}

function onResizeW() {
  const w = parseInt($('rW').value);
  if (!w || !gOrigW || !gOrigH) return;
  if (gAspectLock) $('rH').value = Math.max(1, Math.round(w * gOrigH / gOrigW));
  updateResizeHint();
  analyseCapacity();
}

function onResizeH() {
  const h = parseInt($('rH').value);
  if (!h || !gOrigW || !gOrigH) return;
  if (gAspectLock) $('rW').value = Math.max(1, Math.round(h * gOrigW / gOrigH));
  updateResizeHint();
  analyseCapacity();
}

function resetResize() {
  if (!gOrigW || !gOrigH) return;
  $('rW').value     = gOrigW;
  $('rH').value     = gOrigH;
  $('rScale').value = 100;
  updateResizeHint();
  analyseCapacity();
}

function applySuggestedSize(w, h) {
  $('rW').value     = w;
  $('rH').value     = h;
  $('rScale').value = gOrigW ? Math.round(w / gOrigW * 100) : 100;
  $('newCap').textContent     = fmtB(pixelCap(w, h));
  $('estOutSize').textContent = 'approx ' + fmtB(Math.round(w * h * 3 * 0.82));
  analyseCapacity();
}

// ── Wire up drop zones ────────────────────────────────────────
setupDrop('imgDrop', 'imgInput', async f => {
  // Sniff for AHID magic - auto-route encoded images to decode tab
  const isEncoded = await sniffAHID(f);
  if (isEncoded) {
    switchTab('dec');
    loadDecodeFile(f);
    st('decStatus', 'info', 'AudioHide image detected - ready to extract. Click Extract Audio.');
    return;
  }

  // Treat as carrier image for encoding
  gImgFile = f;
  $('imgFileLbl').textContent  = f.name + ' - ' + fmtB(f.size);
  const p = $('imgPrev');
  p.src = URL.createObjectURL(f);
  p.style.display              = 'block';
  $('encBtn').disabled         = true;
  $('badge').style.display     = 'none';
  gSpeed = null;

  const img = new Image();
  img.onload = () => {
    gOrigW = img.width;
    gOrigH = img.height;
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

setupDrop('audDrop', 'audInput', f => {
  gAudFile = f;
  $('audFileLbl').textContent = f.name + ' - ' + fmtB(f.size);
  $('encBtn').disabled        = true;
  gSpeed = null;
  analyseCapacity();
});

setupDrop('decDrop', 'decInput', f => {
  loadDecodeFile(f);
});
