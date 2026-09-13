#!/usr/bin/env node
'use strict';

/**
 * 自检脚本：不需要启动 Electron，直接把纯逻辑跑一遍。
 *
 *   node tools/self-check.js
 *
 * 检查内容：
 *   1. tray-icon.js — 能否生成合法的 PNG（校验签名与尺寸）
 *   2. schedule.js  — 目标时间点、到点判断、界面状态、时长文案
 *   3. geometry.js  — 高度/宽高比夹取、等比缩放换算、窗口拉回屏幕
 *   4. config.js    — 默认值、脏数据兜底、读写持久化
 *
 * 全部通过时退出码为 0，否则为 1。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const STARTED_AT = Date.now();

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? ` :: ${detail}` : ''}`);
}

/* ---------------------------------------------------------------- *
 * 1. tray-icon.js
 * ---------------------------------------------------------------- */

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

/* ---------------------------------------------------------------- *
 * 2. schedule.js
 * ---------------------------------------------------------------- */

console.log('\n=== 2. schedule.js ===');
const {
  BID_TIMES,
  parseBidTime,
  isBidTime,
  normalizeBidTime,
  formatClock,
  formatDate,
  resolveTarget,
  phaseFor,
  formatDuration,
  nextTickDelay
} = require(path.join(SRC, 'schedule.js'));

check('两个预设就是 09:30 / 14:00', BID_TIMES.join(',') === '09:30,14:00', BID_TIMES.join(','));
check(
  "parseBidTime('9:30')",
  JSON.stringify(parseBidTime('9:30')) === '{"hours":9,"minutes":30}',
  JSON.stringify(parseBidTime('9:30'))
);
check(
  "parseBidTime('14:00')",
  JSON.stringify(parseBidTime('14:00')) === '{"hours":14,"minutes":0}',
  JSON.stringify(parseBidTime('14:00'))
);
check('非法时间返回 null', parseBidTime('25:00') === null && parseBidTime('') === null && parseBidTime(null) === null);
check("normalizeBidTime('9:30') → '09:30'", normalizeBidTime('9:30') === '09:30', normalizeBidTime('9:30'));
check('非法输入退回默认 09:30', normalizeBidTime('乱写') === '09:30', normalizeBidTime('乱写'));
check("isBidTime('14:00') 且 isBidTime('x') 为假", isBidTime('14:00') === true && isBidTime('x') === false);

const sample = new Date(2026, 0, 2, 9, 5, 7); // 2026-01-02 09:05:07（本地时间）
check('formatClock 补零正确', formatClock(sample) === '09:05:07', formatClock(sample));
check('formatDate 补零正确', formatDate(sample) === '2026-01-02', formatDate(sample));

const before = resolveTarget('09:30', new Date(2026, 0, 2, 8, 30, 0));
check('08:30 → 距 09:30 还有 1 小时', before.remainingMs === 3600000 && before.due === false, String(before.remainingMs));
check('目标时间落在当天 09:30:00', formatClock(before.target) === '09:30:00', formatClock(before.target));

const exact = resolveTarget('09:30', new Date(2026, 0, 2, 9, 30, 0));
check('09:30:00 整点就算到点（due=true）', exact.due === true && exact.remainingMs === 0, String(exact.remainingMs));

const past = resolveTarget('09:30', new Date(2026, 0, 2, 9, 30, 1));
check('09:30:01 已经过点', past.due === true, String(past.remainingMs));

const noon = resolveTarget('14:00', new Date(2026, 0, 2, 12, 0, 0));
check('12:00 → 距 14:00 还有 2 小时', noon.remainingMs === 7200000, String(noon.remainingMs));
check('非法时间返回 null', resolveTarget('99:99') === null);

// 自定义时间：设置界面里小时/分钟随便是多少都应该能用
const custom = resolveTarget('15:45', new Date(2026, 0, 2, 15, 0, 0));
check("自定义 '15:45'：15:00 时距开标 45 分钟", Boolean(custom) && custom.remainingMs === 2700000,
  String(custom && custom.remainingMs));
check("自定义 '7:05' 规范成 '07:05'", normalizeBidTime('7:05') === '07:05' && isBidTime('7:05') === true,
  normalizeBidTime('7:05'));

const midnight = resolveTarget('23:59', new Date(2026, 0, 2, 23, 58, 0));
check("边界 '23:59'：23:58 时还有 1 分钟", Boolean(midnight) && midnight.remainingMs === 60000,
  String(midnight && midnight.remainingMs));
check("边界：'23:59' 合法，'24:00' / '12:60' 非法",
  isBidTime('23:59') === true && isBidTime('24:00') === false && isBidTime('12:60') === false);

check('phaseFor：2 分钟 = normal', phaseFor(120000) === 'normal', phaseFor(120000));
check('phaseFor：60 秒 = soon', phaseFor(60000) === 'soon', phaseFor(60000));
check('phaseFor：10 秒 = critical', phaseFor(10000) === 'critical', phaseFor(10000));
check('phaseFor：0 = due', phaseFor(0) === 'due', phaseFor(0));
check('phaseFor：负数也是 due', phaseFor(-1) === 'due', phaseFor(-1));

check('formatDuration 1 小时 05 分 05 秒', formatDuration(3905000) === '1 小时 05 分 05 秒', formatDuration(3905000));
check('formatDuration 1 分 05 秒', formatDuration(65000) === '1 分 05 秒', formatDuration(65000));
check('formatDuration 05 秒', formatDuration(5000) === '05 秒', formatDuration(5000));

check(
  'nextTickDelay 对齐到下一秒',
  nextTickDelay(1000) === 1005 && nextTickDelay(1500) === 505 && nextTickDelay(1999) === 6,
  `${nextTickDelay(1000)} / ${nextTickDelay(1500)} / ${nextTickDelay(1999)}`
);

/* ---------------------------------------------------------------- *
 * 3. geometry.js
 * ---------------------------------------------------------------- */

console.log('\n=== 3. geometry.js ===');
const {
  MIN_HEIGHT,
  MAX_HEIGHT,
  DEFAULT_HEIGHT,
  clampHeight,
  clampAspect,
  sizeForHeight,
  heightFromDrag,
  keepOnScreen,
  defaultPosition
} = require(path.join(SRC, 'geometry.js'));

check('高度下限 56 / 上限 420', MIN_HEIGHT === 56 && MAX_HEIGHT === 420, `${MIN_HEIGHT} / ${MAX_HEIGHT}`);
check('clampHeight(10) = 56', clampHeight(10) === 56, String(clampHeight(10)));
check('clampHeight(9999) = 420', clampHeight(9999) === 420, String(clampHeight(9999)));
check('clampHeight(乱写) = 150', clampHeight('乱写') === DEFAULT_HEIGHT, String(clampHeight('乱写')));
check('clampAspect(100) = 8', clampAspect(100) === 8, String(clampAspect(100)));
check('clampAspect(0) = 3.6', clampAspect(0) === 3.6, String(clampAspect(0)));

const size = sizeForHeight(150, 3.6);
check('sizeForHeight(150, 3.6) = 540x150', size.width === 540 && size.height === 150, `${size.width}x${size.height}`);

const dragDown = heightFromDrag({ startHeight: 150, dy: 50, aspect: 3.6 });
check('竖直拖动：+50 → 200', dragDown === 200, String(dragDown));
const dragRight = heightFromDrag({ startHeight: 150, dx: 180, aspect: 3.6 });
check('水平拖动：+180 → 200', dragRight === 200, String(dragRight));
const dragBack = heightFromDrag({ startHeight: 150, dy: -50, aspect: 3.6 });
check('往回拖：-50 → 100', dragBack === 100, String(dragBack));
check('拖过头也不会负数：-10000 → 56', heightFromDrag({ startHeight: 150, dy: -10000 }) === MIN_HEIGHT);
check('拖到头也不会疯长：+10000 → 420', heightFromDrag({ startHeight: 150, dy: 10000 }) === MAX_HEIGHT);

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const pulled = keepOnScreen({ x: -50, y: -50, width: 540, height: 150 }, workArea);
check('窗口左上跑出去会被拉回 (0,0)', pulled.x === 0 && pulled.y === 0, JSON.stringify(pulled));
const pushed = keepOnScreen({ x: 1900, y: 1000, width: 540, height: 150 }, workArea);
check('窗口右下跑出去会被拉回 (1380,890)', pushed.x === 1380 && pushed.y === 890, JSON.stringify(pushed));

const corner = defaultPosition(workArea, { width: 540, height: 150 }, 12);
check('默认位置在主屏右上角 (1368,12)', corner.x === 1368 && corner.y === 12, JSON.stringify(corner));

/* ---------------------------------------------------------------- *
 * 4. config.js
 * ---------------------------------------------------------------- */

console.log('\n=== 4. config.js ===');
const { createConfigStore, sanitize } = require(path.join(SRC, 'config.js'));

const defaults = sanitize(null);
check('默认还没选过开标时间', defaults.bidTime === null, String(defaults.bidTime));
check(
  '默认高度 150 / 宽高比 3.6',
  defaults.height === DEFAULT_HEIGHT && defaults.aspect === 3.6,
  `${defaults.height} / ${defaults.aspect}`
);

const dirty = sanitize({ bidTime: '99:99', height: 99999, aspect: 'x', window: { x: 'a', y: 3 } });
check('脏数据：非法时间归 null', dirty.bidTime === null, String(dirty.bidTime));
check('脏数据：高度夹到 420', dirty.height === MAX_HEIGHT, String(dirty.height));
check('脏数据：宽高比回到 3.6', dirty.aspect === 3.6, String(dirty.aspect));

const cleaned = sanitize({ bidTime: '9:30', height: 200, aspect: 4.1 });
check("合法值会规范化：'9:30' → '09:30'", cleaned.bidTime === '09:30', String(cleaned.bidTime));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidclock-selfcheck-'));
const store = createConfigStore(tempDir);
check('空目录启动用默认值', store.get('bidTime') === null && store.get('height') === DEFAULT_HEIGHT);

store.setBidTime('14:00');
store.setHeight(240);
store.setWindowPosition(1234, 56);
store.flush();

const reread = createConfigStore(tempDir);
const rereadPosition = reread.getWindowPosition();
check('开标时间可持久化', reread.get('bidTime') === '14:00', String(reread.get('bidTime')));
check('窗口高度可持久化', reread.get('height') === 240, String(reread.get('height')));
check(
  '窗口位置可持久化',
  Boolean(rereadPosition) && rereadPosition.x === 1234 && rereadPosition.y === 56,
  JSON.stringify(rereadPosition)
);

reread.setBidTime('乱写');
check('非法值不会写进配置', reread.get('bidTime') === null, String(reread.get('bidTime')));

fs.rmSync(tempDir, { recursive: true, force: true });

console.log(
  failures === 0
    ? `\n=== 全部通过（用时 ${Date.now() - STARTED_AT}ms）===`
    : `\n=== 有 ${failures} 项失败 ===`
);
process.exit(failures === 0 ? 0 : 1);
