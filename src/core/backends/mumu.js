'use strict';
/**
 * 底座：网易 MuMu 模拟器 12（玩家版 / 多开）
 *
 * 为什么选它做第一个「第三方底座」实测对象：
 *  - 官方带一个命令行管理工具 MuMuManager.exe（info / control / adb / sh / setting），
 *    端口、窗口句柄、开关机状态全部是结构化 JSON，不用猜；
 *  - 渲染窗口是标准的 Qt 顶层窗口（Qt5156QWindowIcon），和自带 emulator 同源，
 *    SetParent 嵌入这条链路是现成的；
 *  - 它自带 ARM 兼容层（红果这类 arm64-only 应用可直接跑）。
 *
 * 用到的 MuMuManager 子命令（都在它自己的 --help 里）：
 *   info -v <index>                       → { adb_port, main_wnd, render_wnd, pid, player_state, ... }
 *   control -v <index> launch|shutdown    → 开机 / 关机
 *   control -v <index> show_window        → 把设备窗口显示出来
 *   control -v <index> layout_window ...  → 摆位置/尺寸
 *   control -v <index> app install -apk   → 装包
 *   control -v <index> app info -i        → 已装应用清单
 *   control -v <index> app launch -pkg    → 启动应用
 *
 * 重要限制（实测，写在这里免得以后踩）：
 *  - MuMu 的多开实例之间是隔离的；这里只接管「索引 0」那一台。
 *  - 窗口句柄会在设备进程重启后失效，每次用都要重新 info 一次。
 *  - 不能把已经隐藏的设备窗口 SetParent 进去：MuMu 自己会把它再压下去
 *    （Windows 在 SetParent 时会隐式清掉 WS_VISIBLE，MuMu 的 Qt 侧不会补回来），
 *    所以注入前必须确认窗口当前是可见的，必要时先 show_window。
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Backend, CAPS } = require('./base');
const { frameStats, isMostlyBlack } = require('../frame');
const { freeDiskMB } = require('../doctor');
const {
  RENDER_PROFILES, parseGraphicsLog, recommendedProfiles, nextProfile,
  profileSettings, profileById, diskRequiredMB, diskVerdict,
} = require('../mumu-compat');
const {
  hostProfile, memoryLimits, clampMemoryMB, clampCores, memVerdict,
  mumuResourcePairs, parseMumuResources, diskLimits,
} = require('../resources');

/** 常见安装位置（按命中率排序）。用户在设置里填的路径优先。 */
const CANDIDATE_ROOTS = [
  'D:\\MuMu Player 12',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell',
  'C:\\Program Files\\Netease\\MuMu Player 12',
  'D:\\Program Files\\Netease\\MuMuPlayer-12.0',
  'E:\\MuMu Player 12',
  'F:\\MuMu Player 12',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portAlive(port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

/** 从注册表里读 MuMu 的安装目录（比猜路径可靠） */
function rootFromRegistry() {
  if (process.platform !== 'win32') return [];
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0',
  ];
  const out = [];
  for (const key of keys) {
    const r = spawnSyncSafe('reg', ['query', key, '/v', 'UninstallString']);
    if (!r) continue;
    const m = /"([^"]+)"/.exec(r) || /([A-Z]:\\[^\r\n]+\.exe)/i.exec(r);
    if (m) out.push(path.dirname(m[1]));
  }
  return out;
}

function spawnSyncSafe(cmd, args) {
  try {
    const { execFileSync } = require('child_process');
    return String(execFileSync(cmd, args, { windowsHide: true, timeout: 4000, encoding: 'utf8' }) || '');
  } catch (_) {
    return '';
  }
}

/** "0x1a2b" / "12345" → 数字句柄；无效返回 0 */
function hwndOf(raw) {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const n = /^0x/i.test(s) ? Number.parseInt(s.slice(2), 16) : Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// MuMu 的 main_wnd 在设备进程重启/换分辨率后会失效；这里用 Win32 枚举
// MuMu 自己的进程现找顶层窗口。脚本和 agent.ps1 同源，输出 JSON。
const ENUM_MUMU_WINDOWS_PS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MuMuEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
$rows = New-Object System.Collections.ArrayList
$cb = [MuMuEnum+EnumProc]{
  param($h, $p)
  $winPid = 0
  [void][MuMuEnum]::GetWindowThreadProcessId($h, [ref]$winPid)
  $proc = Get-Process -Id $winPid -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match '^MuMu(NxDevice|NxMain|NxService|Player)') {
    $cls = New-Object System.Text.StringBuilder 256
    [void][MuMuEnum]::GetClassNameW($h, $cls, 256)
    $r = New-Object MuMuEnum+RECT
    [void][MuMuEnum]::GetWindowRect($h, [ref]$r)
    $w = $r.R - $r.L; $ht = $r.B - $r.T
    if ($w -gt 100 -and $ht -gt 100) {
      [void]$rows.Add([pscustomobject]@{
        hwnd = $h.ToInt64(); cls = $cls.ToString(); visible = [MuMuEnum]::IsWindowVisible($h)
        x = $r.L; y = $r.T; w = $w; h = $ht; area = $w * $ht
      })
    }
  }
  return $true
}
[void][MuMuEnum]::EnumWindows($cb, [IntPtr]::Zero)
$rows | ConvertTo-Json -Compress
`;

let _winCache = { at: 0, rows: [] };

/** 当前桌面上属于 MuMu 的顶层窗口（带 geometry()），失败返回 [] */
function findDeviceWindows() {
  if (process.platform !== 'win32') return [];
  if (Date.now() - _winCache.at < 350 && _winCache.rows.length) return _winCache.rows;
  const out = [];
  try {
    const { execFileSync } = require('child_process');
    const text = String(execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ENUM_MUMU_WINDOWS_PS],
      {
        windowsHide: true, encoding: 'utf8', timeout: 8000,
        maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      }) || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const r of rows) {
      const hwnd = hwndOf(r && r.hwnd);
      if (!hwnd) continue;
      const w = {
        hwnd,
        cls: String((r && r.cls) || ''),
        visible: !!(r && r.visible),
        x: Number(r && r.x) || 0,
        y: Number(r && r.y) || 0,
        w: Number(r && r.w) || 0,
        h: Number(r && r.h) || 0,
        area: Number(r && r.area) || 0,
      };
      w.geometry = () => ({ x: w.x, y: w.y, w: w.w, h: w.h });
      out.push(w);
    }
  } catch (_) { /* 枚举失败就退回 info 报的句柄 */ }
  _winCache = { at: Date.now(), rows: out };
  return out;
}

class MumuBackend extends Backend {
  static get id() { return 'mumu'; }

  static get label() { return 'MuMu 模拟器 12（复用已安装的网易模拟器）'; }

  static get summary() {
    return '不下载任何安卓镜像：直接驱动你电脑上已经装好的 MuMu 模拟器 12，'
      + '把它变成 ApkStart 的运行时。自带 ARM 兼容层，冷启动约 10~20 秒。';
  }

  static get embedCapable() { return true; }

  constructor(appRoot, deps = {}) {
    super(appRoot, deps);
    /** 用户可在设置里指定 MuMu 安装目录 */
    this.root = '';
    this.index = 0;
    this._info = null;
    this._infoAt = 0;
    /** 当前生效 / 已验证的渲染档位（id 见 mumu-compat.js） */
    this._renderProfile = '';
    this._appliedProfile = '';
    this._hostGpu = null;
    /** 本轮已经试过、确认会黑屏的档位，避免反复横跳 */
    this._blackTried = new Set();
  }

  get caps() {
    // 不提供 provision（镜像归 MuMu 管）、resetData（会连带清掉用户在 MuMu 里的其他东西，
    // 只做确认后的 shutdown 而不擅自删数据）、rotatePanel（走 adb wm，不重启物理面板）
    return new Set([CAPS.priority, CAPS.shutdown, CAPS.sharedHost]);
  }

  /** 解析 MuMu 安装目录 → { root, manager, adb, device } */
  locate() {
    const settings = (this.deps.store && this.deps.store.getSettings) ? this.deps.store.getSettings() : {};
    const configured = String((settings.engine && settings.engine.mumuPath) || '').trim();
    const roots = [];
    if (configured) roots.push(configured);
    roots.push(...rootFromRegistry());
    roots.push(...CANDIDATE_ROOTS);
    for (const root of roots) {
      if (!root) continue;
      const candidates = [
        path.join(root, 'nx_main', 'MuMuManager.exe'),
        path.join(root, 'shell', 'MuMuManager.exe'),
        path.join(root, 'MuMuManager.exe'),
      ];
      const manager = candidates.find((p) => fs.existsSync(p));
      if (!manager) continue;
      const base = path.dirname(path.dirname(manager));
      const adbCandidates = [
        path.join(base, 'shell', 'adb.exe'),
        path.join(base, 'nx_main', 'adb.exe'),
        path.join(base, 'nx_device', '12.0', 'shell', 'adb.exe'),
      ];
      const device = [
        path.join(base, 'nx_device', '12.0', 'shell', 'MuMuNxDevice.exe'),
        path.join(base, 'nx_device', '15.0', 'shell', 'MuMuNxDevice.exe'),
      ].find((p) => fs.existsSync(p)) || '';
      this.root = base;
      return { root: base, manager, adb: adbCandidates.find((p) => fs.existsSync(p)) || '', device };
    }
    this.root = '';
    return null;
  }

  /** 调 MuMuManager；返回解析后的 JSON（失败给 null） */
  manager(args, { timeout = 20000 } = {}) {
    const loc = this.locate();
    if (!loc) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(loc.manager, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const text = String(stdout || '').trim();
        if (!text) { resolve(null); return; }
        try { resolve(JSON.parse(text)); } catch (_) { resolve(text); }
      });
    });
  }

  /** MuMuManager setting 的便捷封装（针对当前实例） */
  async setting(args, { timeout = 12000 } = {}) {
    return this.manager(['setting', '-v', String(this.index), ...args], { timeout });
  }

  /** 读取实例全部设置；不是 JSON 就返回 null */
  async readSettings() {
    const r = await this.setting(['--all'], { timeout: 12000 });
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  }

  /**
   * 写一组设置。MuMuManager 的写法是成对出现的 `-k key -val value`，
   * 一次调用写完，避免中间态被 MuMu 保存成半套配置。
   */
  async writeSettings(pairs) {
    const args = [];
    for (const p of pairs) {
      if (!p || !p.key || p.value === undefined || p.value === null) continue;
      args.push('-k', String(p.key), '-val', String(p.value));
    }
    if (!args.length) return false;
    const r = await this.setting(args, { timeout: 12000 });
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      if (r.errcode !== undefined) return r.errcode === 0;
      // 成功时 MuMuManager 会把写进去的键回显出来；一个都没回显就是没写成功
      return pairs.every((p) => Object.prototype.hasOwnProperty.call(r, p.key));
    }
    return false;
  }

  /**
   * 从 MuMu 自己的 graphics_log 里读出宿主 GPU 与 GLES 能力落差。
   * 这是黑屏的直接证据；读不到就当没有，不影响启动。
   */
  readHostGpu() {
    if (this._hostGpu) return this._hostGpu;
    const empty = { glesMismatch: false, vendor: '', renderer: '' };
    if (!this.root) return empty;
    try {
      const nxRoot = path.join(this.root, 'nx_device');
      const files = [];
      // 用户的 MuMu 可能是 12 / 15，日志目录版本跟着变，不能写死
      for (const ver of fs.readdirSync(nxRoot)) {
        const dir = path.join(nxRoot, ver, 'device', 'graphics_log');
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!/^log\..*\.txt$/i.test(f)) continue;
          const full = path.join(dir, f);
          files.push({ full, t: fs.statSync(full).mtimeMs });
        }
      }
      files.sort((a, b) => b.t - a.t);
      // 最近两轮都读，防止只看了一半（日志还在写）
      for (const { full } of files.slice(0, 2)) {
        const parsed = parseGraphicsLog(fs.readFileSync(full, 'utf8'));
        if (parsed.glesMismatch || parsed.vendor) {
          this._hostGpu = parsed;
          return parsed;
        }
      }
    } catch (_) { /* 没有日志或读不了，按未知处理 */ }
    return empty;
  }

  /** 应用一个渲染档位到 MuMu 实例（重启后生效） */
  async applyRenderProfile(id, { onLog = () => {} } = {}) {
    const p = profileById(id);
    if (!p) return false;
    const ok = await this.writeSettings(profileSettings(id));
    if (ok) {
      this._appliedProfile = id;
      onLog(`MuMu 渲染档位：${p.label}`);
    }
    return ok;
  }

  /** 把已验证可用的档位记住，下次开机直接用它 */
  rememberProfile(id) {
    const p = profileById(id);
    if (!p) return;
    this._renderProfile = id;
    try {
      const store = this.deps.store;
      if (store && store.saveSettings) store.saveSettings({ engine: { mumuRenderProfile: id } });
    } catch (_) { /* 写不进设置也不影响本次运行 */ }
  }

  /** 连接 adb（MuMu 的网络 adb 端口每次开机可能变） */
  async connectAdb(info) {
    const loc = this.locate();
    this.serial = `${info.adb_host_ip || '127.0.0.1'}:${info.adb_port}`;
    this.adbPath = loc && loc.adb ? loc.adb : '';
    if (!this.adbPath) return { ok: false, error: 'MuMu 目录里找不到 adb.exe' };
    await new Promise((resolve) => {
      execFile(this.adbPath, ['connect', this.serial], { windowsHide: true, timeout: 10000 }, () => resolve());
    });
    return { ok: true, serial: this.serial, adbPath: this.adbPath };
  }

  /**
   * 抓一帧 guest framebuffer，判断画面是否真的画出来了。
   *
   * 注意：这里走 adb 的 framebuffer，和 Windows 窗口是否可见无关 ——
   * MuMu 在 ApkStart 里常常是隐藏/嵌入状态，但 guest 那帧该有内容还是有内容。
   */
  async probeFrame() {
    const adb = this.adbPath || (this.locate() || {}).adb;
    if (!adb || !this.serial) return null;
    // 屏幕休眠时抓到的是纯黑，先唤醒（KEYCODE_WAKEUP 对已唤醒的屏无害）
    await new Promise((resolve) => {
      execFile(adb, ['-s', this.serial, 'shell', 'input', 'keyevent', '224'],
        { windowsHide: true, timeout: 6000 }, () => resolve());
    });
    return new Promise((resolve) => {
      execFile(adb, ['-s', this.serial, 'exec-out', 'screencap'],
        { windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
        (err, stdout) => {
          if (err || !stdout) { resolve(null); return; }
          resolve(frameStats(stdout, { step: 64 }));
        });
    });
  }

  /** 等 guest 真正画出画面；返回 true 表示非黑屏 */
  async waitForRenderable({ timeoutMs = 12000, onLog = () => {} } = {}) {
    const t0 = Date.now();
    let last = null;
    let gotFrame = false;
    while (Date.now() - t0 < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      last = await this.probeFrame();
      if (last) {
        gotFrame = true;
        if (!isMostlyBlack(last)) return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 700));
    }
    // 抓不到帧说明 adb 的 framebuffer 通道不可用，不代表画面是黑的。
    // 这种情况绝对不能触发换档重启 —— 会把用户正常运行的机器折腾坏。
    if (!gotFrame) {
      onLog('MuMu framebuffer 读取失败，跳过画面体检（保持当前渲染档位）');
      return true;
    }
    onLog(`MuMu 画面仍为纯黑（抽样亮度均值 ${last.avg}，亮点 ${last.bright}/${last.samples}）`);
    return false;
  }

  /**
   * 黑屏自愈：逐个换渲染档位并重启，直到有一档能画出画面。
   * 每档只试一次；全试完仍黑就返回失败，让上层给出可执行的提示。
   */
  async recoverBlackScreen({ onLog = () => {} } = {}) {
    const host = this.readHostGpu();
    if (host.glesMismatch) {
      onLog(`检测到宿主 GLES 能力不足（需要 ${host.requested}，支持 ${host.max}），优先使用兼容档位`);
    }
    const tried = new Set(this._blackTried);
    // 本轮 ensure() 已经用这个档位开机并确认黑了，别再原样试一遍
    if (this._appliedProfile) tried.add(this._appliedProfile);
    for (let round = 0; round < RENDER_PROFILES.length; round += 1) {
      let id = this._renderProfile && !tried.has(this._renderProfile)
        ? this._renderProfile
        : nextProfile([...tried], host);
      if (!id) break;
      tried.add(id);
      // eslint-disable-next-line no-await-in-loop
      await this.applyRenderProfile(id, { onLog });
      onLog(`MuMu 黑屏自愈：第 ${round + 1} 次尝试 ${(profileById(id) || {}).label || id}`);
      // eslint-disable-next-line no-await-in-loop
      await this.stop({ graceful: true });
      // eslint-disable-next-line no-await-in-loop
      await this.manager(['control', 'launch', '-v', String(this.index)], { timeout: 30000 });
      this._stoppedByUs = false;
      // eslint-disable-next-line no-await-in-loop
      const info = await this.waitReady({ onLog });
      if (!info) continue;
      // eslint-disable-next-line no-await-in-loop
      const conn = await this.connectAdb(info);
      if (!conn.ok) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await this.waitForRenderable({ timeoutMs: 12000, onLog })) {
        this._blackTried = tried;
        this.rememberProfile(id);
        onLog(`MuMu 画面已恢复，记住档位 ${id}`);
        return { ok: true, profile: id, info };
      }
    }
    this._blackTried = tried;
    return { ok: false, error: 'MuMu 已启动但画面持续黑屏（所有渲染档位都试过了）' };
  }

  /** 读取实例信息（带 1.2s 缓存：调用方经常连读好几项） */
  async info({ fresh = false } = {}) {
    if (!fresh && this._info && Date.now() - this._infoAt < 1200) return this._info;
    const r = await this.manager(['info', '-v', String(this.index)], { timeout: 12000 });
    if (r && typeof r === 'object' && r.adb_port) {
      this._info = r;
      this._infoAt = Date.now();
    } else if (r && typeof r === 'object' && r.index !== undefined && r.adb_port === undefined) {
      this._info = r; // 关机状态下没有 adb_port，也要缓存下来
      this._infoAt = Date.now();
    }
    return this._info;
  }

  async probe() {
    const loc = this.locate();
    if (!loc) return { ok: true, found: false, detail: '没有找到 MuMuManager.exe' };
    const info = await this.manager(['version'], { timeout: 8000 });
    return {
      ok: true, found: true, path: loc.manager, detail: (info && info.version) || '', root: loc.root,
    };
  }

  async check() {
    const loc = this.locate();
    if (!loc) return { ok: false, reason: '没有找到 MuMu 模拟器（可在设置里指定安装目录）', needs: 'mumu' };
    if (!loc.adb) return { ok: false, reason: 'MuMu 目录里找不到 adb.exe', needs: 'mumu' };
    return { ok: true, path: loc.manager };
  }

  async resolveAdb() {
    const loc = this.locate();
    return loc && loc.adb ? loc.adb : '';
  }

  running() {
    // 有 adb 端口在监听，就认为虚拟机在跑（MuMuManager 的 info 要 300ms+，这个更快）
    return !!(this._info && this._info.is_process_started && !this._stoppedByUs);
  }

  /** 轮询等 Android 真正起来 */
  async waitReady({ timeoutMs = 120000, onLog = () => {} } = {}) {
    const t0 = Date.now();
    let lastNotice = 0;
    while (Date.now() - t0 < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const info = await this.info({ fresh: true });
      if (info && info.is_android_started && info.adb_port) return info;
      if (Date.now() - lastNotice > 8000) {
        lastNotice = Date.now();
        const st = (info && info.player_state) || 'starting';
        onLog(`MuMu 模拟器启动中… ${st} ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(1500);
    }
    return null;
  }

  async ensure({ onLog = () => {} } = {}) {
    const loc = this.locate();
    if (!loc) {
      return { ok: false, error: '没有找到 MuMu 模拟器。请先安装网易 MuMu 模拟器 12，或在设置里指定它的安装目录。' };
    }
    const settings = (this.deps.store && this.deps.store.getSettings)
      ? this.deps.store.getSettings() : {};
    this._renderProfile = String((settings.engine && settings.engine.mumuRenderProfile) || '').trim();
    const host = this.readHostGpu();
    const initial = this._renderProfile || recommendedProfiles(host)[0];
    let info = await this.info({ fresh: true });
    const wasRunning = !!(info && info.is_android_started);
    // 用户指定的内存 / CPU 必须赶在开机前写进 MuMu 配置（它只在启动阶段读）。
    // 已经在跑的实例只提示「重启后生效」，不替用户重启。
    const alloc = this.wantedAllocation();
    if (alloc.memoryGB || alloc.cores) {
      const r = await this.applyResources(alloc, { onLog });
      if (!r.ok) {
        onLog(`MuMu 资源分配没有写进去：${r.error}（继续用 MuMu 原来的设置）`);
      } else if (r.applied && wasRunning) {
        onLog('MuMu 资源分配已保存，正在运行的实例下次重启后生效');
      }
    }
    if (!wasRunning) {
      // 还没开机时把渲染档位先写进去。MuMu 只在开机阶段读这些配置，
      // 开机后再写要等下次重启才生效。
      if (initial && this._appliedProfile !== initial) {
        await this.applyRenderProfile(initial, { onLog });
      }
      onLog(info && info.is_process_started ? 'MuMu 模拟器正在开机…' : '正在启动 MuMu 模拟器…');
      await this.manager(['control', 'launch', '-v', String(this.index)], { timeout: 30000 });
      this._stoppedByUs = false;
      info = await this.waitReady({ onLog });
      if (!info) return { ok: false, error: 'MuMu 模拟器启动超时（120 秒内没有进入安卓桌面）' };
    }
    // MuMu 的 adb 端口不是 emulator-* 的自动注册设备，要先 connect。
    const conn = await this.connectAdb(info);
    if (!conn.ok) return { ok: false, error: conn.error };

    // 画面体检：ADB 在线 ≠ 游戏能画出来。宿主 GLES 能力不足时，MuMu 的
    // 游戏进程照常运行，但 eglCreateContext 失败，用户只看到一片黑。
    // 只对「本次由我们拉起」的机器做体检：复用用户正在看的机器时，游戏本身
    // 可能是暗色场景，不能因此把人家的模拟器重启掉。
    const visible = wasRunning || await this.waitForRenderable({ timeoutMs: 12000, onLog });
    if (!visible) {
      const fixed = await this.recoverBlackScreen({ onLog });
      if (!fixed.ok) {
        return {
          ok: false,
          error: `${fixed.error}。可在 MuMu 设置里把显卡渲染模式切成 DirectX + 中画质后重试。`,
        };
      }
      info = fixed.info;
    }
    return {
      ok: true, serial: this.serial, adbPath: this.adbPath, reused: wasRunning,
      engine: 'mumu', info, profile: this._renderProfile || this._appliedProfile || initial,
    };
  }

  /**
   * 给 WinAgent 的候选 HWND。
   *
   * 实测结论：MuMu 的 main_wnd（Qt5156QWindowIcon，标题=实例名）是整个设备窗口，
   * 里面包含安卓画面 + MuMu 自带的顶部工具条。render_wnd 是嵌在 main_wnd 里的
   * 画面子窗（标题 = "MuMuNxDevice"）。
   * 嵌入 main_wnd 时工具条会一起进来；嵌入 render_wnd 更干净但坐标要先换算。
   * 这里优先给 render_wnd：外壳会把多出来的部分裁在标题栏下面。
   */
  async windowTargets() {
    const info = await this.info({ fresh: true });
    if (!info) return [];
    // 关键：不能直接用 info 里报的 main_wnd。
    // MuMu 12 的设备窗口每次 relaunch/换分辨率都会重建，info 报的那个句柄经常
    // 已经失效（IsWindow=false），而 adb 是好的、player_state 也还是 start_finished，
    // 于是「看起来一切正常但就是嵌不进去」。
    // 这里按进程名现找：设备进程 MuMuNxDevice 创建的 Qt 顶层窗口里，
    // 面积最大的那个就是画面窗口（主窗 Qt5156QWindowIcon，其它是工具条/缩略图）。
    const live = findDeviceWindows();
    if (live.length) {
      const ordered = [info.render_wnd, info.main_wnd]
        .map((raw) => hwndOf(raw))
        .filter((h) => h && live.some((w) => w.hwnd === h));
      const rest = live.filter((w) => !ordered.some((h) => w.hwnd === h));
      const all = [...ordered.map((h) => live.find((w) => w.hwnd === h)), ...rest.sort((a, b) => b.area - a.area)]
        .filter(Boolean);
      this._win = all[0] || null;
      return all.map((w) => w.hwnd);
    }
    // 兜底：进程还没建窗口（刚开机那几秒）就退回 info 报的句柄
    const out = [info.render_wnd, info.main_wnd].map((raw) => hwndOf(raw)).filter(Boolean);
    this._win = null;
    return out;
  }

  /** 设备画面窗口现在的几何（像素），拿不到返回 null */
  windowGeometry() {
    return this._win ? this._win.geometry() : null;
  }

  /** 让 MuMu 自己把设备窗口显示出来（隐藏状态下的窗口 SetParent 进去不会显示） */
  async showWindow() {
    const r = await this.manager(['control', '-v', String(this.index), 'show_window'], { timeout: 10000 });
    return !!(r && (r.errcode === 0 || r === true));
  }

  async layoutWindow({ x = 0, y = 0, w = 540, h = 960 } = {}) {
    return this.manager([
      'control', '-v', String(this.index), 'layout_window',
      '-px', String(Math.round(x)), '-py', String(Math.round(y)),
      '-sw', String(Math.round(w)), '-sh', String(Math.round(h)),
    ], { timeout: 10000 });
  }

  /**
   * 就绪门禁。
   *
   * 坑（实测）：Windows 的 SetParent 会隐式清掉子窗口的 WS_VISIBLE。
   * 如果趁 MuMu 的设备窗口还处于隐藏状态（刚开机、或被我们藏起来过）就 SetParent，
   * 之后它永远不会自己再显示出来 —— 宿主窗口里是一片黑，而且 MuMuManager 报的
   * main_wnd 还是同一个句柄，看起来「一切正常」。
   *
   * 所以嵌入前必须先 show_window 把窗口显示出来，等它真的可见了再动手。
   */
  async windowReady({ isEmbedded } = {}) {
    if (typeof isEmbedded === 'function' && isEmbedded()) return { ok: true, already: true };
    let last = 'no-window';
    let sawStarted = false;
    // MuMu 的安卓先起来、画面窗口后建（换分辨率/重启设备进程尤其明显）。
    // 只查一次 info 就 SetParent，窗口句柄可能是旧的那一个。
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const info = await this.info({ fresh: true });
      if (!info || !info.main_wnd) { last = 'no-window'; } else if (info.player_state !== 'start_finished') {
        last = `muMu:${info.player_state}`;
      } else {
        sawStarted = true;
        // eslint-disable-next-line no-await-in-loop
        const live = findDeviceWindows();
        if (live.length) {
          // eslint-disable-next-line no-await-in-loop
          await this.showWindow();
          return { ok: true, shown: true, windows: live.length };
        }
        last = 'window-not-painted';
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(400);
    }
    // 枚举窗口失败（PowerShell 被策略挡住等）时，只要 MuMu 自己报已经
    // start_finished 就照常放行，不能把用户卡在「等待画面窗口」。
    if (sawStarted) {
      await this.showWindow();
      return { ok: true, shown: true, reason: 'info-only' };
    }
    return { ok: false, reason: last };
  }

  async stop({ graceful = true } = {}) {
    const r = await this.manager(['control', '-v', String(this.index), 'shutdown'], { timeout: 30000 });
    this._stoppedByUs = true;
    return { ok: !!(r && (r.errcode === 0 || r === true)) };
  }

  /**
   * 用户给这台 MuMu 实例分配的内存 / CPU。
   * 0 = 沿用 MuMu 里原来的性能设置（默认，绝不动用户已有配置）。
   */
  wantedAllocation() {
    const s = (this.deps.store && this.deps.store.getSettings)
      ? this.deps.store.getSettings() : {};
    const e = (s && s.engine) || {};
    const host = hostProfile();
    // 设置页已经收敛过一次，这里再收一次：用户可能手改 settings.json
    const mem = clampMemoryMB(e.mumuMemoryGB ? Number(e.mumuMemoryGB) * 1024 : 0, host.totalMB);
    const cpu = clampCores(e.mumuCores, host.cores);
    return { memoryGB: mem.mb > 0 ? Math.round((mem.mb / 1024) * 2) / 2 : 0, cores: cpu.cores };
  }

  /** 读 MuMu 实例当前实际分配（内存 GB / CPU 核 / 性能模式） */
  async readResources() {
    const all = await this.readSettings();
    return parseMumuResources(all);
  }

  /**
   * 把「内存 GB + 核心数」写进 MuMu 配置。
   *
   * MuMu 只在实例启动阶段读 performance_* 这几项，所以必须开机前写；
   * 已经在运行的实例改了不会立刻变，要等下次重启 —— 这里只提示，不替用户重启
   * （用户可能正开着游戏，重启就是掉线）。
   */
  async applyResources(alloc, { onLog = () => {} } = {}) {
    const a = alloc || this.wantedAllocation();
    const pairs = mumuResourcePairs(a.memoryGB, a.cores);
    if (!pairs.length) return { ok: true, applied: false, reason: 'follow-mumu' };
    const before = await this.readResources();
    const same = pairs.every((p) => {
      if (p.key === 'performance_mode') return String(before.mode) === String(p.value);
      if (p.key === 'performance_cpu.custom') return before.customCores === Number(p.value);
      return Math.abs(before.customMemoryGB - Number(p.value)) < 0.01;
    });
    if (same) return { ok: true, applied: false, unchanged: true, before };
    const ok = await this.writeSettings(pairs);
    if (!ok) {
      return { ok: false, applied: false, error: 'MuMu 拒绝了资源设置（实例可能正在启动/关机，稍后重试）' };
    }
    const after = await this.readResources();
    this._allocApplied = { ...a, at: Date.now() };
    onLog(`MuMu 资源分配：${a.memoryGB ? `${a.memoryGB} GB 内存` : '内存沿用原值'}`
      + ` / ${a.cores ? `${a.cores} 核` : 'CPU 沿用原值'}（重启实例后生效）`);
    return { ok: true, applied: true, before, after };
  }

  /**
   * 设置页展示用：宿主上限、用户想要的分配、MuMu 当前实际分配、数据盘余量。
   */
  async resources() {
    const host = hostProfile();
    const wanted = this.wantedAllocation();
    let current = { mode: '', memoryGB: 0, cores: 0, customMemoryGB: 0, customCores: 0 };
    try { current = await this.readResources(); } catch (_) { /* 读不到就留空 */ }
    const freeMB = this.freeDataMB();
    const effectiveMemoryGB = current.mode === 'custom' && current.customMemoryGB
      ? current.customMemoryGB : current.memoryGB;
    const effectiveCores = current.mode === 'custom' && current.customCores
      ? current.customCores : current.cores;
    const verdict = memVerdict(Math.round(effectiveMemoryGB * 1024), host.totalMB);
    return {
      backend: 'mumu',
      host,
      limits: { ...memoryLimits(host.totalMB), ...diskLimits(freeMB) },
      wanted,
      current: { ...current, effectiveMemoryGB, effectiveCores },
      freeMB,
      // 用户指定了、但 MuMu 里还没生效（需要重启实例）
      pending: !!((wanted.memoryGB && wanted.memoryGB !== effectiveMemoryGB)
        || (wanted.cores && wanted.cores !== effectiveCores)),
      verdict,
      note: 'MuMu 的数据盘由模拟器自己管理容量：这里只做余量检查和安装前预检，'
        + '要改分区大小请用 MuMu 设置中心。',
    };
  }

  /** 数据盘所在分区的剩余空间（50GB 级游戏安装前必须知道） */
  freeDataMB() {
    if (!this.root) this.locate();
    if (!this.root) return 0;
    try {
      const vms = path.join(this.root, 'vms');
      const names = fs.readdirSync(vms);
      for (const name of names) {
        const vdi = path.join(vms, name, 'data.vdi');
        if (fs.existsSync(vdi)) return freeDiskMB(path.dirname(vdi));
      }
    } catch (_) { /* 读不到就按未知处理 */ }
    return freeDiskMB(this.root);
  }

  usage() {
    const info = this._info;
    const used = info && info.disk_size_bytes ? info.disk_size_bytes : 0;
    return {
      total: used,
      items: [{ label: 'MuMu 实例磁盘', bytes: used }],
      note: `MuMu 的镜像由模拟器自己管理，apkstart 不下载、不清理。`
        + `当前分区剩余约 ${Math.round(this.freeDataMB() / 1024)} GB。`,
    };
  }

  dataInfo() {
    const info = this._info;
    const freeMB = this.freeDataMB();
    const lim = diskLimits(freeMB);
    return {
      ok: !!(info && info.disk_size_bytes) || freeMB > 0,
      dataMB: info && info.disk_size_bytes ? Math.round(info.disk_size_bytes / (1024 * 1024)) : 0,
      freeMB,
      // 用户能填的数据分区上限（由宿主余量推导）；MuMu 自己管容量，这里只用于提示
      maxGB: lim.maxGB,
      note: `MuMu 数据盘所在分区剩余 ${(freeMB / 1024).toFixed(1)} GB。`
        + '数据盘容量由 MuMu 设置中心管理；ApkStart 会在装大包前预检空间，不够会先提示而不是装到一半失败。',
    };
  }

  /** 50GB 级游戏安装前的磁盘预检，给 installer 用 */
  checkDiskFor(bytes) {
    return diskVerdict(this.freeDataMB(), diskRequiredMB(bytes));
  }

  dispose() {
    // 绝不因为 ApkStart 退出就关掉用户的模拟器
  }

  diagnose() {
    const loc = this.locate();
    return {
      backend: 'mumu',
      root: loc ? loc.root : '',
      manager: loc ? loc.manager : '',
      adb: loc ? loc.adb : '',
      index: this.index,
      serial: this.serial,
      info: this._info,
      renderProfile: this._renderProfile || this._appliedProfile || '',
      hostGpu: this.readHostGpu(),
      freeDataMB: this.freeDataMB(),
      blackTried: [...this._blackTried],
    };
  }
}

/** 探测用的辅助：某个端口是否已经有人监听（上层用来判断「要不要等」） */
MumuBackend.portAlive = portAlive;
/** 诊断 / 自测用：当前桌面上的 MuMu 窗口列表 */
MumuBackend.findDeviceWindows = findDeviceWindows;

module.exports = { MumuBackend, CANDIDATE_ROOTS };
