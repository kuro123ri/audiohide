/**
 * audiohide-devex.js — Developer Experiment panel logic
 * Loaded after audiohide.js. Wraps core functions non-destructively.
 *
 * Payload type byte (header byte 18):
 *   0x00 = audio (legacy / no type byte written)
 *   0x01 = audio (explicit)
 *   0x02 = generic file
 *
 * Generic file sub-header (immediately after the 20-byte AHID header):
 *   bytes  0– 1 : filename byte length (uint16 BE, max 65535)
 *   bytes  2– N : UTF-8 filename
 *   bytes N+1–… : raw file content
 *
 * Header field reuse for file payloads (type = 0x02):
 *   bytes  4– 7 : total sub-payload length (filename header + file bytes)
 *   bytes  8–11 : filename byte length (uint32 BE, mirrors sub-header for easy peek)
 *   bytes 12–15 : 0 (unused)
 *   byte  16    : 0 (bpc unused)
 *   byte  17    : 0 (channels unused)
 *   byte  18    : 0x02 (payload type = file)
 *   byte  19    : 0 (reserved)
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

var DEV_EX = {
  // Alpha
  compression:    false,
  audioFormat:    'wav',
  socialSurvival: false,
  hideAnything:   false,
  spectrogram:    false,
  // Beta — format support
  fmtWebP:        false,
  fmtTIFF:        false,
  fmtTGA:         false,
  fmtQOI:         false,
  fmtAnimWebP:    false,
  fmtAnimAVIF:    false,
  outputFormat:   'png',
  decAutoDetect:  true,
  decAVIF:        false,
  decHEIC:        false,
  decICO:         false,
  decJXL:         false,
  decPCX:         false,
  // Beta — capacity/quality
  channelWeight:  false
};

var DEV_EX_STORE_KEY = 'audiohide-devex-v1';

// Generic file state (hide-anything mode)
var gGenericFile      = null;
var gExtractedFile    = null;   // Blob after decode
var gExtractedFileName = '';    // original filename from payload

// ═══════════════════════════════════════════════════════════════
// PERSIST / RESTORE
// ═══════════════════════════════════════════════════════════════

function _devexSave() {
  try { localStorage.setItem(DEV_EX_STORE_KEY, JSON.stringify(DEV_EX)); } catch (e) {}
}

function _devexLoad() {
  try {
    var raw = localStorage.getItem(DEV_EX_STORE_KEY);
    if (!raw) return;
    var saved = JSON.parse(raw);
    Object.keys(saved).forEach(function (k) {
      if (DEV_EX.hasOwnProperty(k)) DEV_EX[k] = saved[k];
    });
  } catch (e) {}
}

function _devexApplyToDom() {
  var map = {
    expCompression:    'compression',
    expSocialSurvival: 'socialSurvival',
    expHideAnything:   'hideAnything',
    expSpectrogram:    'spectrogram',
    fmtWebP:           'fmtWebP',
    fmtTIFF:           'fmtTIFF',
    fmtTGA:            'fmtTGA',
    fmtQOI:            'fmtQOI',
    fmtAnimWebP:       'fmtAnimWebP',
    fmtAnimAVIF:       'fmtAnimAVIF',
    decAutoDetect:     'decAutoDetect',
    decAVIF:           'decAVIF',
    decHEIC:           'decHEIC',
    decICO:            'decICO',
    decJXL:            'decJXL',
    decPCX:            'decPCX',
    expChannelWeight:  'channelWeight'
  };
  Object.keys(map).forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.type === 'checkbox') el.checked = DEV_EX[map[id]];
  });
  // Select
  var af = document.getElementById('expAudioFormat');
  if (af) af.value = DEV_EX.audioFormat;
  // Radio
  var outRadio = document.querySelector('input[name="outputFormat"][value="' + DEV_EX.outputFormat + '"]');
  if (outRadio) outRadio.checked = true;
}

function _devexReadFromDom() {
  DEV_EX.compression    = !!document.getElementById('expCompression')   && document.getElementById('expCompression').checked;
  DEV_EX.socialSurvival = !!document.getElementById('expSocialSurvival') && document.getElementById('expSocialSurvival').checked;
  DEV_EX.hideAnything   = !!document.getElementById('expHideAnything')  && document.getElementById('expHideAnything').checked;
  DEV_EX.spectrogram    = !!document.getElementById('expSpectrogram')   && document.getElementById('expSpectrogram').checked;
  DEV_EX.fmtWebP        = !!document.getElementById('fmtWebP')          && document.getElementById('fmtWebP').checked;
  DEV_EX.fmtTIFF        = !!document.getElementById('fmtTIFF')          && document.getElementById('fmtTIFF').checked;
  DEV_EX.fmtTGA         = !!document.getElementById('fmtTGA')           && document.getElementById('fmtTGA').checked;
  DEV_EX.fmtQOI         = !!document.getElementById('fmtQOI')           && document.getElementById('fmtQOI').checked;
  DEV_EX.fmtAnimWebP    = !!document.getElementById('fmtAnimWebP')      && document.getElementById('fmtAnimWebP').checked;
  DEV_EX.fmtAnimAVIF    = !!document.getElementById('fmtAnimAVIF')      && document.getElementById('fmtAnimAVIF').checked;
  DEV_EX.decAutoDetect  = !!document.getElementById('decAutoDetect')    && document.getElementById('decAutoDetect').checked;
  DEV_EX.decAVIF        = !!document.getElementById('decAVIF')          && document.getElementById('decAVIF').checked;
  DEV_EX.decHEIC        = !!document.getElementById('decHEIC')          && document.getElementById('decHEIC').checked;
  DEV_EX.decICO         = !!document.getElementById('decICO')           && document.getElementById('decICO').checked;
  DEV_EX.decJXL         = !!document.getElementById('decJXL')           && document.getElementById('decJXL').checked;
  DEV_EX.decPCX         = !!document.getElementById('decPCX')           && document.getElementById('decPCX').checked;
  DEV_EX.channelWeight  = !!document.getElementById('expChannelWeight') && document.getElementById('expChannelWeight').checked;
  var af = document.getElementById('expAudioFormat');
  if (af) DEV_EX.audioFormat = af.value || 'wav';
  var outEl = document.querySelector('input[name="outputFormat"]:checked');
  if (outEl) DEV_EX.outputFormat = outEl.value || 'png';
}

// ═══════════════════════════════════════════════════════════════
// PANEL TOGGLE
// ═══════════════════════════════════════════════════════════════

function toggleDevEx() {
  var panel = document.getElementById('devexPanel');
  if (!panel) return;
  panel.classList.toggle('open');
}

// ═══════════════════════════════════════════════════════════════
// MAIN CHANGE HANDLER
// ═══════════════════════════════════════════════════════════════

function onDevExChange() {
  _devexReadFromDom();
  _devexSave();
  _updateImgInputAccept();
  _updateDecInputAccept();
  _updateAlphaNotices();
  // Re-run capacity if relevant toggles changed
  if (typeof analyseCapacity === 'function') analyseCapacity();
}

function onHideAnythingToggle() {
  _devexReadFromDom();
  _devexSave();
  _applyHideAnythingMode();
  _updateAlphaNotices();
}

// ═══════════════════════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════════════════════

function resetDevEx() {
  if (!confirm('Reset all Developer Experiment settings to defaults?')) return;
  DEV_EX = {
    compression: false, audioFormat: 'wav', socialSurvival: false,
    hideAnything: false, spectrogram: false,
    fmtWebP: false, fmtTIFF: false, fmtTGA: false, fmtQOI: false,
    fmtAnimWebP: false, fmtAnimAVIF: false,
    outputFormat: 'png',
    decAutoDetect: true,
    decAVIF: false, decHEIC: false, decICO: false, decJXL: false, decPCX: false,
    channelWeight: false
  };
  _devexSave();
  _devexApplyToDom();
  _updateImgInputAccept();
  _updateDecInputAccept();
  _applyHideAnythingMode();
  _updateAlphaNotices();
  if (typeof analyseCapacity === 'function') analyseCapacity();
}

// ═══════════════════════════════════════════════════════════════
// FORMAT SUPPORT — update file input accept attributes
// ═══════════════════════════════════════════════════════════════

function _updateImgInputAccept() {
  var base = 'image/png,image/bmp,image/gif';
  var extra = [];
  if (DEV_EX.fmtWebP)     extra.push('image/webp');
  if (DEV_EX.fmtTIFF)     extra.push('image/tiff');
  if (DEV_EX.fmtTGA)      extra.push('image/x-tga,image/x-targa,.tga');
  if (DEV_EX.fmtQOI)      extra.push('.qoi');
  if (DEV_EX.fmtAnimWebP) extra.push('image/webp');   // already covered but explicit
  if (DEV_EX.fmtAnimAVIF) extra.push('image/avif');
  var accept = extra.length ? base + ',' + extra.join(',') : base;
  // Deduplicate
  var parts = accept.split(',');
  var seen  = {};
  var dedup = parts.filter(function (p) {
    if (seen[p]) return false;
    seen[p] = true; return true;
  });
  var el = document.getElementById('imgInput');
  if (el) el.accept = dedup.join(',');
  // Update hint text
  var hint = document.getElementById('imgHint');
  if (hint) {
    var fmtList = ['PNG', 'BMP', 'GIF'];
    if (DEV_EX.fmtWebP)     fmtList.push('WebP');
    if (DEV_EX.fmtTIFF)     fmtList.push('TIFF');
    if (DEV_EX.fmtTGA)      fmtList.push('TGA');
    if (DEV_EX.fmtQOI)      fmtList.push('QOI');
    if (DEV_EX.fmtAnimWebP) fmtList.push('Anim.WebP');
    if (DEV_EX.fmtAnimAVIF) fmtList.push('Anim.AVIF');
    hint.textContent = fmtList.join(', ') + ' — JPEG cannot hold hidden data. Output is always PNG.';
  }
}

function _updateDecInputAccept() {
  var base = 'image/png,image/bmp';
  var extra = [];
  if (DEV_EX.decAutoDetect) {
    extra.push('image/*');
  } else {
    if (DEV_EX.fmtWebP)  extra.push('image/webp');
    if (DEV_EX.fmtTIFF)  extra.push('image/tiff');
    if (DEV_EX.fmtTGA)   extra.push('image/x-tga,.tga');
    if (DEV_EX.fmtQOI)   extra.push('.qoi');
    if (DEV_EX.decAVIF)  extra.push('image/avif');
    if (DEV_EX.decHEIC)  extra.push('image/heic,image/heif');
    if (DEV_EX.decICO)   extra.push('image/x-icon,.ico');
    if (DEV_EX.decJXL)   extra.push('image/jxl,.jxl');
    if (DEV_EX.decPCX)   extra.push('image/x-pcx,.pcx');
  }
  var accept = extra.length ? base + ',' + extra.join(',') : base;
  var el = document.getElementById('decInput');
  if (el) el.accept = accept;
}

// ═══════════════════════════════════════════════════════════════
// ALPHA NOTICES — shown in encode status when stub features are on
// ═══════════════════════════════════════════════════════════════

function _updateAlphaNotices() {
  // Collect active alpha stubs
  var active = [];
  if (DEV_EX.compression)    active.push('Compression');
  if (DEV_EX.audioFormat !== 'wav') active.push('Audio format: ' + DEV_EX.audioFormat.toUpperCase());
  if (DEV_EX.socialSurvival) active.push('Social survival');
  if (DEV_EX.spectrogram)    active.push('Spectrogram carrier');
  if (DEV_EX.channelWeight)  active.push('Channel weighting');

  var noticeEl = document.getElementById('devexAlphaNotice');
  if (!noticeEl) {
    // Create the notice element if it doesn't exist yet
    noticeEl = document.createElement('div');
    noticeEl.id = 'devexAlphaNotice';
    noticeEl.style.cssText =
      'display:none;margin:8px 0;padding:7px 10px;border:1px solid #cc7700;' +
      'background:#fff8e6;font-size:11px;line-height:1.6;color:#443300;';
    var encStatus = document.getElementById('encStatus');
    if (encStatus && encStatus.parentNode) {
      encStatus.parentNode.insertBefore(noticeEl, encStatus);
    }
  }

  if (active.length) {
    noticeEl.style.display = 'block';
    noticeEl.innerHTML =
      '<b>⚗ Active alpha stubs (UI only — not yet encoding):</b> ' +
      active.map(function (n) {
        return '<span class="tag-alpha">α</span> ' + n;
      }).join(' &nbsp; ') +
      '<br><span style="font-size:10px;color:#665500;">These toggles are tracked but the encode/decode logic is not yet wired. ' +
      'Coming in next build.</span>';
  } else {
    noticeEl.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════════
// HIDE ANYTHING MODE
// ═══════════════════════════════════════════════════════════════

function _applyHideAnythingMode() {
  var on          = DEV_EX.hideAnything;
  var audioSec    = document.getElementById('audioSection');
  var fileSec     = document.getElementById('fileSection');
  var banner      = document.getElementById('hideAnythingBanner');
  var encBtn      = document.getElementById('encBtn');

  if (audioSec)  audioSec.style.display  = on ? 'none' : 'block';
  if (fileSec)   fileSec.style.display   = on ? 'block' : 'none';
  if (banner)    banner.style.display    = on ? 'block' : 'none';
  if (encBtn) {
    if (on) {
      encBtn.textContent = 'Encode File and Download Image';
    } else {
      // Restore based on multiFrame state
      var mf = document.getElementById('multiFrameMode');
      encBtn.textContent = (mf && mf.checked)
        ? 'Encode and Download APNG'
        : 'Encode and Download Image';
    }
  }

  // Reset generic file state when toggling off
  if (!on) {
    gGenericFile = null;
    var lbl = document.getElementById('fileFileLbl');
    if (lbl) lbl.textContent = '';
    var fb = document.getElementById('fileBadge');
    if (fb) fb.style.display = 'none';
    if (encBtn) encBtn.disabled = true;
  }
}

// Drop zone for generic file
function _setupFileDrop() {
  var dropEl   = document.getElementById('fileDrop');
  var inputEl  = document.getElementById('fileInput');
  if (!dropEl || !inputEl) return;

  dropEl.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropEl.classList.add('over');
  });
  dropEl.addEventListener('dragleave', function () {
    dropEl.classList.remove('over');
  });
  dropEl.addEventListener('drop', function (e) {
    e.preventDefault();
    dropEl.classList.remove('over');
    var f = e.dataTransfer.files[0];
    if (f) _onGenericFileSelected(f);
  });
  inputEl.addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (f) _onGenericFileSelected(f);
    e.target.value = '';
  });
}

function _onGenericFileSelected(f) {
  gGenericFile = f;
  var lbl = document.getElementById('fileFileLbl');
  if (lbl) lbl.textContent = f.name + ' — ' + (typeof fmtB === 'function' ? fmtB(f.size) : f.size + ' B');
  _analyseFileCapacity();
}

function _analyseFileCapacity() {
  var fb = document.getElementById('fileBadge');
  var encBtn = document.getElementById('encBtn');
  if (!fb || !gGenericFile) return;

  // Need the image to be loaded too
  var rW = parseInt(document.getElementById('rW').value, 10) || (typeof gOrigW !== 'undefined' ? gOrigW : 0);
  var rH = parseInt(document.getElementById('rH').value, 10) || (typeof gOrigH !== 'undefined' ? gOrigH : 0);

  if (!rW || !rH) {
    fb.style.display = 'none';
    if (encBtn) encBtn.disabled = true;
    return;
  }

  // Capacity: pixel cap minus 20-byte AHID header minus 2-byte filename-length prefix
  var filenameBytes = _utf8Length(gGenericFile.name);
  var overhead      = (typeof HEADER_BYTES !== 'undefined' ? HEADER_BYTES : 20) + 2 + filenameBytes;
  var pixelCap      = Math.floor(rW * rH * 3 / 8);   // bpc=1, mono
  var available     = pixelCap - overhead;
  var fileSize      = gGenericFile.size;
  var pct           = fileSize / available * 100;

  fb.style.display = 'block';

  if (fileSize > available) {
    fb.className = 'badge red';
    fb.innerHTML =
      '<b>File too large.</b> Need ' + (typeof fmtB === 'function' ? fmtB(fileSize) : fileSize + ' B') +
      ', capacity ' + (typeof fmtB === 'function' ? fmtB(available) : available + ' B') + '.<br>' +
      'Enlarge the carrier image or use 2-bit LSB depth in Settings.';
    if (encBtn) encBtn.disabled = true;
  } else {
    fb.className = 'badge' + (pct < 65 ? ' green' : '');
    fb.innerHTML =
      'File fits — ' + (typeof fmtB === 'function' ? fmtB(fileSize) : fileSize + ' B') +
      ' / ' + (typeof fmtB === 'function' ? fmtB(available) : available + ' B') +
      ' (' + Math.round(pct) + '% of capacity).<br>' +
      '<span style="font-size:10px;"><span class="tag-alpha">α</span> Hide Anything mode — audio options ignored.</span>';
    if (encBtn) encBtn.disabled = false;
  }
}

// ── UTF-8 byte length helper ──────────────────────────────────
function _utf8Length(str) {
  var s = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80)       s += 1;
    else if (c < 0x800) s += 2;
    else                s += 3;
  }
  return s;
}

function _utf8Encode(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80)       { bytes.push(c); }
    else if (c < 0x800) { bytes.push(0xC0 | (c >> 6)); bytes.push(0x80 | (c & 0x3F)); }
    else                { bytes.push(0xE0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F)); }
  }
  return new Uint8Array(bytes);
}

function _utf8Decode(bytes) {
  var s = '';
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i];
    if (b < 0x80)       { s += String.fromCharCode(b); i++; }
    else if (b < 0xE0)  { s += String.fromCharCode(((b & 0x1F) << 6)  | (bytes[i+1] & 0x3F)); i += 2; }
    else                { s += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i+1] & 0x3F) << 6) | (bytes[i+2] & 0x3F)); i += 3; }
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════
// BUILD GENERIC FILE PAYLOAD
// ═══════════════════════════════════════════════════════════════

function _buildFilePayload(fileBytes, fileName) {
  var HEADER  = typeof HEADER_BYTES !== 'undefined' ? HEADER_BYTES : 20;
  var MAGIC_V = typeof MAGIC       !== 'undefined' ? MAGIC       : [0x41,0x48,0x49,0x44];
  var fnBytes  = _utf8Encode(fileName);
  var fnLen    = fnBytes.length;

  // Sub-payload: 2-byte filename length + filename bytes + file bytes
  var subLen   = 2 + fnLen + fileBytes.length;
  var out      = new Uint8Array(HEADER + subLen);
  var dv       = new DataView(out.buffer);

  // AHID magic
  MAGIC_V.forEach(function (b, i) { dv.setUint8(i, b); });

  // bytes 4-7: total sub-payload length
  dv.setUint32(4,  subLen, false);
  // bytes 8-11: filename byte length (for easy peek on decode)
  dv.setUint32(8,  fnLen,  false);
  // bytes 12-15: 0 (unused for file payloads)
  dv.setUint32(12, 0,      false);
  // byte 16: bpc = 0 (unused)
  dv.setUint8(16,  0);
  // byte 17: channels = 0 (unused)
  dv.setUint8(17,  0);
  // byte 18: payload type = 0x02 (generic file)
  dv.setUint8(18,  0x02);
  // byte 19: reserved
  dv.setUint8(19,  0);

  // Sub-header: filename length as uint16 BE
  dv.setUint16(HEADER,     fnLen, false);
  // Filename bytes
  out.set(fnBytes, HEADER + 2);
  // File bytes
  out.set(fileBytes, HEADER + 2 + fnLen);

  return out;
}

// ═══════════════════════════════════════════════════════════════
// ENCODE — generic file
// ═══════════════════════════════════════════════════════════════

function doEncodeFile() {
  if (!gGenericFile) {
    if (typeof st === 'function') st('encStatus', 'err', 'No file selected to hide.');
    return;
  }

  var imgFile = typeof gImgFile !== 'undefined' ? gImgFile : null;
  if (!imgFile) {
    if (typeof st === 'function') st('encStatus', 'err', 'No carrier image selected.');
    return;
  }

  var btn     = document.getElementById('encBtn');
  var encProg = document.getElementById('encProg');
  if (btn)     btn.disabled = true;
  if (encProg) encProg.style.display = 'block';
  if (typeof stHide  === 'function') stHide('encStatus');
  if (typeof st      === 'function') st('encStatus', 'info', 'Loading carrier image…');
  if (typeof prog    === 'function') prog('encFill', 'encLbl', 'encPct', 5, 'Loading image…');

  var rW = parseInt(document.getElementById('rW').value, 10) || (typeof gOrigW !== 'undefined' ? gOrigW : 0);
  var rH = parseInt(document.getElementById('rH').value, 10) || (typeof gOrigH !== 'undefined' ? gOrigH : 0);

  var cv, ctx, payload;

  Promise.all([
    (typeof loadImageBitmap === 'function') ? loadImageBitmap(imgFile) : Promise.reject(new Error('loadImageBitmap not available')),
    (typeof fileToArrayBuffer === 'function') ? fileToArrayBuffer(gGenericFile) : gGenericFile.arrayBuffer()
  ])
  .then(function (results) {
    var bmp       = results[0];
    var fileArrayBuf = results[1];
    var fileBytes = new Uint8Array(fileArrayBuf);

    cv = document.createElement('canvas');
    cv.width  = rW; cv.height = rH;
    ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, rW, rH);

    if (typeof prog === 'function') prog('encFill', 'encLbl', 'encPct', 20, 'Building payload…');

    payload = _buildFilePayload(fileBytes, gGenericFile.name);

    var totalCap = Math.floor(rW * rH * 3 / 8);  // bpc=1
    if (payload.length > totalCap) {
      throw new Error(
        'File payload (' + (typeof fmtB === 'function' ? fmtB(payload.length) : payload.length + ' B') +
        ') exceeds image capacity (' + (typeof fmtB === 'function' ? fmtB(totalCap) : totalCap + ' B') + ').'
      );
    }

    if (typeof st === 'function') st('encStatus', 'info', 'Embedding file into pixels…');
    if (typeof prog === 'function') prog('encFill', 'encLbl', 'encPct', 30, 'Embedding…');

    var pixelData     = ctx.getImageData(0, 0, rW, rH).data;
    var totalChannels = rW * rH * 3;
    var scatterKey    = (typeof getScatterKey === 'function') ? getScatterKey() : null;
    var encStart      = Date.now();

    return (typeof lsbEmbed === 'function'
      ? lsbEmbed(pixelData, payload, function (p) {
          var pct = 30 + p * 62;
          var eta = '';
          if (p > 0.03 && p < 0.97 && typeof fmtEta === 'function') {
            var elapsed = Date.now() - encStart;
            eta = ' (~' + fmtEta((elapsed / p) * (1 - p)) + ')';
          }
          if (typeof prog === 'function') prog('encFill', 'encLbl', 'encPct', pct, 'Embedding ' + Math.round(pct) + '%' + eta);
        }, scatterKey, 1, totalChannels)
      : Promise.reject(new Error('lsbEmbed not available'))
    );
  })
  .then(function (modifiedPixels) {
    if (typeof prog === 'function') prog('encFill', 'encLbl', 'encPct', 93, 'Saving PNG…');

    ctx.putImageData(new ImageData(modifiedPixels, rW, rH), 0, 0);

    return new Promise(function (resolve, reject) {
      cv.toBlob(function (blob) {
        if (!blob) { reject(new Error('toBlob returned null')); return; }
        var baseName = imgFile.name.replace(/\.[^.]+$/, '');
        if (typeof triggerDownload === 'function') {
          triggerDownload(blob, 'audiohide_' + baseName + '_file.png');
        }
        resolve(blob.size);
      }, 'image/png');
    });
  })
  .then(function (blobSize) {
    if (typeof prog === 'function') prog('encFill', 'encLbl', 'encPct', 100, 'Done!');
    if (typeof st === 'function') st('encStatus', 'ok',
      'Done. File hidden in image. Output: ' + (typeof fmtB === 'function' ? fmtB(blobSize) : blobSize + ' B') + '. ' +
      'Drop the output PNG into the Decode tab to extract "' + gGenericFile.name + '".');
    if (btn) btn.disabled = false;
  })
  ['catch'](function (e) {
    if (typeof st === 'function') st('encStatus', 'err', 'Error: ' + (e && e.message ? e.message : String(e)));
    if (typeof dbg === 'function') dbg('File encode error: ' + (e && e.message ? e.message : String(e)));
    if (btn) btn.disabled = false;
  });
}

// ═══════════════════════════════════════════════════════════════
// DECODE — generic file extraction
// ═══════════════════════════════════════════════════════════════

function _isFilePayload(hdrBytes) {
  return hdrBytes.length >= 19 && hdrBytes[18] === 0x02;
}

function _extractFileFromPayload(rawBytes) {
  // rawBytes = everything after the 20-byte AHID header
  // layout: uint16BE filename_len | filename_bytes | file_bytes
  var dv      = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  var fnLen   = dv.getUint16(0, false);
  var fnBytes = rawBytes.subarray(2, 2 + fnLen);
  var fileBuf = rawBytes.subarray(2 + fnLen);
  return {
    name:  _utf8Decode(fnBytes),
    bytes: fileBuf
  };
}

function doDecodeFile(rawSubPayload, dataLen) {
  var result  = _extractFileFromPayload(rawSubPayload);
  gExtractedFile     = new Blob([result.bytes]);
  gExtractedFileName = result.name;

  // Update info card
  var iSize  = document.getElementById('iSize');
  var iSpeed = document.getElementById('iSpeed');
  var iOrig  = document.getElementById('iOrig');
  var iEnc   = document.getElementById('iEnc');
  var iBpc   = document.getElementById('iBpc');
  var iType  = document.getElementById('iType');
  var iNote  = document.getElementById('iNote');
  var infoCard = document.getElementById('infoCard');

  if (iSize)    iSize.textContent  = (typeof fmtB === 'function' ? fmtB(result.bytes.length) : result.bytes.length + ' B');
  if (iSpeed)   iSpeed.textContent = 'N/A';
  if (iOrig)    iOrig.textContent  = 'N/A';
  if (iEnc)     iEnc.textContent   = 'N/A';
  if (iBpc)     iBpc.textContent   = '1-bit';
  if (iType)    iType.textContent  = 'file — ' + result.name;
  if (iNote)    iNote.innerHTML    =
    '<b>Generic file payload</b> — <span class="tag-alpha">α</span> Hide Anything mode.<br>' +
    'Filename: <b>' + result.name + '</b> (' + (typeof fmtB === 'function' ? fmtB(result.bytes.length) : result.bytes.length + ' B') + ')';
  if (infoCard) infoCard.style.display = 'block';

  // Hide audio player, show file download
  var audioWrap = document.getElementById('audioWrap');
  var fileWrap  = document.getElementById('fileWrap');
  var dlName    = document.getElementById('dlFileName');
  if (audioWrap) audioWrap.style.display = 'none';
  if (fileWrap)  fileWrap.style.display  = 'block';
  if (dlName)    dlName.textContent      = result.name;

  if (typeof prog === 'function') prog('decFill', 'decLbl', 'decPct', 100, 'Done!');
  if (typeof st   === 'function') st('decStatus', 'ok',
    'Extracted file: "' + result.name + '" (' + (typeof fmtB === 'function' ? fmtB(result.bytes.length) : result.bytes.length + ' B') + ').');

  var btn = document.getElementById('decBtn');
  if (btn) btn.disabled = false;
}

function dlFile() {
  if (!gExtractedFile || !gExtractedFileName) return;
  if (typeof triggerDownload === 'function') {
    triggerDownload(gExtractedFile, gExtractedFileName);
  } else {
    var url = URL.createObjectURL(gExtractedFile);
    var a   = document.createElement('a');
    a.href = url; a.download = gExtractedFileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
}

// ═══════════════════════════════════════════════════════════════
// ALPHA STUB HOOKS
// These are called from the encode/decode chain.
// Currently pass-through — logic added in future builds.
// ═══════════════════════════════════════════════════════════════

/**
 * devexPreProcessPayload(bytes) → Uint8Array
 * Hook: compress payload if DEV_EX.compression is on.
 * STUB: returns bytes unchanged.
 */
function devexPreProcessPayload(bytes) {
  // TODO: deflate compress when DEV_EX.compression === true
  return bytes;
}

/**
 * devexPostProcessPayload(bytes) → Uint8Array
 * Hook: decompress if compression flag detected in header.
 * STUB: returns bytes unchanged.
 */
function devexPostProcessPayload(bytes) {
  // TODO: decompress when header compression flag is set
  return bytes;
}

/**
 * devexGetAudioFormat() → 'wav' | 'mp3' | 'opus'
 * Hook: returns desired output audio format.
 * STUB: always returns 'wav' until MP3/Opus encoding is wired.
 */
function devexGetAudioFormat() {
  // TODO: return DEV_EX.audioFormat when encoder is ready
  return 'wav';
}

/**
 * devexSocialEncode(bytes) → Uint8Array
 * Hook: add redundancy for social media survival.
 * STUB: returns bytes unchanged.
 */
function devexSocialEncode(bytes) {
  // TODO: Reed-Solomon style tripling when DEV_EX.socialSurvival === true
  return bytes;
}

/**
 * devexSocialDecode(bytes) → Uint8Array
 * Hook: recover from redundant copies.
 * STUB: returns bytes unchanged.
 */
function devexSocialDecode(bytes) {
  // TODO: majority vote reconstruction when social survival header flag set
  return bytes;
}

/**
 * devexGetOutputMime() → MIME type string
 * Hook: returns output image MIME type based on outputFormat setting.
 * Beta: WebP and TIFF output work in supported browsers.
 */
function devexGetOutputMime() {
  switch (DEV_EX.outputFormat) {
    case 'webp': return 'image/webp';
    case 'tiff': return 'image/tiff';
    default:     return 'image/png';
  }
}

/**
 * devexGetOutputExt() → file extension string (with dot)
 */
function devexGetOutputExt() {
  switch (DEV_EX.outputFormat) {
    case 'webp': return '.webp';
    case 'tiff': return '.tiff';
    default:     return '.png';
  }
}

/**
 * devexGenerateSpectrogramCarrier(audioBuffer) → Promise<ImageData>
 * Hook: render mel-spectrogram as carrier image.
 * STUB: rejects with not-yet-implemented.
 */
function devexGenerateSpectrogramCarrier(audioBuffer) {
  // TODO: FFT → mel bins → colour map → ImageData
  return Promise.reject(new Error('⚗ Spectrogram carrier: not yet implemented.'));
}

// ═══════════════════════════════════════════════════════════════
// MONKEY-PATCH doEncode
// ═══════════════════════════════════════════════════════════════

if (typeof doEncode === 'function') {
  var _origDoEncode = doEncode;
  doEncode = function () {
    // Route to file encode if hide-anything mode is active
    if (DEV_EX.hideAnything) {
      doEncodeFile();
      return;
    }
    // Warn about spectrogram stub
    if (DEV_EX.spectrogram) {
      if (typeof st === 'function') st('encStatus', 'warn',
        '⚗ Spectrogram carrier mode is not yet implemented. Using normal carrier image.');
    }
    _origDoEncode();
  };
}

// ═══════════════════════════════════════════════════════════════
// MONKEY-PATCH finishDecode — intercept file payloads
// ═══════════════════════════════════════════════════════════════

if (typeof finishDecode === 'function') {
  var _origFinishDecode = finishDecode;
  finishDecode = function (audioBytes, dataLen, origDurMs, encDurMs, speed, bpc, channels, numFrames) {
    // Check if this is a generic file payload (type byte = 0x02)
    // The AHID header was already validated upstream; we peek at the raw
    // audioBytes to check if the type byte was 0x02.
    // Convention: if speed === 0 AND channels === 0, it's a file payload
    // (we set these to 0 in _buildFilePayload, speed field reused for fnLen).
    // More reliable: check the leading 2 bytes for a valid filename sub-header.
    // We use the _devexFilePayloadFlag set by the patched decode path below.
    if (_devexFilePayloadFlag) {
      _devexFilePayloadFlag = false;
      doDecodeFile(audioBytes, dataLen);
      return Promise.resolve();
    }
    return _origFinishDecode(audioBytes, dataLen, origDurMs, encDurMs, speed, bpc, channels, numFrames);
  };
}

// Flag set by patched header-read path when payload type = 0x02
var _devexFilePayloadFlag = false;

// ═══════════════════════════════════════════════════════════════
// MONKEY-PATCH lsbExtractMainThread result handler
// Detect file payload type from header bytes before calling finishDecode
// ═══════════════════════════════════════════════════════════════

// We patch doDecodeSingleFrame's tryNextAttempt result to peek at byte 18
// The cleanest hook is wrapping the header validation check.
// Since we can't easily intercept inner closures, we use a MutationObserver
// on the decode status element to detect when decode is running, then check
// the flag after the header read completes.
// 
// BETTER APPROACH: patch lsbExtractMainThread to set the flag after reading header.
// We intercept at the point where HEADER_BYTES are extracted and check byte 18.

if (typeof lsbExtractMainThread === 'function') {
  var _origLsbExtractMain = lsbExtractMainThread;
  lsbExtractMainThread = function (data, numBytes, startBit, onProg, scatter, bpc, cancelRef) {
    return _origLsbExtractMain(data, numBytes, startBit, onProg, scatter, bpc, cancelRef)
      .then(function (result) {
        // If this was a HEADER_BYTES read (numBytes === HEADER_BYTES) and
        // startBit === 0, peek at byte 18 to detect file payload type
        var hb = typeof HEADER_BYTES !== 'undefined' ? HEADER_BYTES : 20;
        if (numBytes === hb && startBit === 0 && result.length >= 19) {
          var magic = typeof MAGIC !== 'undefined' ? MAGIC : [0x41,0x48,0x49,0x44];
          var magicOk = true;
          for (var i = 0; i < 4; i++) {
            if (result[i] !== magic[i]) { magicOk = false; break; }
          }
          if (magicOk && result[18] === 0x02) {
            _devexFilePayloadFlag = true;
          }
        }
        return result;
      });
  };
}

// ═══════════════════════════════════════════════════════════════
// CAPACITY ANALYSIS — hook for generic file mode
// ═══════════════════════════════════════════════════════════════

if (typeof analyseCapacity === 'function') {
  var _origAnalyseCapacity = analyseCapacity;
  analyseCapacity = function () {
    if (DEV_EX.hideAnything) {
      // Update file capacity instead of audio capacity
      _analyseFileCapacity();
      return;
    }
    _origAnalyseCapacity();
  };
}

// ═══════════════════════════════════════════════════════════════
// INITIALISE ON DOM READY
// ═══════════════════════════════════════════════════════════════

(function devexInit() {
  _devexLoad();
  _devexApplyToDom();
  _updateImgInputAccept();
  _updateDecInputAccept();
  _applyHideAnythingMode();
  _setupFileDrop();
  _updateAlphaNotices();

  if (typeof dbg === 'function') {
    dbg('audiohide-devex loaded. State: ' + JSON.stringify(DEV_EX));
  }
}());