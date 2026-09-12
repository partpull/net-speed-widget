'use strict';

/**
 * 把「累计字节数」换算成上下行速率。
 *
 * 事件：
 *   'sample'  { down, up, downRaw, upRaw, intervalMs, source, at }  单位 bytes/s
 *   'state'   { ready, message, source }                            用于显示占位/错误
 *   'failure' { reason }
 */

const { EventEmitter } = require('events');
const { createProvider } = require('./providers');
const { clampInterval, clampSmoothing } = require('./config');

const RETRY_BASE_MS = 1500;
const RETRY_MAX_MS = 30000;

const MESSAGES = {
  timeout: '未收到网络计数器数据，正在重试…',
  'powershell-not-found': '未找到 PowerShell，无法读取网卡计数器',
  'powershell-exited': '计数器进程已退出，正在重试…',
  'spawn-failed': '无法启动计数器进程',
  'stdout-error': '计数器输出异常，正在重试…',
  'read-failed': '读取网卡计数器失败，正在重试…',
  'systeminformation-missing': '当前平台需要额外安装 systeminformation 依赖',
  'systeminformation-failed': 'systeminformation 读取失败，正在重试…',
  'no-source': '本机没有可用的网速数据源',
  'unsupported-platform': '当前平台暂不支持读取网卡计数器'
};

function describe(reason) {
  return MESSAGES[reason] || `网速数据源异常（${reason || 'unknown'}），正在重试…`;
}

class SpeedMonitor extends EventEmitter {
  constructor({ intervalMs = 1000, smoothing = 0.5 } = {}) {
    super();
    this.intervalMs = clampInterval(intervalMs);
    this.smoothing = clampSmoothing(smoothing);
    this.source = null;
    this.previous = null;
    this.smoothed = null;
    this.attempts = 0;
    this.stopped = true;
    this.retryTimer = null;
    this.state = { ready: false, message: MESSAGES.timeout, source: null };
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    this.attempts = 0;
    this._launch();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this._teardown();
    return this;
  }

  setIntervalMs(value) {
    const next = clampInterval(value);
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (!this.stopped) this._launch();
  }

  setSmoothing(value) {
    this.smoothing = clampSmoothing(value);
  }

  /** 立即重置基准，避免暂停/唤醒后出现一个巨大的假峰值 */
  reset() {
    this.previous = null;
    this.smoothed = null;
  }

  _teardown() {
    if (this.source) {
      try {
        this.source.stop();
      } catch (err) {
        /* 忽略 */
      }
      this.source = null;
    }
  }

  _launch() {
    this._teardown();
    this.reset();
    this._setState({ ready: false, message: MESSAGES.timeout, source: null });

    this.source = createProvider({
      platform: process.platform,
      intervalMs: this.intervalMs
    });

    const current = this.source;
    current.start(
      (counters) => {
        if (this.source === current) this._handleCounters(counters);
      },
      (reason) => {
        if (this.source === current) this._handleFailure(reason);
      }
    );
  }

  _setState(next) {
    const merged = { ...this.state, ...next };
    const changed =
      merged.ready !== this.state.ready ||
      merged.message !== this.state.message ||
      merged.source !== this.state.source;
    this.state = merged;
    if (changed) this.emit('state', { ...this.state });
  }

  _handleCounters(counters) {
    const now = Date.now();
    const rx = Number(counters && counters.rx) || 0;
    const tx = Number(counters && counters.tx) || 0;
    const previous = this.previous;
    this.previous = { rx, tx, at: now };

    this.attempts = 0;
    if (!this.state.ready) {
      this._setState({
        ready: true,
        message: null,
        source: this.source ? this.source.name : null
      });
    }

    if (!previous) return;
    const seconds = (now - previous.at) / 1000;
    if (seconds <= 0) return;

    let down = (rx - previous.rx) / seconds;
    let up = (tx - previous.tx) / seconds;

    // 计数器回绕 / 网卡重置：直接归零，避免出现天文数字
    if (down < 0 || up < 0) {
      down = 0;
      up = 0;
    }

    const k = this.smoothing;
    if (!this.smoothed || k >= 1) {
      this.smoothed = { down, up };
    } else {
      this.smoothed = {
        down: this.smoothed.down * (1 - k) + down * k,
        up: this.smoothed.up * (1 - k) + up * k
      };
    }

    this.emit('sample', {
      down: this.smoothed.down,
      up: this.smoothed.up,
      downRaw: down,
      upRaw: up,
      intervalMs: this.intervalMs,
      source: this.state.source,
      at: now
    });
  }

  _handleFailure(reason) {
    if (this.stopped) return;
    this._teardown();
    this.reset();
    this.attempts += 1;
    this._setState({ ready: false, message: describe(reason), source: null });
    this.emit('failure', { reason, attempt: this.attempts });

    const delay = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** Math.min(this.attempts - 1, 4)
    );
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this._launch();
    }, delay);
  }
}

module.exports = { SpeedMonitor, describe, MESSAGES };
