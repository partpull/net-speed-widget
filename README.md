# 网速悬浮窗 net-speed-widget

[![CI](https://github.com/partpull/net-speed-widget/actions/workflows/ci.yml/badge.svg)](https://github.com/partpull/net-speed-widget/actions/workflows/ci.yml)

一个极简的 Electron 桌面挂件：**永远置顶**，只显示两样东西 —— 下载速度和上传速度。

```
┌──────────────────────────┐
│  ↓ 12.34 MB/s │ ↑ 812 KB/s │
└──────────────────────────┘
```

## 运行

```bat
:: 最省事：双击即可（自动定位 Node、装依赖、下载 Electron 二进制、启动）
scripts\start.bat
```

或者手动：

```bash
npm install
npm start        # 普通运行
npm run dev      # 带 DevTools 调试
```

### 安装依赖卡住怎么办（国内网络 + npm 11）

Electron 的 npm 包装完后会跑 `postinstall`，从 **GitHub Releases** 下载约 100MB 的
二进制包。国内经常卡在这一步（表现为 `npm install` 长时间无输出、`node_modules/electron/dist` 始终为空）。

用国内镜像可以立刻解决：

```powershell
# 环境变量方式，不受 npm 版本影响
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
node node_modules\electron\install.js
```

或者直接跑项目自带的脚本（已内置镜像地址）：

```powershell
npm install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-electron.ps1
```

另外 **npm 11 默认不再执行依赖的 postinstall 脚本**，会看到这样的警告：

```
npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn install-scripts   electron@33.4.11 (postinstall: node install.js)
```

这意味着 Electron 二进制不会被下载。上面的 `scripts\install-electron.ps1` 就是绕过它、
手动执行 `install.js` 的。判断是否装好了只看一个文件：

```
node_modules\electron\path.txt        # 存在即完成
node_modules\electron\dist\electron.exe
```

## 验证 / 排查

一条命令跑完所有自检（不启动界面）：

```bash
npm run check
```

它会检查托盘图标的 PNG 能否正常生成、配置读写与夹取、以及**真实读取本机网卡计数器并连续采样 4 次**。全部通过时退出码为 0。

只跑与网络无关的检查（CI 用这个）：

```bash
node tools/self-check.js --offline
```

`--offline` 会跳过实时采样那一步 —— 云主机没有真实流量，采样必然接近 0，
那种环境下"能读到值"这件事本来就无法验证。

想跑更完整的检查（额外做语法检查、实时采样，并写出报告文件）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate.ps1
```

只想看实时网速：

```bash
npm run cli                       # 采样 8 秒
node tools/speed-cli.js 15 500    # 采样 15 秒，间隔 500ms
```

命令行里随便下载点东西，应该能看到数字跳动。

界面一直显示 `--` 时，把鼠标停在悬浮窗上会显示具体原因；
也可以删掉 `%APPDATA%\NetSpeedWidget\config.json` 重置配置。

### `--diagnose`：把运行环境落盘

排错时最有用的一招。它不建窗口、不测速，只把环境信息写成 JSON 然后退出：

```bash
NetSpeedWidget-1.0.0-portable.exe --diagnose
```

输出在 `%TEMP%\net-speed-widget-diagnose.json`：

```json
{
  "packaged": true,
  "isPortable": true,
  "execPath": "C:\\Users\\...\\Temp\\3JDTEtBM3y4zbnvicESUDjvhzdo\\NetSpeedWidget.exe",
  "portableExecutableFile": "C:\\Users\\...\\Desktop\\NetSpeedWidget-1.0.0-portable.exe",
  "launchAtLoginTarget": "C:\\Users\\...\\Desktop\\NetSpeedWidget-1.0.0-portable.exe",
  "userData": "C:\\Users\\...\\AppData\\Roaming\\NetSpeedWidget"
}
```

一眼能看出：跑的是哪一份 exe、是不是绿色版、开机自启会注册到哪个路径。

> 注意：**先退出正在运行的悬浮窗**再执行。单实例锁会让 `--diagnose` 直接退出，
> 什么都写不出来。

## 操作

| 操作 | 效果 |
| --- | --- |
| 左键按住拖动 | 移动悬浮窗（位置会记住） |
| 右键 | 打开菜单 |
| 托盘图标左键 | 显示 / 隐藏悬浮窗 |
| 托盘图标右键 | 菜单 |
| `Ctrl + Alt + N` | 全局快捷键，显示 / 隐藏 |
| 菜单 → 关于 | 查看版本与制作人 |

菜单里可以改：

- **始终置顶** —— 关掉后就是一个普通窗口
- **鼠标穿透** —— 窗口彻底点不到（纯装饰用），此时只能用托盘菜单操作，从菜单里关掉即可恢复
- **开机自启动**
- **刷新间隔** —— 500ms / 1s / 2s / 5s
- **重置位置** —— 回到主屏右上角

## 打包成 exe

```bash
npm run build            # 同时产出 portable + 安装版
npm run build:portable   # 只出单文件绿色版
```

两条命令都会先跑 `tools/make-icon.js` 生成图标，再交给 electron-builder。

产物在 `dist/`：

- `NetSpeedWidget-1.0.0-portable.exe` —— 双击即用，免安装
- `NetSpeedWidget-1.0.0-setup.exe` —— 安装版（可选安装目录）

### 应用图标

图标是**代码画出来的**，不是图片文件：

- `src/icon-art.js` —— 用「16×16 设计网格」上的连续坐标描述图形，按任意尺寸光栅化，并做 4×4 超采样抗锯齿。运行时托盘图标和打包图标**共用这一套形状**。
- `tools/make-icon.js` —— 生成 `build/icon.ico`（16/24/32/48/64 用 DIB，128/256 用 PNG）和一张 `build/icon-256.png` 预览。

```bash
npm run icon     # 重新生成图标，并做结构 + 取样双层校验
```

改图标只需要改 `src/icon-art.js` 里的形状函数和 `COLORS`，托盘和 exe 会一起变。

### 打包卡在 winCodeSign 怎么办

electron-builder 在 Windows 上会下载 `winCodeSign-2.6.0.7z`，这个包里含有
macOS 的 `.dylib` **符号链接**。Windows 上创建符号链接需要管理员权限或开发者模式，
没有的话会看到：

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权。
  ...\winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
```

然后 electron-builder 重试 4 次后放弃。那些符号链接全在 `darwin/` 下，**对 Windows
打包毫无用处**。解决办法是手动解压（排除 `darwin`）并放进它的缓存目录：

```powershell
$cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
$7z = "node_modules\7zip-bin\win\x64\7za.exe"
& $7z x "$cache\winCodeSign-2.6.0.7z" "-o$cache\winCodeSign-2.6.0" "-xr!darwin" "-xr!*.dylib" -y
```

解压后确认 `$cache\winCodeSign-2.6.0\windows-10\x64\signtool.exe` 存在即可，
之后打包就不会再下载它。

（另一个办法是打开 Windows 的「开发者模式」或直接用管理员运行，但上面这个不需要任何权限。）

## 数据是怎么来的

`src/providers.js` 按平台选择数据源：

| 平台 | 方案 |
| --- | --- |
| Windows | 常驻一个隐藏的 PowerShell 进程，每秒输出累计收发字节数（`Get-NetAdapterStatistics`，优先只统计**默认路由所在网卡**） |
| Windows 兜底 | 若上面拿不到数据，自动换成 `Win32_PerfRawData_Tcpip_NetworkInterface`（属性名与系统语言无关，中文系统也不会踩坑） |
| Linux | 直接读 `/proc/net/dev` |
| macOS | `netstat -ib` 的 `Ibytes` / `Obytes` |
| 其它 | 若手动装了 `systeminformation`，就用它 |

拿到的是**累计字节数**，`src/speed-monitor.js` 再做差分得到 bytes/s，并做两件事：

- 指数平滑（默认 `smoothing: 0.5`），数字不会乱跳；
- 检测计数器回绕/网卡重置，直接归零，不会冒出天文数字。

数据源挂掉会自动重试（1.5s 起，指数退避到最长 30s），恢复后自动接上。

## 配置

配置文件位置：`%APPDATA%\NetSpeedWidget\config.json`

```json
{
  "intervalMs": 1000,
  "alwaysOnTop": true,
  "clickThrough": false,
  "launchAtLogin": false,
  "smoothing": 0.5,
  "window": { "x": 1580, "y": 12 }
}
```

- `smoothing`：`0` = 完全不响应（不会这么用），`1` = 不做任何平滑、显示原始值。想更灵敏就调大。
- 改完重启应用生效。

## 目录结构

```
net-speed-widget/
├── LICENSE                     MIT
├── package.json
├── .github/workflows/ci.yml    语法检查 + 离线自检 + 图标校验
├── build/                     打包资源（由 npm run icon 生成）
│   ├── icon.ico               多尺寸应用图标
│   └── icon-256.png           预览图
├── scripts/
│   ├── start.bat               一键启动（自动定位 Node、装依赖、装 Electron 二进制）
│   ├── install-electron.ps1    用国内镜像下载 Electron 二进制
│   └── validate.ps1            完整自检并写出报告
├── tools/
│   ├── self-check.js           模块自检（托盘图标 / 配置 / 真实采样）
│   ├── make-icon.js            生成 build/icon.ico 并校验图形结构
│   └── speed-cli.js            命令行实时看网速
└── src/
    ├── main.js                 主进程：无边框置顶窗口、托盘、菜单、拖拽
    ├── preload.js              contextBridge 白名单 API
    ├── config.js               配置读写
    ├── providers.js            各平台网卡计数器数据源
    ├── speed-monitor.js        差分 / 平滑 / 自动重连
    ├── icon-art.js             图标图形描述 + PNG 编码（托盘与 exe 共用）
    ├── tray-icon.js            运行时生成托盘图标（无需图片资源）
    └── renderer/
        ├── index.html
        ├── style.css
        └── renderer.js         只负责把两个数字格式化后塞进界面
```

## 已知限制

- Windows 上统计的是「默认路由所在网卡」，如有多个活动网卡（VPN + 物理网卡）同时跑流量，不会合并计算 —— 这是为了避免 VPN/虚拟网卡重复计数的常见坑。
- `netstat`/WMI 之类的计数器统计的是**本机网卡层**的字节数，包含协议头开销，因此会比浏览器里看到的下载速度略高一点，属正常现象。
- 鼠标穿透开启后无法再右键点开菜单，需要从**托盘图标**右键关闭。

### 绿色版（portable）的开机自启动

绿色版每次运行都会把自己解压到 `%TEMP%\<随机目录>` 再启动，所以 `process.execPath`
指向的是那份**临时** exe，而那个目录退出后会被删掉 —— 直接拿它注册开机启动项，
下次开机必然失效。

代码里已经处理了：`resolveLaunchTarget()` 会优先使用 `PORTABLE_EXECUTABLE_FILE`
（也就是你双击的那个启动器的真实位置）。**所以绿色版的自启也能正常工作**，但要注意：

- 那个 exe **不能挪走或改名**，否则自启项失效（安装版同理）；
- 想确认自启到底注册到了哪儿，用下面的 `--diagnose` 看一眼最直接。

---

制作人：**CAI JIAXING**
