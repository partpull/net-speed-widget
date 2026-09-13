'use strict';

/**
 * 开标时间相关的纯逻辑：只依赖 Date，不依赖 electron。
 *
 * 之所以单独放一个文件，是为了让 tools/self-check.js 能在不启动界面的情况下
 * 把「目标时间点算得对不对」「该不该退出」这些关键判断跑一遍。
 */

/** 设置界面里的两个常用预设（界面上还有「自定义时间」下拉，可以选任意 HH:MM） */
const BID_TIMES = ['09:30', '14:00'];

const DEFAULT_BID_TIME = BID_TIMES[0];

/** 距离开标 60 秒进入「临近」状态（界面变琥珀色） */
const SOON_MS = 60 * 1000;

/** 距离开标 10 秒进入「最后 10 秒」状态（界面变红色） */
const CRITICAL_MS = 10 * 1000;

/** 到点后先亮 1.2 秒（显示开标时刻本身），再自动退出 */
const DUE_FLASH_MS = 1200;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** '9:30' / '09:30' → { hours: 9, minutes: 30 }；非法输入返回 null */
function parseBidTime(value) {
  if (typeof value !== 'string') return null;
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!matched) return null;

  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (hours > 23 || minutes > 59) return null;

  return { hours, minutes };
}

/** 是否是一个合法的时刻字符串 */
function isBidTime(value) {
  return parseBidTime(value) !== null;
}

/** 统一成 'HH:MM'，非法时退回 fallback */
function normalizeBidTime(value, fallback = DEFAULT_BID_TIME) {
  const parsed = parseBidTime(value);
  if (!parsed) return fallback;
  return `${pad2(parsed.hours)}:${pad2(parsed.minutes)}`;
}

/** 系统时间 → 'HH:MM:SS'（悬浮窗上显示的那串数字） */
function formatClock(date) {
  const now = date instanceof Date ? date : new Date(date);
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

/** 系统时间 → 'YYYY-MM-DD' */
function formatDate(date) {
  const now = date instanceof Date ? date : new Date(date);
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * 算出「今天」的开标时刻。
 *
 * 只关心当天：开标时间到了就退出，不会等到明天 —— 这是这个挂件的全部意义。
 *
 * @param {string} bidTime 'HH:MM'
 * @param {Date}   [now]   当前时间
 * @returns {{ bidTime: string, target: Date, targetMs: number, remainingMs: number, due: boolean }|null}
 *          due = true 表示现在这一刻已经到达（或超过）开标时间
 */
function resolveTarget(bidTime, now = new Date()) {
  const parsed = parseBidTime(bidTime);
  if (!parsed) return null;

  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    parsed.hours,
    parsed.minutes,
    0,
    0
  );
  const targetMs = target.getTime();
  const nowMs = now.getTime();

  return {
    bidTime: normalizeBidTime(bidTime),
    target,
    targetMs,
    remainingMs: targetMs - nowMs,
    due: nowMs >= targetMs
  };
}

/**
 * 界面状态：
 *   due      —— 已经到了开标时间（该退出了）
 *   critical —— 最后 10 秒
 *   soon     —— 最后一分钟
 *   normal   —— 还早
 */
function phaseFor(remainingMs) {
  const value = Number(remainingMs);
  if (!Number.isFinite(value)) return 'normal';
  if (value <= 0) return 'due';
  if (value <= CRITICAL_MS) return 'critical';
  if (value <= SOON_MS) return 'soon';
  return 'normal';
}

/** 毫秒 → '1 小时 05 分 30 秒'（菜单和日志里用） */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (hours > 0) parts.push(`${pad2(minutes)} 分`);
  else if (minutes > 0) parts.push(`${minutes} 分`);
  parts.push(`${pad2(seconds)} 秒`);
  return parts.join(' ');
}

/**
 * 下一次刷新应该等多久。
 *
 * 对齐到「整秒之后再跳一下」，这样界面上的秒数不会因为定时器漂移而
 * 越走越偏（每分钟最多累积 1 秒的误差会被这一步抹平）。
 */
function nextTickDelay(nowMs = Date.now()) {
  const offset = ((nowMs % 1000) + 1000) % 1000;
  return 1000 - offset + 5;
}

module.exports = {
  BID_TIMES,
  DEFAULT_BID_TIME,
  SOON_MS,
  CRITICAL_MS,
  DUE_FLASH_MS,
  pad2,
  parseBidTime,
  isBidTime,
  normalizeBidTime,
  formatClock,
  formatDate,
  resolveTarget,
  phaseFor,
  formatDuration,
  nextTickDelay
};
