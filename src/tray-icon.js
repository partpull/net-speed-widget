'use strict';

/**
 * 托盘图标：运行时生成，不需要任何图片资源。
 *
 * 图形本身描述在 icon-art.js 里（和打包用的 build\icon.ico 共用同一套形状），
 * 这里只负责把它交给 Electron 的 nativeImage。
 * 好处是打包时不必附带 .ico/.png 资源，也就不会出现「图标丢了」的问题。
 */

const path = require('path');
const { renderPng } = require('./icon-art');

const SIZE = 16;

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

module.exports = { buildIconBuffers, createTrayImage };

// 允许 `node src/tray-icon.js out.png` 单独导出图标，方便检查
if (require.main === module) {
  const fs = require('fs');
  const target = process.argv[2] || 'tray.png';
  const { png16 } = buildIconBuffers();
  fs.writeFileSync(path.resolve(process.cwd(), target), png16);
  console.log(`wrote ${target} (${png16.length} bytes)`);
}
