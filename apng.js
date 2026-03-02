/**
 * apng.js — Animated PNG encode/decode + GIF frame parser
 *
 * Used by AudioHide for multi-frame steganography:
 * audio payload is split across APNG frames so each frame
 * carries one sequential chunk of the hidden data.
 *
 * Exports (globals):
 *   encodeAPNG(frames, width, height, delayMs) → Promise<Uint8Array>
 *   parseAPNG(arrayBuffer)                     → Promise<APNGResult>
 *   parseGIF(arrayBuffer)                      → GIFResult (sync)
 *   detectAPNG(arrayBuffer)                    → boolean
 *   detectGIF(arrayBuffer)                     → boolean
 *
 * APNGResult: { width, height, frames: [Uint8ClampedArray], animated: bool }
 * GIFResult:  { width, height, frames: [{ rgba: Uint8ClampedArray, delayMs }] }
 *
 * Requires: CompressionStream / DecompressionStream (Chrome 80+, Firefox 113+, Safari 16.4+)
 * If not available, compression falls back to zlib STORE (no compression, larger file).
 * Decompression without DecompressionStream shows a clear error.
 */

'use strict';

// ── CRC32 (needed for PNG chunk checksums) ───────────────────
var _crcTable = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
}());

function _crc32(bytes, start, end) {
  var c = 0xFFFFFFFF;
  for (var i = start; i < end; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk builder ────────────────────────────────────────
// Returns a Uint8Array: [4-byte length][4-byte type][data][4-byte CRC]
function _makeChunk(type, data) {
  var len = data ? data.length : 0;
  var buf = new Uint8Array(12 + len);
  var v   = new DataView(buf.buffer);
  v.setUint32(0, len, false);
  buf[4] = type.charCodeAt(0); buf[5] = type.charCodeAt(1);
  buf[6] = type.charCodeAt(2); buf[7] = type.charCodeAt(3);
  if (data && len) buf.set(data, 8);
  v.setUint32(8 + len, _crc32(buf, 4, 8 + len), false);
  return buf;
}

// ── PNG row filtering ────────────────────────────────────────
// Uses filter type 0 (None) — simplest, lossless, fastest.
// Each row gets a 0x00 prefix byte.
function _filterRows(rgba, width, height) {
  var rowBytes = width * 4;
  var out      = new Uint8Array(height * (rowBytes + 1));
  for (var y = 0; y < height; y++) {
    var outBase = y * (rowBytes + 1);
    out[outBase] = 0; // filter type = None
    out.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), outBase + 1);
  }
  return out;
}

// ── PNG row un-filtering ─────────────────────────────────────
// Supports all 5 PNG filter types (None, Sub, Up, Average, Paeth).
function _unfilterRows(data, width, height) {
  var bpp     = 4; // RGBA
  var rowBytes = width * bpp;
  var stride   = rowBytes + 1; // +1 for filter byte
  var out      = new Uint8Array(width * height * bpp);
  var prev     = new Uint8Array(rowBytes); // previous row, all-zero for first row

  for (var y = 0; y < height; y++) {
    var filter  = data[y * stride];
    var row     = data.subarray(y * stride + 1, y * stride + 1 + rowBytes);
    var outRow  = out.subarray(y * rowBytes, (y + 1) * rowBytes);

    if (filter === 0) { // None
      outRow.set(row);

    } else if (filter === 1) { // Sub
      for (var x = 0; x < rowBytes; x++) {
        var left = x >= bpp ? outRow[x - bpp] : 0;
        outRow[x] = (row[x] + left) & 0xFF;
      }

    } else if (filter === 2) { // Up
      for (var x = 0; x < rowBytes; x++) {
        outRow[x] = (row[x] + prev[x]) & 0xFF;
      }

    } else if (filter === 3) { // Average
      for (var x = 0; x < rowBytes; x++) {
        var left2 = x >= bpp ? outRow[x - bpp] : 0;
        outRow[x] = (row[x] + ((left2 + prev[x]) >> 1)) & 0xFF;
      }

    } else if (filter === 4) { // Paeth
      for (var x = 0; x < rowBytes; x++) {
        var a = x >= bpp ? outRow[x - bpp] : 0;
        var b = prev[x];
        var c = x >= bpp ? prev[x - bpp] : 0;
        var p = a + b - c;
        var pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        var pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        outRow[x] = (row[x] + pr) & 0xFF;
      }
    }

    prev = new Uint8Array(outRow); // save for next row
  }
  return out;
}

// ── Zlib compress (PNG requires zlib format, not raw deflate) ─
function _compressZlib(data) {
  if (typeof CompressionStream !== 'undefined') {
    var cs     = new CompressionStream('deflate'); // 'deflate' = zlib wrapper (CM=8)
    var writer = cs.writable.getWriter();
    var reader = cs.readable.getReader();
    writer.write(data);
    writer.close();
    return _readAll(reader);
  }
  // Fallback: zlib STORE (no compression — valid but larger files)
  return Promise.resolve(_zlibStore(data));
}

// zlib STORE: wraps raw bytes in valid zlib/DEFLATE STORE blocks + Adler-32 checksum
function _zlibStore(data) {
  var BSIZE  = 32768;
  var blocks = [];
  for (var i = 0; i < data.length || i === 0; i += BSIZE) {
    var chunk = data.subarray(i, Math.min(i + BSIZE, data.length));
    var last  = (i + BSIZE >= data.length) ? 1 : 0;
    var len   = chunk.length;
    var nlen  = (~len) & 0xFFFF;
    var b     = new Uint8Array(5 + len);
    b[0] = last; b[1] = len & 0xFF; b[2] = (len >> 8) & 0xFF;
    b[3] = nlen & 0xFF; b[4] = (nlen >> 8) & 0xFF;
    b.set(chunk, 5);
    blocks.push(b);
  }
  // Adler-32
  var s1 = 1, s2 = 0;
  for (var i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  var totalLen = 2 + blocks.reduce(function (a, b) { return a + b.length; }, 0) + 4;
  var out = new Uint8Array(totalLen);
  out[0] = 0x78; out[1] = 0x01; // zlib header: CM=8, CINFO=7, FCHECK=01
  var off = 2;
  for (var i = 0; i < blocks.length; i++) { out.set(blocks[i], off); off += blocks[i].length; }
  out[off] = (s2 >> 8) & 0xFF; out[off+1] = s2 & 0xFF;
  out[off+2] = (s1 >> 8) & 0xFF; out[off+3] = s1 & 0xFF;
  return out;
}

// ── Zlib decompress ──────────────────────────────────────────
function _decompressZlib(data) {
  if (typeof DecompressionStream !== 'undefined') {
    var ds     = new DecompressionStream('deflate');
    var writer = ds.writable.getWriter();
    var reader = ds.readable.getReader();
    writer.write(data);
    writer.close();
    return _readAll(reader);
  }
  return Promise.reject(new Error(
    'Multi-frame decode requires DecompressionStream (Chrome 80+, Firefox 113+, Safari 16.4+). ' +
    'Please update your browser.'
  ));
}

function _readAll(reader) {
  var chunks = [];
  function pump() {
    return reader.read().then(function (r) {
      if (r.done) {
        var total = chunks.reduce(function (s, c) { return s + c.length; }, 0);
        var out = new Uint8Array(total);
        var off = 0;
        chunks.forEach(function (c) { out.set(c, off); off += c.length; });
        return out;
      }
      chunks.push(r.value);
      return pump();
    });
  }
  return pump();
}

// ── Concatenate Uint8Arrays ──────────────────────────────────
function _concat(arrays) {
  var total = arrays.reduce(function (s, a) { return s + a.length; }, 0);
  var out   = new Uint8Array(total);
  var off   = 0;
  arrays.forEach(function (a) { out.set(a, off); off += a.length; });
  return out;
}

// ════════════════════════════════════════════════════════════════
// PUBLIC: encodeAPNG
// frames   — array of Uint8ClampedArray (RGBA, width×height×4 bytes)
// width    — pixel width (all frames same size)
// height   — pixel height
// delayMs  — per-frame delay in milliseconds
// Returns  — Promise<Uint8Array> of complete APNG file
// ════════════════════════════════════════════════════════════════
function encodeAPNG(frames, width, height, delayMs) {
  var PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, 8-bit depth, RGBA color type (6)
  var ihdr = new Uint8Array(13);
  var ihdrV = new DataView(ihdr.buffer);
  ihdrV.setUint32(0, width,  false);
  ihdrV.setUint32(4, height, false);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  // acTL: animation control — num_frames, num_plays=0 (loop forever)
  var actl  = new Uint8Array(8);
  var actlV = new DataView(actl.buffer);
  actlV.setUint32(0, frames.length, false);
  actlV.setUint32(4, 0, false); // 0 = loop forever

  // Frame delay as fraction: delayMs/1000 = (delayMs)/1000 simplified
  // Store as numerator/denominator in centiseconds:  delayMs / 1000 = (delayMs/10) / 100
  var delayNum = Math.round(delayMs / 10) || 1; // in 1/100 s units
  var delayDen = 100;

  // Compress all frames asynchronously, then assemble
  var compressPromises = frames.map(function (frame) {
    return _compressZlib(_filterRows(frame, width, height));
  });

  return Promise.all(compressPromises).then(function (compressed) {
    var parts = [PNG_SIG, _makeChunk('IHDR', ihdr), _makeChunk('acTL', actl)];
    var seqNum = 0;

    compressed.forEach(function (comp, f) {
      // fcTL: frame control
      var fctl  = new Uint8Array(26);
      var fctlV = new DataView(fctl.buffer);
      fctlV.setUint32(0,  seqNum++,  false); // sequence_number
      fctlV.setUint32(4,  width,     false); // width
      fctlV.setUint32(8,  height,    false); // height
      fctlV.setUint32(12, 0,         false); // x_offset
      fctlV.setUint32(16, 0,         false); // y_offset
      fctlV.setUint16(20, delayNum,  false); // delay_num
      fctlV.setUint16(22, delayDen,  false); // delay_den
      fctl[24] = 0; // dispose_op: NONE (keep frame visible)
      fctl[25] = 0; // blend_op:   SOURCE (replace, not composite)
      parts.push(_makeChunk('fcTL', fctl));

      if (f === 0) {
        // First frame: use IDAT (makes file viewable as static PNG by non-APNG browsers)
        parts.push(_makeChunk('IDAT', comp));
      } else {
        // Subsequent frames: fdAT with 4-byte sequence number prefix
        var fdat = new Uint8Array(4 + comp.length);
        new DataView(fdat.buffer).setUint32(0, seqNum++, false);
        fdat.set(comp, 4);
        parts.push(_makeChunk('fdAT', fdat));
      }
    });

    parts.push(_makeChunk('IEND', new Uint8Array(0)));
    return _concat(parts);
  });
}

// ════════════════════════════════════════════════════════════════
// PUBLIC: parseAPNG
// buffer — ArrayBuffer of a PNG or APNG file
// Returns Promise<{ width, height, frames: [Uint8ClampedArray], animated: bool }>
// ════════════════════════════════════════════════════════════════
function parseAPNG(buffer) {
  var data = new Uint8Array(buffer);
  var v    = new DataView(buffer);

  // Validate PNG signature
  var SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (var i = 0; i < 8; i++) {
    if (data[i] !== SIG[i]) return Promise.reject(new Error('Not a valid PNG file'));
  }

  var width = 0, height = 0;
  var animated = false;
  var offset   = 8;

  // Parsed frame structures: { chunks: [Uint8Array], seenFcTL: bool }
  var frameList     = [];
  var currentFrame  = null;
  var idatBefore    = []; // IDAT chunks before first fcTL = not-animated fallback
  var seenFcTL      = false;
  var seenIDAT      = false;

  // Parse all chunks
  while (offset + 12 <= data.length) {
    var chunkLen  = v.getUint32(offset, false);
    var chunkType = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
    var chunkData = buffer.slice(offset + 8, offset + 8 + chunkLen);
    offset += 12 + chunkLen; // length(4) + type(4) + data + crc(4)

    if (chunkType === 'IHDR') {
      var cv = new DataView(chunkData);
      width  = cv.getUint32(0, false);
      height = cv.getUint32(4, false);

    } else if (chunkType === 'acTL') {
      animated = true;

    } else if (chunkType === 'fcTL') {
      // Each fcTL marks the start of a new frame
      seenFcTL     = true;
      currentFrame = { chunks: [] };
      frameList.push(currentFrame);

    } else if (chunkType === 'IDAT') {
      seenIDAT = true;
      if (currentFrame) {
        currentFrame.chunks.push(new Uint8Array(chunkData));
      } else {
        idatBefore.push(new Uint8Array(chunkData));
      }

    } else if (chunkType === 'fdAT') {
      if (currentFrame) {
        // fdAT has a 4-byte sequence number prefix — strip it
        currentFrame.chunks.push(new Uint8Array(chunkData, 4));
      }

    } else if (chunkType === 'IEND') {
      break;
    }
  }

  // Decompress and un-filter each frame
  function decompressFrame(chunks) {
    var combined = _concat(chunks);
    return _decompressZlib(combined).then(function (raw) {
      return new Uint8ClampedArray(_unfilterRows(raw, width, height));
    });
  }

  if (!animated || frameList.length === 0) {
    // Static PNG — treat as single frame
    var chunks = idatBefore.length ? idatBefore : (frameList.length ? frameList[0].chunks : []);
    return decompressFrame(chunks).then(function (rgba) {
      return { width: width, height: height, frames: [rgba], animated: false };
    });
  }

  // APNG — decompress all frames
  return Promise.all(frameList.map(function (f) {
    return decompressFrame(f.chunks);
  })).then(function (rgbaFrames) {
    return { width: width, height: height, frames: rgbaFrames, animated: true };
  });
}

// ════════════════════════════════════════════════════════════════
// PUBLIC: parseGIF
// Synchronous GIF parser. Returns all frames as RGBA on the
// screen canvas (handles compositing + transparency).
// Returns: { width, height, frames: [{ rgba: Uint8ClampedArray, delayMs }] }
// ════════════════════════════════════════════════════════════════
function parseGIF(buffer) {
  var data = new Uint8Array(buffer);
  var off  = 0;

  function readU8()  { return data[off++]; }
  function readU16() { var v = data[off] | (data[off+1] << 8); off += 2; return v; }
  function readBytes(n) { var s = data.subarray(off, off + n); off += n; return s; }

  // Signature: "GIF87a" or "GIF89a"
  var sig = String.fromCharCode(data[0],data[1],data[2],data[3],data[4],data[5]);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('Not a GIF file');
  off = 6;

  // Logical Screen Descriptor
  var screenW    = readU16();
  var screenH    = readU16();
  var packed     = readU8();
  var bgIdx      = readU8();
  readU8(); // pixel aspect ratio (ignored)

  var hasGCT  = (packed >> 7) & 1;
  var gctSize = 1 << ((packed & 7) + 1);
  var globalCT = hasGCT ? readBytes(gctSize * 3) : null;

  var frames = [];
  var canvas = new Uint8ClampedArray(screenW * screenH * 4); // running composited frame
  var gcExt  = null; // current Graphic Control Extension

  // Helper: read sub-blocks (GIF data format)
  function readSubBlocks() {
    var out = [];
    var size;
    while ((size = readU8()) !== 0) {
      for (var i = 0; i < size; i++) out.push(data[off++]);
    }
    return new Uint8Array(out);
  }

  // GIF LZW decoder
  function lzwDecode(raw, minSize) {
    var clearCode = 1 << minSize;
    var eoi       = clearCode + 1;
    var codeSize  = minSize + 1;
    var table     = [];
    for (var i = 0; i < clearCode; i++) table[i] = new Uint8Array([i]);
    var nextCode  = eoi + 1;

    var bits     = 0;
    var bitsLeft = 0;
    var pos      = 0;
    var output   = [];

    function readCode() {
      while (bitsLeft < codeSize) {
        if (pos >= raw.length) return -1;
        bits |= raw[pos++] << bitsLeft;
        bitsLeft += 8;
      }
      var code = bits & ((1 << codeSize) - 1);
      bits >>= codeSize;
      bitsLeft -= codeSize;
      return code;
    }

    var prevCode = -1, prevEntry = null;

    while (true) {
      var code = readCode();
      if (code === -1 || code === eoi) break;

      if (code === clearCode) {
        codeSize = minSize + 1;
        table    = [];
        for (var i = 0; i < clearCode; i++) table[i] = new Uint8Array([i]);
        nextCode = eoi + 1;
        prevCode = -1; prevEntry = null;
        continue;
      }

      var entry;
      if (code < nextCode && table[code]) {
        entry = table[code];
      } else if (code === nextCode && prevEntry) {
        var p = prevEntry;
        var e = new Uint8Array(p.length + 1);
        e.set(p); e[p.length] = p[0];
        entry = e;
      } else {
        break; // corrupt
      }

      for (var i = 0; i < entry.length; i++) output.push(entry[i]);

      if (prevEntry && nextCode < 4096) {
        var ne = new Uint8Array(prevEntry.length + 1);
        ne.set(prevEntry); ne[prevEntry.length] = entry[0];
        table[nextCode++] = ne;
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
      }

      prevCode  = code;
      prevEntry = entry;
    }

    return new Uint8Array(output);
  }

  // GIF interlace reorder
  function deinterlace(indices, w, h) {
    var out    = new Uint8Array(w * h);
    var passes = [{start:0,step:8},{start:4,step:8},{start:2,step:4},{start:1,step:2}];
    var src    = 0;
    passes.forEach(function (p) {
      for (var y = p.start; y < h; y += p.step) {
        for (var x = 0; x < w; x++) out[y * w + x] = indices[src++];
      }
    });
    return out;
  }

  // Parse blocks
  while (off < data.length) {
    var block = readU8();

    if (block === 0x3B) break; // GIF trailer

    if (block === 0x21) { // Extension block
      var extType = readU8();
      if (extType === 0xF9) { // Graphic Control Extension
        readU8(); // block size = 4
        var gce_packed  = readU8();
        var gce_delay   = readU16(); // centiseconds
        var gce_trans   = readU8();
        readU8(); // terminator
        gcExt = {
          disposal:    (gce_packed >> 2) & 7,
          transparent: (gce_packed & 1) ? gce_trans : -1,
          delayMs:     gce_delay * 10 || 100
        };
      } else {
        readSubBlocks(); // skip unknown extensions
      }

    } else if (block === 0x2C) { // Image Descriptor
      var imgLeft   = readU16();
      var imgTop    = readU16();
      var imgW      = readU16();
      var imgH      = readU16();
      var imgPacked = readU8();

      var hasLCT    = (imgPacked >> 7) & 1;
      var interlaced = (imgPacked >> 6) & 1;
      var lctSize   = hasLCT ? (1 << ((imgPacked & 7) + 1)) : 0;
      var colorTable = globalCT;
      if (hasLCT) { colorTable = readBytes(lctSize * 3); }

      var minCodeSize = readU8();
      var lzwRaw      = readSubBlocks();
      var indices     = lzwDecode(lzwRaw, minCodeSize);
      if (interlaced) indices = deinterlace(indices, imgW, imgH);

      // Save canvas state for disposal method 3 (restore to previous)
      var savedCanvas = (gcExt && gcExt.disposal === 3)
        ? new Uint8ClampedArray(canvas) : null;

      // Composite frame onto canvas
      var transIdx = gcExt ? gcExt.transparent : -1;
      for (var py = 0; py < imgH; py++) {
        for (var px = 0; px < imgW; px++) {
          var idx = indices[py * imgW + px];
          if (idx === transIdx) continue; // transparent pixel — keep canvas
          var cx = imgLeft + px, cy = imgTop + py;
          if (cx >= screenW || cy >= screenH) continue;
          var di = (cy * screenW + cx) * 4;
          var ci = idx * 3;
          canvas[di]   = colorTable[ci];
          canvas[di+1] = colorTable[ci+1];
          canvas[di+2] = colorTable[ci+2];
          canvas[di+3] = 255;
        }
      }

      // Snapshot current canvas as frame
      frames.push({
        rgba:    new Uint8ClampedArray(canvas),
        delayMs: (gcExt && gcExt.delayMs) || 100
      });

      // Apply disposal method for next frame
      if (gcExt) {
        if (gcExt.disposal === 2) {
          // Restore to background: clear the frame area
          var bgR = 0, bgG = 0, bgB = 0; // default background = black
          if (globalCT && bgIdx * 3 + 2 < globalCT.length) {
            bgR = globalCT[bgIdx*3]; bgG = globalCT[bgIdx*3+1]; bgB = globalCT[bgIdx*3+2];
          }
          for (var py = imgTop; py < imgTop + imgH; py++) {
            for (var px = imgLeft; px < imgLeft + imgW; px++) {
              if (px >= screenW || py >= screenH) continue;
              var di = (py * screenW + px) * 4;
              canvas[di] = bgR; canvas[di+1] = bgG; canvas[di+2] = bgB; canvas[di+3] = 255;
            }
          }
        } else if (gcExt.disposal === 3 && savedCanvas) {
          canvas = savedCanvas; // restore previous
        }
      }

      gcExt = null;
    }
  }

  return { width: screenW, height: screenH, frames: frames };
}

// ════════════════════════════════════════════════════════════════
// PUBLIC: detectAPNG / detectGIF
// Fast detection by checking file signatures and APNG acTL chunk.
// ════════════════════════════════════════════════════════════════

function detectGIF(buffer) {
  var d   = new Uint8Array(buffer, 0, 6);
  var sig = String.fromCharCode(d[0],d[1],d[2],d[3],d[4],d[5]);
  return sig === 'GIF87a' || sig === 'GIF89a';
}

function detectAPNG(buffer) {
  var data = new Uint8Array(buffer);
  // PNG signature check
  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (var i = 0; i < 8; i++) { if (data[i] !== PNG_SIG[i]) return false; }
  // Search for acTL chunk type in first 256KB
  var limit = Math.min(data.length - 4, 262144);
  for (var i = 8; i < limit; i++) {
    if (data[i]===97 && data[i+1]===99 && data[i+2]===84 && data[i+3]===76) return true; // 'acTL'
  }
  return false;
}
