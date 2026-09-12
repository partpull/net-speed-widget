'use strict';

/**
 * 网络计数器数据源（provider）。
 *
 * 每个数据源都实现同一套接口：
 *   { name, start(onSample, onFailure), stop() }
 *
 * onSample 收到的永远是「累计字节数」{ rx, tx }，速率换算交给 speed-monitor。
 *
 * Windows: 常驻一个隐藏的 PowerShell 子进程，每秒输出一行 "<rx> <tx>"，
 *          进程只启动一次，避免每秒 spawn 造成的卡顿。
 * Linux:   直接读 /proc/net/dev。
 * 其它:    尝试可选的 systeminformation 包，否则明确报错。
 */

const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const POWERSHELL = 'powershell.exe';

/** PowerShell -EncodedCommand 需要 base64(UTF-16LE) */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function spawnPowerShell(script) {
  return spawn(
    POWERSHELL,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodeCommand(script)
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

/* ------------------------------------------------------------------ *
 * Windows 脚本 #1：只统计「默认路由所在网卡」，拿不到时再退化为全网卡求和
 * ------------------------------------------------------------------ */
function buildAdapterScript(intervalMs) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$index = -1',
    '$tick = 0',
    'while ($true) {',
    '  if (($tick % 15) -eq 0) {',
    "    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |",
    '      Sort-Object -Property RouteMetric | Select-Object -First 1',
    '    if ($route) { $index = [int]$route.ifIndex } else { $index = -1 }',
    '  }',
    '  $tick = $tick + 1',
    '',
    '  $rx = [int64]0',
    '  $tx = [int64]0',
    '  if ($index -ge 0) {',
    '    $adapter = Get-NetAdapter -InterfaceIndex $index -ErrorAction SilentlyContinue | Select-Object -First 1',
    '    if ($adapter) {',
    '      $stat = Get-NetAdapterStatistics -Name $adapter.Name -ErrorAction SilentlyContinue | Select-Object -First 1',
    '      if ($stat) { $rx = [int64]$stat.ReceivedBytes; $tx = [int64]$stat.SentBytes }',
    '    }',
    '  }',
    '',
    '  if (($rx -le 0) -and ($tx -le 0)) {',
    '    $rx = [int64]0',
    '    $tx = [int64]0',
    '    foreach ($item in @(Get-NetAdapterStatistics -ErrorAction SilentlyContinue)) {',
    "      if ($item.Name -and ($item.Name -notmatch 'Loopback')) {",
    '        $rx = $rx + [int64]$item.ReceivedBytes',
    '        $tx = $tx + [int64]$item.SentBytes',
    '      }',
    '    }',
    '  }',
    '',
    "  Write-Output ($rx.ToString() + ' ' + $tx.ToString())",
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    '}',
    ''
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Windows 脚本 #2：WMI 性能计数器（属性名与系统语言无关，避免中文系统踩坑）
 * ------------------------------------------------------------------ */
function buildPerfScript(intervalMs) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    'while ($true) {',
    '  $rx = [int64]0',
    '  $tx = [int64]0',
    '  foreach ($item in @(Get-CimInstance -ClassName Win32_PerfRawData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue)) {',
    "    if ($item.Name -notmatch 'Loopback') {",
    '      $rx = $rx + [int64]$item.BytesReceivedPersec',
    '      $tx = $tx + [int64]$item.BytesSentPersec',
    '    }',
    '  }',
    "  Write-Output ($rx.ToString() + ' ' + $tx.ToString())",
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    '}',
    ''
  ].join('\n');
}
/* ------------------------------------------------------------------ *
 * 常驻 PowerShell 数据源
 * ------------------------------------------------------------------ */

/**
 * 在 firstSampleTimeoutMs 内拿不到任何有效数据，就判定失败，交给上层降级。
 */
function createPowerShellSource({ name, script, firstSampleTimeoutMs = 7000 }) {
  let child = null;
  let buffer = '';
  let onSample = null;
  let onFailure = null;
  let firstTimer = null;
  let running = false;

  const cleanup = () => {
    if (firstTimer) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (child) {
      const dying = child;
      child = null;
      try {
        dying.kill();
      } catch (err) {
        /* 忽略 */
      }
    }
  };

  const fail = (reason) => {
    if (!running) return;
    running = false;
    cleanup();
    if (onFailure) onFailure(reason);
  };

  const handleLine = (line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) return;
    if (firstTimer) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
    onSample({ rx: Number(match[1]), tx: Number(match[2]) });
  };

  return {
    name,
    start(sampleCallback, failureCallback) {
      onSample = sampleCallback;
      onFailure = failureCallback;
      running = true;

      try {
        child = spawnPowerShell(script);
      } catch (err) {
        fail('spawn-failed');
        return;
      }

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          handleLine(line);
          index = buffer.indexOf('\n');
        }
        if (buffer.length > 8192) buffer = '';
      });
      child.stdout.on('error', () => fail('stdout-error'));
      child.on('error', () => fail('powershell-not-found'));
      child.on('exit', () => fail('powershell-exited'));

      firstTimer = setTimeout(() => fail('timeout'), firstSampleTimeoutMs);
    },
    stop() {
      running = false;
      cleanup();
    }
  };
}

/* ------------------------------------------------------------------ *
 * 轮询式数据源
 * ------------------------------------------------------------------ */

function createPollingSource({ name, intervalMs, readCounters }) {
  let timer = null;
  return {
    name,
    start(onSample, onFailure) {
      let failed = false;

      const tick = () => {
        let counters = null;
        try {
          counters = readCounters();
        } catch (err) {
          failed = true;
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          onFailure('read-failed');
          return;
        }
        onSample(counters);
      };

      tick();
      if (failed) return;

      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

/* ------------------------------------------------------------------ *
 * 各平台实现
 * ------------------------------------------------------------------ */

function createWindowsSource({ intervalMs }) {
  const factories = [
    () =>
      createPowerShellSource({
        name: 'windows:adapter',
        script: buildAdapterScript(intervalMs),
        firstSampleTimeoutMs: 7000
      }),
    () =>
      createPowerShellSource({
        name: 'windows:perf',
        script: buildPerfScript(intervalMs),
        firstSampleTimeoutMs: 9000
      })
  ];

  let cursor = -1;
  let current = null;
  let sampleCallback = null;
  let failureCallback = null;
  let stopped = false;

  const tryNext = (reason) => {
    if (stopped) return;
    cursor += 1;
    if (cursor >= factories.length) {
      failureCallback(reason || 'no-source');
      return;
    }
    const started = factories[cursor]();
    current = started;
    started.start(sampleCallback, (why) => {
      if (current === started) current = null;
      tryNext(why);
    });
  };

  return {
    name: 'windows',
    start(onSample, onFailure) {
      sampleCallback = onSample;
      failureCallback = onFailure;
      stopped = false;
      cursor = -1;
      tryNext(null);
    },
    stop() {
      stopped = true;
      if (current) {
        current.stop();
        current = null;
      }
    }
  };
}

/** /proc/net/dev：第 1 列是接收字节，第 9 列是发送字节 */
function readProcNetDev() {
  const text = fs.readFileSync('/proc/net/dev', 'utf8');
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const iface = line.slice(0, colon).trim();
    if (!iface || iface === 'lo') continue;
    const cols = line.slice(colon + 1).trim().split(/\s+/);
    if (cols.length < 9) continue;
    rx += Number(cols[0]) || 0;
    tx += Number(cols[8]) || 0;
  }
  return { rx, tx };
}

function createDarwinSource({ intervalMs }) {
  return createPollingSource({
    name: 'darwin:netstat',
    intervalMs,
    readCounters() {
      const output = execFileSync('netstat', ['-ib'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true
      });
      const lines = output.split('\n');
      if (!lines.length) throw new Error('empty netstat');
      const header = lines[0].trim().split(/\s+/);
      const inIndex = header.indexOf('Ibytes');
      const outIndex = header.indexOf('Obytes');
      if (inIndex < 0 || outIndex < 0) throw new Error('unexpected netstat header');

      let rx = 0;
      let tx = 0;
      for (let i = 1; i < lines.length; i += 1) {
        const cols = lines[i].trim().split(/\s+/);
        if (cols.length <= Math.max(inIndex, outIndex)) continue;
        if (/^lo\d*$/.test(cols[0])) continue;
        rx += Number(cols[inIndex]) || 0;
        tx += Number(cols[outIndex]) || 0;
      }
      if (rx === 0 && tx === 0) throw new Error('no counters');
      return { rx, tx };
    }
  });
}

/** 兜底：如果用户自己装了 systeminformation 就用它 */
function createSystemInformationSource({ intervalMs }) {
  let timer = null;
  return {
    name: 'systeminformation',
    start(onSample, onFailure) {
      let si = null;
      try {
        // eslint-disable-next-line global-require
        si = require('systeminformation');
      } catch (err) {
        onFailure('systeminformation-missing');
        return;
      }
      timer = setInterval(() => {
        si.networkStats()
          .then((rows) => {
            let rx = 0;
            let tx = 0;
            for (const row of rows) {
              if (!row || row.iface === 'lo') continue;
              rx += Number(row.rx_bytes) || 0;
              tx += Number(row.tx_bytes) || 0;
            }
            onSample({ rx, tx });
          })
          .catch(() => onFailure('systeminformation-failed'));
      }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

/**
 * 按平台创建数据源；不支持的平台返回一个「必定失败」的数据源，
 * 让 speed-monitor 统一走错误展示逻辑。
 */
function createProvider({ platform = process.platform, intervalMs = 1000 } = {}) {
  if (platform === 'win32') return createWindowsSource({ intervalMs });
  if (platform === 'linux') {
    return createPollingSource({
      name: 'linux:proc-net-dev',
      intervalMs,
      readCounters: readProcNetDev
    });
  }
  if (platform === 'darwin') return createDarwinSource({ intervalMs });
  return createSystemInformationSource({ intervalMs });
}

/** 跨平台读取一次累计字节数（给命令行工具用） */
function readCountersOnce() {
  if (process.platform === 'linux') return readProcNetDev();
  return null;
}

module.exports = {
  createProvider,
  readProcNetDev,
  readCountersOnce,
  buildAdapterScript,
  buildPerfScript
};

