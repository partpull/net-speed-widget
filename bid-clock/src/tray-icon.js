'use strict';

/**
 * 托盘图标：运行时生成，不需要任何图片资源。
 *
 * 和父项目 net-speed-widget 用的是同一套做法 —— 图形用「16×16 设计网格」上的
 * 连续坐标描述，按任意尺寸光栅化并做 4×4 超采样求平均（相当于抗锯齿），
 * 最后用一个最小 PNG 编码器（zlib deflate）编码。
 *
 * 好处是打包时不用附带 .ico/.png，也就不会出现「图标丢了」的问题。
 */

const zlib = require('zlib');

const FACE = [15, 23, 42];
const RING = [226, 232, 240];
const HAND = [248, 113, 113];

const GRID = 16;
const SUPERSAMPLE = 4;
const SIZE = 16;

/* ------------------------------------------------------------------ *
 * 形状（坐标是设计网格上的浮点数，不是像素下标）
 * ------------------------------------------------------------------ */

/** 暗色表盘：圆心 (8,8)、半径 7 */
function inFace(x, y) {
  const dx = x - 8;
  const dy = y - 8;
  return dx * dx + dy * dy <= 7 * 7;
}

/** 亮色外圈：半径 5.9 ~ 7，做成一个环 */
function inRing(x, y) {
  const dx = x - 8;
  const dy = y - 8;
  const r2 = dx * dx + dy * dy;
  return r2 <= 7 * 7 && r2 >= 5.9 * 5.9;
}

/** 指针：时针朝上、分针朝右（经典 3 点整造型），中心加粗一点 */
function inHand(x, y) {
  const vertical = Math.abs(x - 8) <= 0.6 && y >= 4.4 && y <= 8.6;
  const horizontal = Math.abs(y - 8) <= 0.6 && x >= 7.4 && x <= 11.2;
  return vertical || horizontal;
}

/* ------------------------------------------------------------------ *
 * 光栅化
 * ------------------------------------------------------------------ */

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
      if (inFace(gx, gy)) color = FACE;
      if (inRing(gx, gy)) color = RING;
      if (inHand(gx, gy)) color = HAND;
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

function renderPng(size) {
  return encodePng(size, renderIcon(size));
}

/** 返回 { png16, png32 } 两个 PNG Buffer */
function buildIconBuffers() {
  return {
    png16: renderPng(SIZE),
    png32: renderPng(SIZE * 2)
  };
}

/**
 * 生成 Electron 托盘用的 NativeImage。
 * 需要 electron 的 nativeImage，所以只在主进程里调用。
 */
function createTrayImage(nativeImage) {
  const { png16, png32 } = buildIconBuffers();
  const image = nativeImage.createFromBuffer(png16, {
    width: SIZE,
    height: SIZE,
    scaleFactor: 1
  });
  try {
    image.addRepresentation({
      scaleFactor: 2,
      width: SIZE * 2,
      height: SIZE * 2,
      buffer: png32
    });
  } catch (err) {
    /* 老版本 Electron 不支持也无所谓，16×16 够用 */
  }
  return image;
}

module.exports = { buildIconBuffers, createTrayImage, renderPng, renderIcon };

// 允许 `node src/tray-icon.js out.png` 单独导出图标，方便肉眼检查
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const target = process.argv[2] || 'tray.png';
  const { png16 } = buildIconBuffers();
  fs.writeFileSync(path.resolve(process.cwd(), target), png16);
  console.log(`wrote ${target} (${png16.length} bytes)`);
}
