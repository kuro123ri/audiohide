/**
 * changelog.js — AudioHide update log + announcement system
 *
 * On page load:
 *   - Compares VERSION against last-seen version in localStorage
 *   - If newer: shows announcement banner with summary of changes
 *   - Dismiss stores current version — banner won't show again until next update
 *   - Full changelog always accessible via "What's New" button in topbar
 *
 * Storage key: 'audiohide-last-seen-ver'
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
// CHANGELOG DATA
// Add new entries at the TOP. date format: YYYY-MM-DD
// type: 'fix' | 'feature' | 'alpha' | 'beta' | 'breaking'
// ═══════════════════════════════════════════════════════════════

var CHANGELOG = [
  {
    version: '1.0.31',
    date:    '2026-03-20',
    summary: 'Scale bug fix + Developer Experiment panel',
    changes: [
      { type: 'fix',     text: 'Fixed scale input causing W and H to both become equal when typing a percentage — _resizeLock flag prevents onResizeW/H from firing during programmatic scale updates.' },
      { type: 'feature', text: 'Added Developer Experiment panel (⚗) — accessible from topbar, separate from main Settings.' },
      { type: 'alpha',   text: 'Alpha stub: Payload compression (deflate) — toggle tracked, encode/decode hooks ready.' },
      { type: 'alpha',   text: 'Alpha stub: MP3/Opus audio output — format selector added, WAV used until encoder wired.' },
      { type: 'alpha',   text: 'Alpha stub: Social media survival mode — redundancy scheme planned, hook functions defined.' },
      { type: 'alpha',   text: 'Alpha stub: Hide Anything (generic file payload) — fully implemented. Drop any file, it embeds with original filename, decodes back with correct extension.' },
      { type: 'alpha',   text: 'Alpha stub: Image IS the spectrogram — UI toggle present, spectrogram carrier generation not yet implemented.' },
      { type: 'beta',    text: 'Beta: Format support — WebP, TIFF, TGA, QOI, Animated WebP, Animated AVIF carrier inputs. File accept attributes update live.' },
      { type: 'beta',    text: 'Beta: Extended decode input — AVIF, HEIC, ICO, JPEG XL, PCX with auto-detect. Alpha formats flagged clearly.' },
      { type: 'beta',    text: 'Beta: Output format selector — PNG (default), WebP lossless, TIFF.' },
      { type: 'beta',    text: 'Beta: Per-channel LSB weighting — blue channel gets more bits. Hook ready.' }
    ]
  },
  {
    version: '1.0.30',
    date:    '2026-03-01',
    summary: 'Multi-frame GIF/APNG encode + auto decode mode detection',
    changes: [
      { type: 'feature', text: 'Multi-frame APNG mode — audio split across animated PNG frames. Supports GIF carrier input with per-frame embedding.' },
      { type: 'feature', text: 'GIF parser — full LZW decode, interlace reorder, disposal methods 0–3, transparent pixel handling.' },
      { type: 'feature', text: 'APNG encoder/decoder — complete from scratch: acTL, fcTL, fdAT chunks, all 5 PNG filter types, zlib compress/decompress.' },
      { type: 'fix',     text: 'Multi-frame: KEY FIX — use original GIF frame dimensions for per-frame capacity, not resize target. Ensures payload actually splits across frames.' },
      { type: 'feature', text: 'Auto decode mode detection — tries all combinations of bpc (1/2) and scatter (on/off) automatically, no manual mode setting needed.' },
      { type: 'feature', text: 'Header sanity checks on decode — rejects corrupt bpc/channels/speed/dataLen values and retries next combination.' },
      { type: 'feature', text: 'Stereo audio support — preserve left/right channels separately. Toggle in Settings, doubles capacity needed.' }
    ]
  },
  {
    version: '1.0.29',
    date:    '2026-02-10',
    summary: 'Web Worker LSB engine + scatter passkey',
    changes: [
      { type: 'feature', text: 'Web Worker offloads LSB embed/extract to background thread — UI stays responsive during large encodes.' },
      { type: 'feature', text: 'Worker fallback — if Worker fails to load (file:// protocol or old browser), silently falls back to chunked main-thread processing.' },
      { type: 'feature', text: 'Scatter passkey — Fisher-Yates shuffle over 1024-segment blocks, seeded from FNV-1a hash of passphrase. Bits written in key-derived random order.' },
      { type: 'feature', text: 'Cancel button — encode and decode can be interrupted mid-operation via cancelRef flag.' },
      { type: 'feature', text: '2-bit LSB depth option — doubles capacity with minor quality impact. Selectable in Settings.' },
      { type: 'fix',     text: 'ETA calculation — shows estimated time remaining during long encodes/decodes.' }
    ]
  },
  {
    version: '1.0.28',
    date:    '2026-01-15',
    summary: 'Header format v2 + pitch correction',
    changes: [
      { type: 'feature', text: 'New 20-byte AHID header — adds bpc byte, channels byte, reserved bytes. Backwards compatible with legacy 1-bit mono images.' },
      { type: 'feature', text: 'Auto pitch-correct on decode — OfflineAudioContext reverses the speed-up applied during encode, restoring original pitch.' },
      { type: 'feature', text: 'Normalize audio option — boosts quiet audio to near-peak volume before embedding.' },
      { type: 'feature', text: 'Sample rate selector — 8 kHz / 11 kHz / 16 kHz / 22 kHz. Lower rates fit more audio at slower speeds.' },
      { type: 'feature', text: 'Manual speed mode — set exact playback speed with semitone display. Bypass auto-fit.' },
      { type: 'fix',     text: 'iOS download — added fallback link and "Save to Files" instructions for Safari on iPhone/iPad.' }
    ]
  },
  {
    version: '1.0.27',
    date:    '2025-12-20',
    summary: 'Initial public release',
    changes: [
      { type: 'feature', text: 'Core LSB steganography — hide WAV audio in PNG/BMP carrier images using least significant bit embedding.' },
      { type: 'feature', text: 'Auto-fit speed selection — tries 1.0×, 1.25×, 1.5×, 1.75×, 2.0×, 2.5×, 3.0×, 4.0× to find minimum speed that fits.' },
      { type: 'feature', text: 'Capacity analysis — real-time bar showing audio payload vs image pixel capacity.' },
      { type: 'feature', text: 'Resize controls — scale image up/down with aspect lock to increase/decrease capacity.' },
      { type: 'feature', text: 'Auto-detect encoded images — drop an AudioHide PNG into encode tab, auto-switches to decode.' },
      { type: 'feature', text: 'Dark / Light / System theme — persists in localStorage.' },
      { type: 'feature', text: 'Full mobile support — iOS Safari, Android Chrome. Safe-area insets, tap-friendly drop zones.' },
      { type: 'feature', text: 'Debug panel — Web Worker status, AudioContext compat, event log, copy-to-clipboard report.' }
    ]
  }
];

// ═══════════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════════

var CL_STORE_KEY = 'audiohide-last-seen-ver';

function _clGetLastSeen() {
  try { return localStorage.getItem(CL_STORE_KEY) || '0.0.0'; } catch (e) { return '0.0.0'; }
}

function _clSetLastSeen(ver) {
  try { localStorage.setItem(CL_STORE_KEY, ver); } catch (e) {}
}

// ── Simple semver compare: returns true if a > b ──────────────
function _verGt(a, b) {
  var ap = a.split('.').map(Number);
  var bp = b.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    var av = ap[i] || 0, bv = bp[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// RENDER HELPERS
// ═══════════════════════════════════════════════════════════════

var TYPE_LABEL = {
  fix:      { tag: 'FIX',     cls: 'cl-tag-fix'     },
  feature:  { tag: 'NEW',     cls: 'cl-tag-feature'  },
  alpha:    { tag: 'α',       cls: 'cl-tag-alpha'    },
  beta:     { tag: 'β',       cls: 'cl-tag-beta'     },
  breaking: { tag: '⚠ BREAK', cls: 'cl-tag-breaking' }
};

function _renderTag(type) {
  var t = TYPE_LABEL[type] || { tag: type.toUpperCase(), cls: 'cl-tag-fix' };
  return '<span class="cl-tag ' + t.cls + '">' + t.tag + '</span>';
}

function _renderEntry(entry, isNew) {
  var html = '<div class="cl-entry' + (isNew ? ' cl-entry-new' : '') + '">';
  html += '<div class="cl-entry-header">';
  html += '<span class="cl-ver">v' + entry.version + '</span>';
  html += '<span class="cl-date">' + entry.date + '</span>';
  if (isNew) html += '<span class="cl-new-badge">NEW</span>';
  html += '</div>';
  html += '<div class="cl-summary">' + _esc(entry.summary) + '</div>';
  html += '<ul class="cl-list">';
  entry.changes.forEach(function (c) {
    html += '<li>' + _renderTag(c.type) + ' ' + _esc(c.text) + '</li>';
  });
  html += '</ul></div>';
  return html;
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════
// ANNOUNCEMENT BANNER
// ═══════════════════════════════════════════════════════════════

function _showAnnouncement(entry) {
  var banner = document.getElementById('updateBanner');
  if (!banner) return;

  // Build a short summary line (first 2 changes)
  var previews = entry.changes.slice(0, 2).map(function (c) {
    return _renderTag(c.type) + ' ' + _esc(c.text);
  }).join(' &nbsp;·&nbsp; ');
  if (entry.changes.length > 2) {
    previews += ' <span style="color:#555;">+ ' + (entry.changes.length - 2) + ' more…</span>';
  }

  banner.innerHTML =
    '<div class="update-banner-inner">' +
    '<div class="update-banner-left">' +
    '<span class="update-banner-title">🎉 AudioHide v' + entry.version + ' — ' + _esc(entry.summary) + '</span>' +
    '<div class="update-banner-preview">' + previews + '</div>' +
    '</div>' +
    '<div class="update-banner-actions">' +
    '<button class="btn-cl-view" onclick="openChangelog()">What\'s New</button>' +
    '<button class="btn-cl-dismiss" onclick="dismissAnnouncement()">✕ Dismiss</button>' +
    '</div>' +
    '</div>';

  banner.style.display = 'block';
}

function dismissAnnouncement() {
  var ver = (typeof VERSION !== 'undefined') ? VERSION : '0.0.0';
  _clSetLastSeen(ver);
  var banner = document.getElementById('updateBanner');
  if (banner) banner.style.display = 'none';
  if (typeof dbg === 'function') dbg('Changelog: dismissed at v' + ver);
}

// ═══════════════════════════════════════════════════════════════
// CHANGELOG MODAL
// ═══════════════════════════════════════════════════════════════

function openChangelog() {
  var modal = document.getElementById('changelogModal');
  if (!modal) return;

  var lastSeen = _clGetLastSeen();
  var ver      = (typeof VERSION !== 'undefined') ? VERSION : '0.0.0';

  var html = '<div class="cl-modal-inner">';
  html += '<div class="cl-modal-header">';
  html += '<h2 class="cl-modal-title">📋 AudioHide — Update Log</h2>';
  html += '<button class="btn-cl-close" onclick="closeChangelog()">✕ Close</button>';
  html += '</div>';
  html += '<div class="cl-modal-body">';

  CHANGELOG.forEach(function (entry) {
    var isNew = _verGt(entry.version, lastSeen);
    html += _renderEntry(entry, isNew);
  });

  html += '</div>';

  // Footer: mark all as read
  html += '<div class="cl-modal-footer">';
  html += '<button class="btn-cl-markread" onclick="markAllRead()">Mark all as read</button>';
  html += '<span class="cl-modal-footer-note">Showing ' + CHANGELOG.length + ' versions</span>';
  html += '</div>';

  html += '</div>';

  modal.innerHTML = html;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeChangelog() {
  var modal = document.getElementById('changelogModal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

function markAllRead() {
  var ver = (typeof VERSION !== 'undefined') ? VERSION : '0.0.0';
  _clSetLastSeen(ver);
  var banner = document.getElementById('updateBanner');
  if (banner) banner.style.display = 'none';
  // Re-render modal without NEW badges
  closeChangelog();
  openChangelog();
  if (typeof dbg === 'function') dbg('Changelog: marked all read at v' + ver);
}

// Close modal on backdrop click
document.addEventListener('click', function (e) {
  var modal = document.getElementById('changelogModal');
  if (modal && e.target === modal) closeChangelog();
});

// Close modal on Escape key
document.addEventListener('keydown', function (e) {
  if ((e.key === 'Escape' || e.keyCode === 27)) closeChangelog();
});

// ═══════════════════════════════════════════════════════════════
// TOPBAR "WHAT'S NEW" BUTTON — unread dot
// ═══════════════════════════════════════════════════════════════

function _updateWhatsNewBtn() {
  var btn = document.getElementById('whatsNewBtn');
  if (!btn) return;

  var lastSeen = _clGetLastSeen();
  var hasUnread = CHANGELOG.some(function (e) { return _verGt(e.version, lastSeen); });

  if (hasUnread) {
    btn.classList.add('has-unread');
    btn.title = 'New updates available!';
  } else {
    btn.classList.remove('has-unread');
    btn.title = 'View update log';
  }
}

// ═══════════════════════════════════════════════════════════════
// INITIALISE
// ═══════════════════════════════════════════════════════════════

(function changelogInit() {
  var ver      = (typeof VERSION !== 'undefined') ? VERSION : '0.0.0';
  var lastSeen = _clGetLastSeen();

  if (typeof dbg === 'function') {
    dbg('Changelog: current=' + ver + ' lastSeen=' + lastSeen);
  }

  _updateWhatsNewBtn();

  // Show announcement if current version is newer than last seen
  if (_verGt(ver, lastSeen)) {
    // Find the entry for current version
    var entry = null;
    for (var i = 0; i < CHANGELOG.length; i++) {
      if (CHANGELOG[i].version === ver) { entry = CHANGELOG[i]; break; }
    }
    if (entry) {
      _showAnnouncement(entry);
    } else {
      // Version exists but no changelog entry — show generic banner
      var banner = document.getElementById('updateBanner');
      if (banner) {
        banner.innerHTML =
          '<div class="update-banner-inner">' +
          '<span class="update-banner-title">AudioHide updated to v' + ver + '</span>' +
          '<div class="update-banner-actions">' +
          '<button class="btn-cl-view" onclick="openChangelog()">What\'s New</button>' +
          '<button class="btn-cl-dismiss" onclick="dismissAnnouncement()">✕</button>' +
          '</div></div>';
        banner.style.display = 'block';
      }
    }
  }
}());
