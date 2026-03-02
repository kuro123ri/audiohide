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
 *   NOTE: data and payload arrive as ArrayBuffer (cloned, not transferred).
 *         The originals stay intact on the main thread.
 *
 * Messages OUT (to main thread):
 *   { type: 'progress', value: 0..1 }
 *   { type: 'done',     data: ArrayBuffer }   <- embed: modified pixel buffer
 *   { type: 'done',     result: ArrayBuffer } <- extract: extracted bytes
 *   { type: 'error',    message: string }
 */

'use strict';

// Polyfill for IE11 / old Android
if (!Math.imul) {
  Math.imul = function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bh + ah * bl) << 16) + (al * bl) | 0;
  };
}

// Scatter helpers (duplicated — workers can't import from main thread)
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

// Message handler
self.onmessage = function (e) {
  var msg     = e.data;
  var scatter = (msg.scatterKey && msg.totalChannels)
    ? buildScatterMap(msg.scatterKey, msg.totalChannels)
    : null;

  try {
    if (msg.type === 'embed') {
      // IMPORTANT: msg.data is an ArrayBuffer — indexing it directly gives undefined.
      // Must wrap in Uint8ClampedArray first.
      var pixels  = new Uint8ClampedArray(msg.data);
      var payload = new Uint8Array(msg.payload);
      embed(pixels, payload, msg.bpc || 1, scatter);

    } else if (msg.type === 'extract') {
      var pixels2 = new Uint8ClampedArray(msg.data);
      extract(pixels2, msg.numBytes, msg.startBit, msg.bpc || 1, scatter);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};

// LSB Embed
function embed(pixels, payload, bpc, scatter) {
  var totalBits    = payload.length * 8;
  var REPORT_EVERY = 500000;

  for (var i = 0; i < totalBits; i++) {
    var b      = (payload[i >> 3] >> (7 - (i & 7))) & 1;
    var chIdx  = Math.floor(i / bpc);
    var bitPos = i % bpc;
    var ch     = scatter ? scatter(chIdx) : chIdx;
    var pixel  = Math.floor(ch / 3);
    var chan   = ch % 3;
    var di     = pixel * 4 + chan;
    var mask   = ~(1 << bitPos) & 0xFF;
    pixels[di] = (pixels[di] & mask) | (b << bitPos);

    if (i % REPORT_EVERY === 0) {
      self.postMessage({ type: 'progress', value: i / totalBits });
    }
  }

  // Transfer modified buffer back to main thread (zero-copy)
  self.postMessage({ type: 'done', data: pixels.buffer }, [pixels.buffer]);
}

// LSB Extract
function extract(pixels, numBytes, startBit, bpc, scatter) {
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
    var b      = (pixels[di] >> bitPos) & 1;
    result[i >> 3] |= (b << (7 - (i & 7)));

    if (i % REPORT_EVERY === 0) {
      self.postMessage({ type: 'progress', value: i / totalBits });
    }
  }

  // Transfer result to main thread (zero-copy)
  self.postMessage({ type: 'done', result: result.buffer }, [result.buffer]);
}