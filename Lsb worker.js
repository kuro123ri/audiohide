/**
 * lsb-worker.js — AudioHide LSB Web Worker
 *
 * Runs the bit-level encode/decode loops in a background thread so
 * the main UI never freezes during large images.
 *
 * Messages IN  (from main thread):
 *   { type: 'embed',   data, payload, bpc, scatterKey, totalChannels }
 *   { type: 'extract', data, numBytes, startBit, bpc, scatterKey, totalChannels }
 *
 * Messages OUT (to main thread):
 *   { type: 'progress', value: 0..1 }
 *   { type: 'done',     data }          ← embed result
 *   { type: 'done',     result }        ← extract result (Uint8Array)
 *   { type: 'error',    message }
 */

'use strict';

// ── Polyfills (same as main thread — worker has no DOM) ──────
if (!Math.imul) {
  Math.imul = function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bh + ah * bl) << 16) + (al * bl) | 0;
  };
}

// ── Scatter helpers (duplicated from main — workers can't import) ─
var SCATTER_SEG = 1024;

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
 * Builds a segment-shuffle scatter map from a passkey.
 * Returns a function: channelIndex → shuffledChannelIndex.
 */
function buildScatterMap(key, availChannels) {
  var segCount = Math.ceil(availChannels / SCATTER_SEG);
  var order    = new Uint32Array(segCount);
  for (var s = 0; s < segCount; s++) order[s] = s;

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

// ── Message handler ──────────────────────────────────────────
self.onmessage = function (e) {
  var msg = e.data;

  // Build scatter map from key if provided
  var scatter = (msg.scatterKey && msg.totalChannels)
    ? buildScatterMap(msg.scatterKey, msg.totalChannels)
    : null;

  try {
    if (msg.type === 'embed') {
      embed(msg.data, msg.payload, msg.bpc || 1, scatter);
    } else if (msg.type === 'extract') {
      extract(msg.data, msg.numBytes, msg.startBit, msg.bpc || 1, scatter);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
};

// ── LSB Embed ────────────────────────────────────────────────
/**
 * Writes payload bits into the image data array.
 * data    — Uint8ClampedArray of RGBA pixels (transferred, not copied)
 * payload — Uint8Array of bytes to embed
 * bpc     — bits per channel: 1 (standard) or 2 (double capacity)
 * scatter — optional channel remapping function
 */
function embed(data, payload, bpc, scatter) {
  var totalBits    = payload.length * 8;
  var REPORT_EVERY = 500000; // report progress every N bits

  for (var i = 0; i < totalBits; i++) {
    var b      = (payload[i >> 3] >> (7 - (i & 7))) & 1;
    var chIdx  = Math.floor(i / bpc);
    var bitPos = i % bpc;
    var ch     = scatter ? scatter(chIdx) : chIdx;
    var pixel  = Math.floor(ch / 3);
    var chan   = ch % 3;
    var di     = pixel * 4 + chan;
    var mask   = ~(1 << bitPos) & 0xFF;
    data[di]   = (data[di] & mask) | (b << bitPos);

    if (i % REPORT_EVERY === 0) {
      self.postMessage({ type: 'progress', value: i / totalBits });
    }
  }

  self.postMessage({ type: 'done', data: data });
}

// ── LSB Extract ──────────────────────────────────────────────
/**
 * Reads numBytes of payload from image data starting at startBit.
 * data     — Uint8ClampedArray of RGBA pixels
 * numBytes — how many bytes to extract
 * startBit — absolute bit-sequence offset (skip header bits)
 * bpc      — bits per channel used during encoding
 * scatter  — optional channel remapping function
 */
function extract(data, numBytes, startBit, bpc, scatter) {
  var result       = new Uint8Array(numBytes);
  var totalBits    = numBytes * 8;
  var REPORT_EVERY = 500000;

  for (var i = 0; i < totalBits; i++) {
    var absBit = startBit + i;
    var chIdx  = Math.floor(absBit / bpc);
    var bitPos = absBit % bpc;
    var ch     = scatter ? scatter(chIdx) : chIdx;
    var pixel  = Math.floor(ch / 3);
    var chan   = ch % 3;
    var di     = pixel * 4 + chan;
    var b      = (data[di] >> bitPos) & 1;
    result[i >> 3] |= (b << (7 - (i & 7)));

    if (i % REPORT_EVERY === 0) {
      self.postMessage({ type: 'progress', value: i / totalBits });
    }
  }

  self.postMessage({ type: 'done', result: result });
}