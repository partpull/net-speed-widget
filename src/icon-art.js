'use strict';

/**
 * 图标绘制 + PNG 编码（运行时托盘图标和构建期 .ico 生成共用）。
 *
 * 图形用「16×16 设计网格」上的连续坐标描述，再按任意尺寸光栅化，
 * 并做 4×4 超采样求平均（相当于抗锯齿），所以放大到 256×256 也不会有锯齿块。
 */

const zlib = require('zlib');

const BADGE = [31, 41, 55];
const DOWN = [52, 211, 153];
const UP = [96, 165, 250];

const GRID = 16;
const SUPERSAMPLE = 4;

/* ------------------------------------------------------------------ *
 * 形状（坐标是设计网格上的浮点数，不是像素下标）
 * ------------------------------------------------------------------ */

/** 圆角方块：1..15，圆角半径 3 */
function inBadge(x, y) {
  const min = 1;
  const max = 15;
  const r = 3;
  if (x < min || x > max || y < min || y > max) return false;
  const cx = Math.min(Math.max(x, min + r), max - r);
  const cy = Math.min(Math.max(y, min + r), max - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 绿色下箭头：竖杆 4..6 宽，箭头从 y=11 收到 y=13 的顶点 (5,13) */
function inDownArrow(x, y) {
  if (x >= 4 && x <= 6 && y >= 3 && y <= 11) return true;
  if (y >= 11 && y <= 13) {
    const half = 2 * ((13 - y) / 2);
    return Math.abs(x - 5) <= half;
  }
  return false;
}

/** 蓝色上箭头：顶点 (11,3) 张开到 y=5，竖杆 10..12 宽 */
function inUpArrow(x, y) {
  if (x >= 10 && x <= 12 && y >= 5 && y <= 13) return true;
  if (y >= 3 && y <= 5) {
    const half = 2 * ((y - 3) / 2);
    return Math.abs(x - 11) <= half;
  }
  return false;
}

/**
 * 光栅化成 size×size 的 RGBA Buffer。
 * 颜色按覆盖率加权求平均，避免边缘出现黑边。
 */
function renderIcon(size) {
  if (!Number.isInteger(size) || size < 4) {
    throw new Error(`renderIcon: 非法尺寸 ${size}`);
  }

  const hi = size * SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const sum = new Float64Array(size * size * 4);

  for (let hy = 0; hy < hi; hy += 1) {
    const gy = ((hy + 0.5) / hi) * GRID;
    const oy = (hy / SUPERSAMPLE) | 0;
    for (let hx = 0; hx < hi; hx += 1) {
      const gx = ((hx + 0.5) / hi) * GRID;

      let color = null;
      if (inBadge(gx, gy)) color = BADGE;
      if (inDownArrow(gx, gy)) color = DOWN;
      if (inUpArrow(gx, gy)) color = UP;
      if (!color) continue;

      const o = (oy * size + ((hx / SUPERSAMPLE) | 0)) * 4;
      sum[o] += color[0];
      sum[o + 1] += color[1];
      sum[o + 2] += color[2];
      sum[o + 3] += 255;
    }
  }

  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const o = i * 4;
    const coverage = sum[o + 3] / samples;
    if (coverage <= 0) continue;
    const covered = sum[o + 3] / 255;
    rgba[o] = Math.round(sum[o] / covered);
    rgba[o + 1] = Math.round(sum[o + 1] / covered);
    rgba[o + 2] = Math.round(sum[o + 2] / covered);
    rgba[o + 3] = Math.round(coverage);
  }
  return rgba;
}

/* ------------------------------------------------------------------ *
 * 最小 PNG 编码器（RGBA / 8bit）
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** 生成图标并直接编码为 PNG */
function renderPng(size) {
  return encodePng(size, renderIcon(size));
}

module.exports = {
  renderIcon,
  renderPng,
  encodePng,
  crc32,
  GRID,
  SUPERSAMPLE,
  COLORS: { BADGE, DOWN, UP }
};
