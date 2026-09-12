#!/usr/bin/env node
'use strict';

/**
 * 命令行验证工具：不开 Electron 也能确认网卡计数器是否正常。
 *
 *   node tools/speed-cli.js [秒数] [间隔毫秒]
 *   node tools/speed-cli.js 10 1000
 */

const path = require('path');
const { SpeedMonitor } = require(path.join(__dirname, '..', 'src', 'speed-monitor'));

const seconds = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 8;
const intervalMs = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 1000;

const UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];

function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value < 0) return '--';
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < UNITS.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  let text;
  if (unitIndex === 0) text = String(Math.round(scaled));
  else if (scaled >= 100) text = scaled.toFixed(0);
  else if (scaled >= 10) text = scaled.toFixed(1);
  else text = scaled.toFixed(2);
  return `${text} ${UNITS[unitIndex]}`;
}

console.log(`平台: ${process.platform}   刷新间隔: ${intervalMs}ms   采样时长: ${seconds}s`);
console.log('提示：先随便下载/上传点东西，数字应该跟着动。\n');

const monitor = new SpeedMonitor({ intervalMs, smoothing: 0.5 });

monitor.on('state', (state) => {
  if (state.ready) {
    console.log(`[状态] 数据源就绪: ${state.source}`);
  } else {
    console.log(`[状态] 等待中: ${state.message}`);
  }
});

monitor.on('sample', (sample) => {
  const time = new Date(sample.at).toLocaleTimeString('zh-CN', { hour12: false });
  console.log(
    `${time}  ↓ ${formatSpeed(sample.down).padStart(10)}   ↑ ${formatSpeed(sample.up).padStart(10)}`
  );
});

monitor.on('failure', ({ reason, attempt }) => {
  console.log(`[重试] 第 ${attempt} 次失败: ${reason}`);
});

monitor.start();

setTimeout(() => {
  monitor.stop();
  console.log('\n完成。');
  process.exit(0);
}, seconds * 1000);
