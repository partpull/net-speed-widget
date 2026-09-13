#!/usr/bin/env node
'use strict';

/**
 * 启动脚本：先找到 electron 可执行文件，再让它来跑本目录。
 *
 * 为什么不用 `electron .`：
 *   这个挂件是 net-speed-widget 仓库里的子项目，父项目里已经装好了 Electron
 *   （100MB 的二进制，国内下载很折腾）。所以这里先找「本目录 node_modules」，
 *   找不到就退回「上一级目录的 node_modules」—— 克隆下来就能直接跑。
 *   将来把 bid-clock 单独搬走、自己 `npm install` 之后，走的就是第一条路径。
 *
 * 用法：
 *   npm start                   普通启动
 *   npm start -- --dev          带 DevTools
 *   npm start -- --diagnose     只写环境信息 JSON 然后退出
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');

function electronLocations() {
  return [
    path.join(APP_DIR, 'node_modules', 'electron'),
    path.join(path.resolve(APP_DIR, '..'), 'node_modules', 'electron')
  ];
}

/** electron 的 npm 包会把真实 exe 的相对路径写在 path.txt 里 */
function resolveElectron() {
  for (const pkgDir of electronLocations()) {
    const pathFile = path.join(pkgDir, 'path.txt');
    let relative = '';

    try {
      relative = fs.readFileSync(pathFile, 'utf8').trim();
    } catch (err) {
      continue; // 这个位置没装 electron
    }

    const exe = path.join(pkgDir, 'dist', relative || 'electron.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function fail(message) {
  console.error(message);
  console.error('');
  console.error('可以试试：');
  console.error('  cd bid-clock && npm install');
  console.error('  # 国内网络请先设置镜像再装：');
  console.error("  #   $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'");
  console.error('  #   node node_modules\\electron\\install.js');
  process.exit(1);
}

function main() {
  const exe = resolveElectron();
  if (!exe) fail('[FAIL] 找不到 Electron 可执行文件。');

  const args = [APP_DIR, ...process.argv.slice(2)];
  console.log(`electron: ${exe}`);
  console.log(`app dir : ${APP_DIR}`);

  const child = spawn(exe, args, { stdio: 'inherit' });

  child.on('error', (err) => fail(`[FAIL] 启动 Electron 失败：${err.message}`));
  child.on('close', (code) => process.exit(code === null ? 0 : code));
}

main();
