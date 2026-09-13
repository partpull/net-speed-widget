'use strict';

/**
 * 设置界面：09:30 / 14:00 两个预设按钮 + 「自定义时间」两个下拉（小时 / 分钟）
 *
 * 预设由主进程给的 BID_TIMES 生成，避免界面和逻辑两处各写一份时间常量；
 * 下拉里的小时/分钟范围属于界面本身的事，就地生成。
 * 点一下就把选择交给主进程：它负责存配置、建悬浮钟、安排到点退出。
 */

const optionsEl = document.getElementById('options');
const statusEl = document.getElementById('status');
const footEl = document.getElementById('foot');
const closeEl = document.getElementById('close');
const headEl = document.getElementById('head');
const customEl = document.getElementById('custom');
const hourEl = document.getElementById('hour');
const minuteEl = document.getElementById('minute');
const applyEl = document.getElementById('apply');
const hintEl = document.getElementById('custom-hint');
const warnEl = document.getElementById('warn');

const FOOT_TIP = '拖动标题栏移动窗口；悬浮钟拖右下角可等比缩放。';

/**
 * 兜底选项：主进程的 setup:state 到达之前先把两个按钮画出来，
 * 免得刚打开的一瞬间是个空窗口。state 一到就会用主进程给的那份覆盖。
 */
const FALLBACK_OPTIONS = ['09:30', '14:00'];

/** 下拉里的可选值：小时 00–23、分钟 00–59（挂件本身只精确到分钟） */
const HOURS = Array.from({ length: 24 }, (_, index) => pad2(index));
const MINUTES = Array.from({ length: 60 }, (_, index) => pad2(index));

let builtKey = null;
/** 下拉框是否已经按「当前开标时间」对齐过（只对一次，之后跟着用户操作走） */
let selectorsReady = false;
let lastState = null;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function labelFor(time) {
  return time < '12:00' ? '上午' : '下午';
}

function build(options) {
  optionsEl.textContent = '';

  options.forEach((time) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option';
    button.dataset.bidTime = time;

    const label = document.createElement('span');
    label.className = 'option__label';
    label.textContent = labelFor(time);

    const value = document.createElement('span');
    value.className = 'option__time';
    value.textContent = time;

    const tag = document.createElement('span');
    tag.className = 'option__tag';
    tag.textContent = '已过';

    button.append(label, value, tag);
    button.addEventListener('click', () => window.bidClock.chooseBidTime(time));

    optionsEl.appendChild(button);
  });

  builtKey = options.join(',');
}

/* ---------------- 自定义时间（小时 / 分钟 下拉） ---------------- */

function fillSelect(el, values) {
  el.textContent = '';

  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    el.appendChild(option);
  });
}

function selection() {
  return `${hourEl.value}:${minuteEl.value}`;
}

/**
 * 选中的时间相对「现在」是过了还是还有多久。
 *
 * 现在的时间是主进程给的 'HH:MM:SS' 字符串，两个时刻都在同一天，
 * 所以直接比字符串 / 做分钟级换算就够了，不用把日期逻辑搬到界面层。
 */
function describeSelection(time, now) {
  if (typeof now !== 'string' || now.length < 8) return '选好小时和分钟后点「使用这个时间」';
  if (`${time}:00` <= now) return '今天这个时间已经过了，换一个更晚的';

  const [targetHour, targetMinute] = time.split(':').map(Number);
  const [nowHour, nowMinute, nowSecond] = now.split(':').map(Number);
  const gapSeconds = targetHour * 3600 + targetMinute * 60 - (nowHour * 3600 + nowMinute * 60 + nowSecond);

  const minutes = Math.max(1, Math.round(gapSeconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `距现在约 ${hours} 小时 ${rest} 分` : `距现在约 ${minutes} 分钟`;
}

function refreshCustom() {
  const time = selection();
  const now = lastState ? lastState.now : null;
  const past = typeof now === 'string' && `${time}:00` <= now;

  hintEl.textContent = describeSelection(time, now);
  hintEl.classList.toggle('is-past', past);
  applyEl.classList.toggle('is-past', past);
  customEl.classList.toggle('is-current', Boolean(lastState) && lastState.bidTime === time);
}

/** 下拉里现在选的时间，今天是不是已经过了 */
function isPastSelection() {
  const now = lastState ? lastState.now : null;
  return typeof now === 'string' && `${selection()}:00` <= now;
}

/** 主进程随状态带过来的一句话说明（例如「12:31 今天已经过了」） */
function setWarning(message) {
  if (!message) {
    warnEl.hidden = true;
    warnEl.textContent = '';
    return;
  }
  warnEl.textContent = message;
  warnEl.hidden = false;
}

/** 用户自己把下拉改到未来了，提示就过期了，收起来 */
function onSelectorChange() {
  if (!warnEl.hidden && !isPastSelection()) setWarning('');
  refreshCustom();
}

/** 打开设置窗口时，下拉框默认落在哪个时间 */
function initialSelection(state) {
  const options = Array.isArray(state.options) ? state.options : [];
  const now = typeof state.now === 'string' ? state.now : null;

  const upcoming = options.find((time) => !now || `${time}:00` > now);
  if (upcoming) return upcoming;

  // 两个预设今天都过了，就默认「现在 + 1 分钟」
  if (now && now.length >= 5) {
    const total = Math.min(Number(now.slice(0, 2)) * 60 + Number(now.slice(3, 5)) + 1, 23 * 60 + 59);
    return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
  }
  return FALLBACK_OPTIONS[0];
}

function syncSelectors(state) {
  if (selectorsReady) return;

  const saved = typeof state.bidTime === 'string' && /^\d{2}:\d{2}$/.test(state.bidTime)
    ? state.bidTime
    : initialSelection(state);
  const [hours, minutes] = saved.split(':');

  hourEl.value = hours;
  minuteEl.value = minutes;
  selectorsReady = true;
  refreshCustom();
}

function update(state) {
  if (!state) return;

  const options = Array.isArray(state.options) ? state.options : [];
  const key = options.join(',');
  if (!optionsEl.children.length || key !== builtKey) build(options);

  statusEl.textContent = `今天 ${state.today} · 当前 ${state.now}`;

  // 'HH:MM:SS' 同一天内直接比字符串就够了，不需要再算一次日期
  const now = typeof state.now === 'string' ? state.now : null;

  Array.from(optionsEl.children).forEach((button) => {
    const time = button.dataset.bidTime;
    button.classList.toggle('is-past', Boolean(now) && `${time}:00` <= now);
    button.classList.toggle('is-selected', state.bidTime === time);
  });

  lastState = state;
  if (!selectorsReady) syncSelectors(state);

  // 主进程有时会随状态带一句说明（「12:31 今天已经过了」），没带就把旧的收起来
  setWarning(typeof state.warning === 'string' ? state.warning : '');

  if (state.bidTime && state.remainingText) {
    footEl.textContent = `当前已选 ${state.bidTime}，还有 ${state.remainingText}。`;
  } else if (state.bidTime && state.due) {
    footEl.textContent = `当前已选 ${state.bidTime}，今天这个时间已经过去了。`;
  } else {
    footEl.textContent = FOOT_TIP;
  }

  refreshCustom();
}

closeEl.addEventListener('click', () => window.bidClock.closeSetup());

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  window.bidClock.closeSetup();
});

/* 拖标题栏移动设置窗口（和悬浮钟用同一套自绘拖动） */
headEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  if (event.target === closeEl || closeEl.contains(event.target)) return;
  event.preventDefault();
  try {
    headEl.setPointerCapture(event.pointerId);
  } catch (err) {
    /* 忽略 */
  }
  window.bidClock.startDrag();
});

const stopDrag = () => window.bidClock.endDrag();
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => {
  headEl.addEventListener(type, stopDrag);
});

document.addEventListener('dragstart', (event) => event.preventDefault());

/* 下拉框先填好（24 小时 × 60 分钟），首个 setup:state 到了再对齐到当前选择 */
fillSelect(hourEl, HOURS);
fillSelect(minuteEl, MINUTES);
hourEl.value = FALLBACK_OPTIONS[0].slice(0, 2);
minuteEl.value = FALLBACK_OPTIONS[0].slice(3);
hourEl.addEventListener('change', onSelectorChange);
minuteEl.addEventListener('change', onSelectorChange);
applyEl.addEventListener('click', () => window.bidClock.chooseBidTime(selection()));

/* 先画出兜底选项，state 到了再按主进程的版本重建/更新 */
build(FALLBACK_OPTIONS);
refreshCustom();

window.bidClock.onSetupState(update);
