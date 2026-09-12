#!/usr/bin/env node
'use strict';

/**
 * 生成 Windows 打包用的多尺寸 .ico，外加一张 256×256 的 PNG 预览。
 *
 *   node tools/make-icon.js
 *
 * 产物：
 *   build/icon.ico       给 electron-builder 用（package.json 的 build.win.icon）
 *   build/icon-256.png   预览图，方便肉眼确认
 *
 * 图形来自 src/icon-art.js，和运行时托盘图标是同一套形状，改一处两边都变。
 * 小尺寸写 DIB（兼容性最好），128/256 写 PNG（Windows Vista+ 支持，体积小很多）。
 */

const fs = require('fs');
const path = require('path');

const { renderIcon, renderPng, GRID, COLORS } = require(path.join(__dirname, '..', 'src', 'icon-art'));

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');

const DIB_SIZES = [16, 24, 32, 48, 64];
const PNG_SIZES = [128, 256];
const ALL_SIZES = DIB_SIZES.concat(PNG_SIZES);

const pngCache = new Map();
function cachedPng(size) {
  if (!pngCache.has(size)) pngCache.set(size, renderPng(size));
  return pngCache.get(size);
}

/* ------------------------------------------------------------------ *
 * DIB：BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码
 * ------------------------------------------------------------------ */

function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight（AND 掩码算一半，所以 ×2）
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4; // DIB 是底朝上的
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }

  // AND 掩码：1bpp，每行补齐到 4 字节；全 0，透明度交给 alpha 通道
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size);

  return Buffer.concat([header, pixels, mask]);
}

/* ------------------------------------------------------------------ *
 * ICO 容器
 * ------------------------------------------------------------------ */

function buildIco() {
  const images = ALL_SIZES.map((size) =>
    PNG_SIZES.includes(size)
      ? { size, data: cachedPng(size), isPng: true }
      : { size, data: encodeDib(renderIcon(size), size), isPng: false }
  );

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = 1 (icon)
  dir.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map((image) => {
    const entry = Buffer.alloc(16);
    // 256 在 ICO 里记作 0
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0; // 调色板颜色数
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.data.length;
    return entry;
  });

  return Buffer.concat([dir, ...entries, ...images.map((image) => image.data)]);
}

/* ------------------------------------------------------------------ *
 * 校验：把刚写出的 ICO 再解析一遍
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parseIco(buffer) {
  if (buffer.readUInt16LE(0) !== 0) throw new Error('ICONDIR.reserved 应为 0');
  if (buffer.readUInt16LE(2) !== 1) throw new Error('ICONDIR.type 应为 1');
  const count = buffer.readUInt16LE(4);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    const width = buffer[base] === 0 ? 256 : buffer[base];
    const height = buffer[base + 1] === 0 ? 256 : buffer[base + 1];
    const bpp = buffer.readUInt16LE(base + 6);
    const bytes = buffer.readUInt32LE(base + 8);
    const offset = buffer.readUInt32LE(base + 12);
    if (offset + bytes > buffer.length) throw new Error(`第 ${i} 项越界`);
    if (bytes === 0) throw new Error(`第 ${i} 项长度为 0`);

    const payload = buffer.slice(offset, offset + bytes);
    const isPng = payload.slice(0, 8).equals(PNG_SIGNATURE);
    if (isPng) {
      if (payload.readUInt32BE(16) !== width) throw new Error(`第 ${i} 项 PNG 宽度不匹配`);
      if (payload.readUInt32BE(20) !== height) throw new Error(`第 ${i} 项 PNG 高度不匹配`);
    } else {
      const biSize = payload.readUInt32LE(0);
      const biWidth = payload.readInt32LE(4);
      const biHeight = payload.readInt32LE(8);
      if (biSize !== 40) throw new Error(`第 ${i} 项 BITMAPINFOHEADER 大小异常`);
      if (biWidth !== width || biHeight !== height * 2) throw new Error(`第 ${i} 项 DIB 尺寸不匹配`);
    }
    out.push({ width, height, bpp, bytes, isPng });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 取样校验：确认图形结构正确（比肉眼看更可靠，也便于长期回归）
 * ------------------------------------------------------------------ */

/** 按设计网格坐标取一个像素（网格 0..16） */
function sample(rgba, size, gx, gy) {
  const x = Math.min(size - 1, Math.max(0, Math.round((gx / GRID) * size)));
  const y = Math.min(size - 1, Math.max(0, Math.round((gy / GRID) * size)));
  const o = (y * size + x) * 4;
  return { r: rgba[o], g: rgba[o + 1], b: rgba[o + 2], a: rgba[o + 3] };
}

function sameRgb(actual, expected, tolerance = 2) {
  return (
    Math.abs(actual.r - expected[0]) <= tolerance &&
    Math.abs(actual.g - expected[1]) <= tolerance &&
    Math.abs(actual.b - expected[2]) <= tolerance
  );
}

/** 统计区域 [x0,x1) x [y0,y1)（设计网格坐标）里 0 < alpha < 255 的像素数 */
function partialAlphaCount(rgba, size, x0, y0, x1, y1) {
  const px0 = Math.max(0, Math.floor((x0 / GRID) * size));
  const py0 = Math.max(0, Math.floor((y0 / GRID) * size));
  const px1 = Math.min(size, Math.ceil((x1 / GRID) * size));
  const py1 = Math.min(size, Math.ceil((y1 / GRID) * size));

  let count = 0;
  for (let y = py0; y < py1; y += 1) {
    for (let x = px0; x < px1; x += 1) {
      const a = rgba[(y * size + x) * 4 + 3];
      if (a > 0 && a < 255) count += 1;
    }
  }
  return count;
}

function verifyArt(size) {
  const rgba = renderIcon(size);
  const at = (gx, gy) => sample(rgba, size, gx, gy);
  const solid = (gx, gy, color) => {
    const p = at(gx, gy);
    return p.a === 255 && sameRgb(p, color);
  };

  const checks = [
    ['左上角全透明', () => at(0.4, 0.4).a === 0],
    ['右下角全透明', () => at(15.6, 15.6).a === 0],
    ['右边缘外全透明', () => at(15.6, 8).a === 0],
    ['下箭头是绿色', () => solid(5, 8, COLORS.DOWN)],
    ['上箭头是蓝色', () => solid(11, 8, COLORS.UP)],
    ['箭头之间是底色', () => solid(8, 8, COLORS.BADGE)],
    ['顶部是底色', () => solid(8, 4, COLORS.BADGE)],
    ['底部是底色', () => solid(8, 14.2, COLORS.BADGE)],
    ['左上圆角有抗锯齿', () => partialAlphaCount(rgba, size, 1, 1, 5, 5) >= 4],
    ['右下圆角有抗锯齿', () => partialAlphaCount(rgba, size, 11, 11, 15, 15) >= 4],
    ['整体有透明背景', () => at(0.4, 8).a === 0]
  ];

  return checks.map(([label, run]) => {
    let ok = false;
    try {
      ok = Boolean(run());
    } catch (err) {
      ok = false;
    }
    return { label, ok };
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

fs.mkdirSync(OUT_DIR, { recursive: true });

const startedAt = Date.now();
const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(icoPath, buildIco());

const previewPath = path.join(OUT_DIR, 'icon-256.png');
fs.writeFileSync(previewPath, cachedPng(256));

console.log(`build/icon.ico  ${fs.statSync(icoPath).size} bytes  (${Date.now() - startedAt}ms)`);
for (const entry of parseIco(fs.readFileSync(icoPath))) {
  const dims = `${entry.width}x${entry.height}`.padEnd(8);
  console.log(`  ${dims} ${String(entry.bpp).padStart(2)}bpp  ${entry.isPng ? 'PNG' : 'DIB'}  ${entry.bytes} bytes`);
}
console.log(`build/icon-256.png  ${fs.statSync(previewPath).size} bytes`);
console.log('ICO 结构校验通过');
console.log('');

let failures = 0;
for (const size of [16, 32, 256]) {
  console.log(`图形取样 @ ${size}x${size}:`);
  for (const result of verifyArt(size)) {
    if (!result.ok) failures += 1;
    console.log(`  ${result.ok ? 'OK  ' : 'FAIL'} ${result.label}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} 项图形校验失败`);
  process.exit(1);
}
console.log('\n图形取样校验全部通过');
