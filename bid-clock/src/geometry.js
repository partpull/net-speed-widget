'use strict';

/**
 * 窗口几何：等比缩放相关的纯计算，不依赖 electron。
 *
 * 悬浮钟只有一个自由度 —— 高度。宽度永远 = 高度 × 宽高比，
 * 所以只要保证「高度算对了」，横宽比就不会变。
 */

const MIN_HEIGHT = 56;
const MAX_HEIGHT = 420;
const DEFAULT_HEIGHT = 150;

const MIN_ASPECT = 1.5;
const MAX_ASPECT = 8;
/** 兜底宽高比：渲染进程还没量出真实值之前先用它 */
const DEFAULT_ASPECT = 3.6;

/** 菜单里的「窗口大小」预设（高度，单位 px） */
const PRESET_HEIGHTS = {
  small: 96,
  medium: 150,
  large: 240
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampHeight(value, fallback = DEFAULT_HEIGHT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return clamp(Math.round(number), MIN_HEIGHT, MAX_HEIGHT);
}

function clampAspect(value, fallback = DEFAULT_ASPECT) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return clamp(number, MIN_ASPECT, MAX_ASPECT);
}

/** 高度 → 等比的 { width, height }（宽度向上取整，宁可多一个像素也不要挤到字） */
function sizeForHeight(height, aspect) {
  const safeHeight = clampHeight(height);
  const safeAspect = clampAspect(aspect);
  return {
    width: Math.ceil(safeHeight * safeAspect),
    height: safeHeight
  };
}

/**
 * 拖动右下角手柄时的新高度。
 *
 * 竖直方向（dy）和水平方向（dx / 宽高比）都能推算出「想要多高」，
 * 取绝对值更大的那个：
 *   - 往右下拖 → 变大，往左上拖 → 变小，方向都符合直觉；
 *   - 斜着拖、只往一个方向拖都能缩放，不会算成负数；
 *   - 缩小的时候也成立（这里不能用 max，否则往回拖永远减不下去）。
 */
function heightFromDrag({
  startHeight,
  dx = 0,
  dy = 0,
  aspect = DEFAULT_ASPECT,
  minHeight = MIN_HEIGHT,
  maxHeight = MAX_HEIGHT
}) {
  const base = clampHeight(startHeight);
  const safeAspect = clampAspect(aspect);
  const byVertical = Number(dy) || 0;
  const byHorizontal = (Number(dx) || 0) / safeAspect;
  const delta = Math.abs(byVertical) >= Math.abs(byHorizontal) ? byVertical : byHorizontal;
  return clamp(Math.round(base + delta), minHeight, maxHeight);
}

/**
 * 把窗口挪回屏幕内（只挪进入视野，尺寸不动）。
 *
 * 放大窗口时右/下边可能跑到屏幕外，这一步负责拉回来，
 * 免得用户「把挂件弄丢了」。
 */
function keepOnScreen(bounds, workArea) {
  const maxX = workArea.x + workArea.width - bounds.width;
  const maxY = workArea.y + workArea.height - bounds.height;
  return {
    x: clamp(bounds.x, workArea.x, Math.max(workArea.x, maxX)),
    y: clamp(bounds.y, workArea.y, Math.max(workArea.y, maxY))
  };
}

/** 默认位置：主屏工作区右上角 */
function defaultPosition(workArea, size, margin = 12) {
  return {
    x: workArea.x + workArea.width - size.width - margin,
    y: workArea.y + margin
  };
}

module.exports = {
  MIN_HEIGHT,
  MAX_HEIGHT,
  DEFAULT_HEIGHT,
  MIN_ASPECT,
  MAX_ASPECT,
  DEFAULT_ASPECT,
  PRESET_HEIGHTS,
  clamp,
  clampHeight,
  clampAspect,
  sizeForHeight,
  heightFromDrag,
  keepOnScreen,
  defaultPosition
};
