'use strict';

/**
 * 悬浮钟渲染进程：只做三件事
 *   1. 量出「00:00:00」这串字需要多宽，算出窗口宽高比 → 告诉主进程
 *   2. 把主进程每秒推来的时间塞进界面
 *   3. 把拖动 / 缩放手势转成 IPC
 *
 * 时间不在这一层算：读系统时间、判断是否到点，全都由主进程统一负责，
 * 这样界面只是个「显示器」，不存在两处逻辑不一致的问题。
 */

const clockEl = document.getElementById('clock');
const digitsEl = document.getElementById('digits');
const gripEl = document.getElementById('grip');

/** 量字宽用的参考字号（px）；具体多少不影响比例 */
const REF_FONT_SIZE = 100;
/** 字外围留白 = 字号的 6%，必须和 style.css 里的 padding 保持一致 */
const PADDING_RATIO = 0.06;
/** 量出来的字宽再放宽 3%，不同机器字体度量略有差异时也不会被裁掉 */
const WIDTH_SLACK = 1.03;
/** 兜底：拿不到字体度量时按「约 4.4 个字宽」估算 */
const FALLBACK_TEXT_WIDTH = REF_FONT_SIZE * 4.4;

/**
 * 算窗口宽高比和字号。
 *
 * 字号用 vh 表示，所以窗口一旦被拉大，字会跟着等比变大 ——
 * 不需要在 resize 事件里再做任何事，横宽比也就永远不变。
 */
function measureGeometry() {
  const styles = getComputedStyle(clockEl);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  let textWidth = 0;
  try {
    ctx.font = `${styles.fontStyle} ${styles.fontWeight} ${REF_FONT_SIZE}px ${styles.fontFamily}`;
    // 字体串解析失败时浏览器会悄悄换成默认字体，用字号做个体检
    if (String(ctx.font).includes(`${REF_FONT_SIZE}px`)) {
      textWidth = ctx.measureText('00:00:00').width;
    }
  } catch (err) {
    textWidth = 0;
  }

  if (!(textWidth > 0)) textWidth = FALLBACK_TEXT_WIDTH;

  const padding = REF_FONT_SIZE * PADDING_RATIO * 2;
  const boxWidth = textWidth * WIDTH_SLACK + padding;
  const boxHeight = REF_FONT_SIZE + padding;

  return {
    aspect: boxWidth / boxHeight,
    fontVh: (REF_FONT_SIZE / boxHeight) * 100
  };
}

function applyGeometry(geometry) {
  document.documentElement.style.setProperty('--clock-font-size', `${geometry.fontVh}vh`);
  window.bidClock.reportGeometry(geometry);
}

function render(tick) {
  if (!tick) return;
  if (typeof tick.text === 'string') digitsEl.textContent = tick.text;
  clockEl.dataset.phase = tick.phase || 'normal';

  if (tick.phase === 'due') {
    clockEl.title = `已到开标时间${tick.bidTime ? ` ${tick.bidTime}` : ''}`;
  } else if (tick.bidTime) {
    clockEl.title = `开标时间 ${tick.bidTime}　拖动可移动，右键打开菜单`;
  } else {
    clockEl.title = '拖动可移动，右键打开菜单';
  }
}

/* 拖动窗口移动（自己实现，避免 -webkit-app-region: drag 抢走鼠标事件） */
clockEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  try {
    clockEl.setPointerCapture(event.pointerId);
  } catch (err) {
    /* 忽略 */
  }
  window.bidClock.startDrag();
});

const stopDrag = () => window.bidClock.endDrag();
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
  clockEl.addEventListener(type, stopDrag);
});

/* 右下角手柄：等比缩放（宽度由主进程按宽高比算） */
gripEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    gripEl.setPointerCapture(event.pointerId);
  } catch (err) {
    /* 忽略 */
  }
  window.bidClock.startResize();
});

const stopResize = () => window.bidClock.endResize();
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
  gripEl.addEventListener(type, stopResize);
});

/* 右键 → 原生菜单（改时间 / 缩放 / 退出） */
window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.bidClock.openMenu();
});

/* 别让浏览器自带的拖拽/选中干扰手势 */
document.addEventListener('dragstart', (event) => event.preventDefault());

window.bidClock.onTick(render);

/* 先量尺寸再报告：主进程拿到宽高比后才会把窗口显示出来 */
applyGeometry(measureGeometry());
