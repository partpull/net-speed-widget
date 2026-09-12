'use strict';

const UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];

const widgetEl = document.getElementById('widget');
const downEl = document.getElementById('down');
const upEl = document.getElementById('up');

/** 给阴影留出的窗口边距，避免投影被窗口边界裁掉 */
const SHADOW_MARGIN = 12;

let lastSize = { width: 0, height: 0 };

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
  if (unitIndex === 0) {
    text = String(Math.round(scaled));
  } else if (scaled >= 100) {
    text = scaled.toFixed(0);
  } else if (scaled >= 10) {
    text = scaled.toFixed(1);
  } else {
    text = scaled.toFixed(2);
  }

  return `${text} ${UNITS[unitIndex]}`;
}

function reportSize() {
  const rect = widgetEl.getBoundingClientRect();
  const width = Math.ceil(rect.width) + SHADOW_MARGIN;
  const height = Math.ceil(rect.height) + SHADOW_MARGIN;
  if (Math.abs(width - lastSize.width) < 2 && Math.abs(height - lastSize.height) < 2) {
    return;
  }
  lastSize = { width, height };
  window.netSpeed.reportSize(width, height);
}

function applySample(sample) {
  if (!sample) return;
  downEl.textContent = formatSpeed(sample.down);
  upEl.textContent = formatSpeed(sample.up);
  widgetEl.classList.remove('is-idle', 'is-error');
  widgetEl.title = `下载 ${formatSpeed(sample.down)} / 上传 ${formatSpeed(sample.up)}`;
  reportSize();
}

function applyState(state) {
  if (!state || state.ready) return;
  downEl.textContent = '--';
  upEl.textContent = '--';
  widgetEl.classList.toggle('is-error', Boolean(state.message));
  widgetEl.classList.toggle('is-idle', !state.message);
  widgetEl.title = state.message || '正在读取网速…';
  reportSize();
}

window.netSpeed.onSample(applySample);
window.netSpeed.onState(applyState);

/* 右键 → 原生菜单 */
window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.netSpeed.openMenu();
});

/* 左键按住拖动整个窗口（自己实现，避免 -webkit-app-region: drag 抢走鼠标事件） */
widgetEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  try {
    widgetEl.setPointerCapture(event.pointerId);
  } catch (err) {
    /* 忽略 */
  }
  window.netSpeed.startDrag();
});

const stopDrag = () => window.netSpeed.endDrag();
widgetEl.addEventListener('pointerup', stopDrag);
widgetEl.addEventListener('pointercancel', stopDrag);
widgetEl.addEventListener('lostpointercapture', stopDrag);

/* 首帧先量一次尺寸，让窗口贴合内容 */
requestAnimationFrame(reportSize);
