/**
 * lsb-worker.js — AudioHide LSB Web Worker
 *
 * Messages IN:
 *   { type: 'embed',   data: ArrayBuffer, payload: ArrayBuffer,
 *     bpc, scatterKey, totalChannels }
 *   { type: 'extract', data: ArrayBuffer, numBytes, startBit,
 *     bpc, scatterKey, totalChannels }
 *
 *   data is TRANSFERRED (not cloned) — main thread must not use it after postMessage.
 *   Worker transfers it back when done.
 *
 * Messages OUT:
 *   { type: 'progress', value: 0..1 }
 *   { type: 'done',     data: ArrayBuffer }   <- embed result (transferred back)
 *   { type: 'done',     result: ArrayBuffer } <- extract result (transferred)
 *   { type: 'error',    message: string }
 */

'use strict';

if (!Math.imul) {
  Math.imul = function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bh + ah * bl) << 16) + (al * bl) | 0;
  };
}

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

self.onmessage = function (e) {
  var msg     = e.data;
  var scatter = (msg.scatterKey && msg.totalChannels)
    ? buildScatterMap(msg.scatterKey, msg.totalChannels)
    : null;

  try {
    if (msg.type === 'embed') {
      var pixels  = new Uint8ClampedArray(msg.data);   // view over transferred buffer
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

// ── LSB Embed ────────────────────────────────────────────────
function embed(pixels, payload, bpc, scatter) {
  var totalBits    = payload.length * 8;
  var REPORT_EVERY = 600000;

  // Fast path: bpc=1, no scatter — most common case.
  // Avoids per-bit division/modulo and scatter lookup.
  if (bpc === 1 && !scatter) {
    for (var i = 0; i < totalBits; i++) {
      var b  = (payload[i >> 3] >> (7 - (i & 7))) & 1;
      // channel i → pixel floor(i/3), rgba offset i%3
      // skip alpha (channel index maps to: 0=R,1=G,2=B of each pixel)
      var di = (((i / 3) | 0) << 2) + (i % 3);
      pixels[di] = (pixels[di] & 0xFE) | b;

      if ((i & 0xFFFFF) === 0) {   // i % ~1M — cheap bitmask instead of modulo
        self.postMessage({ type: 'progress', value: i / totalBits });
      }
    }
    self.postMessage({ type: 'done', data: pixels.buffer }, [pixels.buffer]);
    return;
  }

  // General path: bpc=2 or scatter enabled
  for (var i2 = 0; i2 < totalBits; i2++) {
    var b2      = (payload[i2 >> 3] >> (7 - (i2 & 7))) & 1;
    var chIdx   = (i2 / bpc) | 0;
    var bitPos  = i2 % bpc;
    var ch      = scatter ? scatter(chIdx) : chIdx;
    var di2     = (((ch / 3) | 0) << 2) + (ch % 3);
    var mask    = ~(1 << bitPos) & 0xFF;
    pixels[di2] = (pixels[di2] & mask) | (b2 << bitPos);

    if (i2 % REPORT_EVERY === 0) {
      self.postMessage({ type: 'progress', value: i2 / totalBits });
    }
  }

  self.postMessage({ type: 'done', data: pixels.buffer }, [pixels.buffer]);
}

// ── LSB Extract ──────────────────────────────────────────────
function extract(pixels, numBytes, startBit, bpc, scatter) {
  var result       = new Uint8Array(numBytes);
  var totalBits    = numBytes * 8;
  var REPORT_EVERY = 600000;

  // Fast path: bpc=1, no scatter
  if (bpc === 1 && !scatter) {
    var abs = startBit;
    for (var i = 0; i < totalBits; i++, abs++) {
      var di = (((abs / 3) | 0) << 2) + (abs % 3);
      var b  = pixels[di] & 1;
      result[i >> 3] |= (b << (7 - (i & 7)));

      if ((i & 0xFFFFF) === 0) {
        self.postMessage({ type: 'progress', value: i / totalBits });
      }
    }
    self.postMessage({ type: 'done', result: result.buffer }, [result.buffer]);
    return;
  }

  // General path
  for (var i2 = 0; i2 < totalBits; i2++) {
    var absBit = startBit + i2;
    var chIdx  = (absBit / bpc) | 0;
    var bitPos = absBit % bpc;
    var ch     = scatter ? scatter(chIdx) : chIdx;
    var di2    = (((ch / 3) | 0) << 2) + (ch % 3);
    var b2     = (pixels[di2] >> bitPos) & 1;
    result[i2 >> 3] |= (b2 << (7 - (i2 & 7)));

    if (i2 % REPORT_EVERY === 0) {
      self.postMessage({ type: 'progress', value: i2 / totalBits });
    }
  }

  self.postMessage({ type: 'done', result: result.buffer }, [result.buffer]);
}