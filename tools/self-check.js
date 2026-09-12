#!/usr/bin/env node
'use strict';

/**
 * 自检脚本：不需要启动 Electron，直接验证所有纯逻辑模块。
 *
 *   node tools/self-check.js
 *
 * 检查内容：
 *   1. tray-icon.js  — 能否生成合法的 PNG（校验签名与尺寸）
 *   2. config.js     — 默认值、区间夹取、位置持久化
 *   3. speed-monitor.js — 真实读取本机网卡计数器并连续采样 4 次
 *
 * 全部通过时退出码为 0，否则为 1。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? ` :: ${detail}` : ''}`);
}

console.log('=== 1. tray-icon.js ===');
const { buildIconBuffers } = require(path.join(SRC, 'tray-icon.js'));
const { png16, png32 } = buildIconBuffers();
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG 布局：8 字节签名 + 4 长度 + 4 类型，之后就是 IHDR 的宽高
const describe = (buffer) => ({
  sig: buffer.slice(0, 8).equals(PNG_SIG),
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
  bytes: buffer.length
});
const icon16 = describe(png16);
const icon32 = describe(png32);

check('16x16 PNG 签名合法', icon16.sig);
check('16x16 尺寸正确', icon16.width === 16 && icon16.height === 16, `${icon16.width}x${icon16.height}`);
check('32x32 PNG 签名合法', icon32.sig);
check('32x32 尺寸正确', icon32.width === 32 && icon32.height === 32, `${icon32.width}x${icon32.height}`);

console.log('\n=== 2. config.js ===');
const { createConfigStore, clampInterval, clampSmoothing } = require(path.join(SRC, 'config.js'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsw-selfcheck-'));
const store = createConfigStore(tempDir);

check('默认 intervalMs = 1000', store.get('intervalMs') === 1000, String(store.get('intervalMs')));
check('下限夹取 clampInterval(10) = 250', clampInterval(10) === 250, String(clampInterval(10)));
check('上限夹取 clampInterval(99999) = 10000', clampInterval(99999) === 10000, String(clampInterval(99999)));
check('smoothing 夹取 clampSmoothing(5) = 1', clampSmoothing(5) === 1, String(clampSmoothing(5)));

store.setWindowPosition(1234, 56);
store.flush();
const reread = createConfigStore(tempDir).getWindowPosition();
check(
  '窗口位置可持久化',
  Boolean(reread) && reread.x === 1234 && reread.y === 56,
  JSON.stringify(reread)
);

console.log('\n=== 3. speed-monitor.js（真实数据源）===');
const { SpeedMonitor } = require(path.join(SRC, 'speed-monitor.js'));
const monitor = new SpeedMonitor({ intervalMs: 1000 });
const started = Date.now();
let samples = 0;
let last = null;
let settled = false;

function finish(code, message) {
  if (settled) return;
  settled = true;
  monitor.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\n${message}`);
  process.exit(code);
}

monitor.on('state', (state) => {
  console.log(`  state: ready=${state.ready} source=${state.source || '-'} msg=${state.message || '-'}`);
});
monitor.on('failure', (info) => console.log(`  retry: attempt=${info.attempt} reason=${info.reason}`));
monitor.on('sample', (sample) => {
  samples += 1;
  last = sample;
  console.log(`  sample ${samples}: 下行 ${sample.down.toFixed(0)} B/s  上行 ${sample.up.toFixed(0)} B/s`);

  if (samples >= 4) {
    const ok = Number.isFinite(sample.down) && Number.isFinite(sample.up);
    check('连续 4 次采样均为有效数值', ok);
    check('数据源已就绪', monitor.state.ready, monitor.state.source || '-');
    finish(
      failures === 0 ? 0 : 1,
      failures === 0
        ? `=== 全部通过（用时 ${Date.now() - started}ms）===`
        : `=== 有 ${failures} 项失败 ===`
    );
  }
});

monitor.start();

setTimeout(() => {
  const detail = last ? `最后一次 下行 ${last.down} / 上行 ${last.up}` : '一次都没拿到';
  check('20 秒内至少采样 4 次', false, detail);
  finish(1, `=== 有 ${failures} 项失败 ===`);
}, 20000).unref();
