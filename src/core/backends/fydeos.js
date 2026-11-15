'use strict';
/**
 * 底座：FydeOS / ChromeOS 自带的安卓子系统（ARC）
 *
 * 和自带模拟器、MuMu 这些「在 Windows 上另起一台虚拟机」的底座本质不同：
 * FydeOS 本身就是一个操作系统，安卓是它系统的一部分（ARC 容器）。
 * 所以这个底座没有「开机 / 关机 / 装镜像」这些动作 —— 安卓已经在跑了，
 * 我们只是通过 adb 接管它。好处是：
 *
 *   - 没有虚拟机开销，性能和原生应用基本一致；
 *   - 不占额外内存，不写几个 GB 的镜像；
 *   - 系统级集成（通知、文件、输入法）都是现成的。
 *
 * 代价：
 *   - 只能在 FydeOS 上用，Windows 用户与此无关；
 *   - **不能嵌入窗口**。窗口嵌入靠 SetParent(HWND)，那是 Windows 独有的，
 *     ChromeOS 桌面是 Aura/Wayland，没有 HWND 这回事。所以这个底座只支持
 *     「独立窗口」模式 —— 由系统自己给每个安卓应用开窗口。
 *
 * 接入方式（官方文档 + 社区实测）：
 *   1. 在 FydeOS 里打开「安卓设置 → 系统 → 开发者选项 → ADB 调试」；
 *   2. 从 Linux 子系统（Penguin）里 `adb connect arc:5555`
 *      或 `adb connect 100.115.92.2:5555`（ARC 容器的固定地址）；
 *   3. 第一次连会弹授权框，允许即可。
 *
 * 端口 5555 是 ARC 里 adbd 的固定端口（ChromiumOS 的 adb-proxy 会把它转发出来）。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Backend, CAPS } = require('./base');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * adb 连接目标，按可靠性排序。
 *  - `arc:5555`：Crostini 容器里能解析到 arc 这个主机名（多数 FydeOS 版本）；
 *  - `100.115.92.2:5555`：ARC 容器的固定内网地址，arc 解析不了时用它；
 *  - `127.0.0.1:5555`：adb-proxy 有时直接监听本机回环。
 */
const TARGETS = ['arc:5555', '100.115.92.2:5555', '127.0.0.1:5555'];

function tcpAlive(host, port, timeout = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
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

/** 读发行版标识，判断是不是 FydeOS / ChromeOS */
function distroInfo() {
  const out = { id: '', name: '', fydeos: false, chromeos: false };
  for (const f of ['/etc/lsb-release', '/etc/os-release']) {
    try {
      const t = fs.readFileSync(f, 'utf8');
      const pick = (k) => {
        const m = new RegExp(`^${k}=(["']?)(.*?)\\1$`, 'm').exec(t);
        return m ? m[2] : '';
      };
      out.id = out.id || pick('CHROMEOS_RELEASE_BOARD') || pick('ID');
      out.name = out.name || pick('CHROMEOS_RELEASE_DESCRIPTION') || pick('PRETTY_NAME');
      if (/fyde/i.test(t)) out.fydeos = true;
      if (/chromeos|chromiumos|cros/i.test(t)) out.chromeos = true;
    } catch (_) { /* 文件不存在就算了 */ }
  }
  return out;
}

class FydeosBackend extends Backend {
  constructor(appRoot, deps = {}) {
    super(appRoot, deps);
    this.serial = '';
    this.adbPath = '';
    // 用户可以在设置里手填目标（比如从另一台机器连过来）
    const cfg = (deps.store && deps.store.getSettings && deps.store.getSettings()) || {};
    this.hostOverride = String((cfg.engine && cfg.engine.fydeosHost) || '').trim();
    this._lastConnect = 0;
  }

  static get id() { return 'fydeos'; }

  static get label() { return 'FydeOS 安卓子系统'; }

  static get summary() {
    return '用 FydeOS 系统自带的安卓环境跑应用，没有虚拟机开销。'
      + '需要在 FydeOS 的安卓设置里打开「ADB 调试」。不支持窗口嵌入（系统自己管窗口）。';
  }

  /** 没有 HWND 可嵌 —— ChromeOS 桌面不是 Win32 窗口模型 */
  static get embedCapable() { return false; }

  get embedCapable() { return false; }

  get caps() {
    // 安卓是系统的一部分：不开机、不关机、不装镜像、不存快照、不改面板
    return new Set([CAPS.shutdown]);
  }

  running() {
    // 系统在跑，安卓就在跑；真正的判断交给 check()
    return true;
  }

  /** 目标列表：用户手填的优先，否则用默认候选 */
  _targets() {
    return this.hostOverride ? [this.hostOverride] : TARGETS.slice();
  }

  async resolveAdb() {
    if (this.adbPath && fs.existsSync(this.adbPath)) return this.adbPath;
    // FydeOS 上 adb 来自 Linux 子系统：`sudo apt install adb`
    for (const c of ['/usr/bin/adb', '/usr/local/bin/adb', '/opt/android-platform-tools/adb']) {
      if (fs.existsSync(c)) { this.adbPath = c; return c; }
    }
    this.adbPath = 'adb';   // 交给 PATH
    return this.adbPath;
  }

  _exec(args, { timeout = 8000 } = {}) {
    return new Promise((resolve) => {
      try {
        execFile(this.adbPath || 'adb', args, { timeout, windowsHide: true }, (e, stdout, stderr) => {
          resolve({ ok: !e, out: String(stdout || ''), err: String(stderr || (e && e.message) || '') });
        });
      } catch (e) { resolve({ ok: false, out: '', err: e.message }); }
    });
  }

  /** 探测：这台机器是不是 FydeOS / ChromeOS */
  async probe() {
    const d = distroInfo();
    // 端口能连上也当作命中线索（有些定制版改过发行版标识）
    let portOpen = false;
    if (process.platform !== 'win32') {
      portOpen = await tcpAlive('127.0.0.1', 5555).catch(() => false);
    }
    const found = d.fydeos || d.chromeos || portOpen;
    return {
      ok: true,
      found,
      path: '',
      detail: d.name || (portOpen ? '检测到本机 5555 端口（可能是 ARC）' : ''),
    };
  }

  async check() {
    if (process.platform === 'win32') {
      // Windows 上理论上也能连一台 FydeOS 的 adb，但窗口/桌面集成全都不成立，
      // 与其半残还不如明确告诉用户这是 FydeOS 专用底座。
      return { ok: false, reason: 'FydeOS 底座只能在 FydeOS / Linux 上使用', needs: 'backend' };
    }
    await this.resolveAdb();
    const r = await this._exec(['devices']);
    if (!r.out) {
      return { ok: false, reason: '找不到 adb。请在 Linux 子系统里执行：sudo apt install adb', needs: 'adb' };
    }
    // 已经有一台在线设备（serial 以 emulator- 或 ip:port 结尾）
    const online = /^\S+\s+device$/m.test(r.out);
    if (online) return { ok: true };
    if (/unauthorized/i.test(r.out)) {
      return { ok: false, reason: 'FydeOS 弹出了「允许 USB 调试」授权框，请在安卓界面点允许后重试', needs: 'authorize' };
    }
    return {
      ok: false,
      reason: '没有连上安卓子系统。请先在「安卓设置 → 系统 → 开发者选项」打开「ADB 调试」',
      needs: 'adb-debug',
    };
  }

  async ensure({ onLog = () => {} } = {}) {
    await this.resolveAdb();
    // 已经在线就直接复用
    const listed = await this._exec(['devices']);
    const firstDevice = (listed.out.split('\n') || [])
      .map((l) => l.trim()).filter((l) => /\sdevice$/.test(l))
      .map((l) => l.split(/\s+/)[0])[0];
    if (firstDevice) {
      this.serial = firstDevice;
      this.lastError = '';
      return { ok: true, serial: this.serial, adbPath: this.adbPath, reused: true };
    }

    // 依次尝试候选目标；连上后等它真的变成 device
    for (const target of this._targets()) {
      onLog(`正在连接 FydeOS 安卓子系统：${target}…`);
      // eslint-disable-next-line no-await-in-loop
      const c = await this._exec(['connect', target], { timeout: 10000 });
      const okConnect = /connected|already connected/i.test(c.out + c.err);
      if (!okConnect && !/connected/i.test(c.out)) {
        this.lastError = (c.err || c.out || '').trim();
        continue;
      }
      // 连接命令回 OK 不代表设备可用：还要等 state 变成 device
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const d = await this._exec(['-s', target, 'get-state']);
        if (/device/.test(d.out)) {
          this.serial = target;
          this.lastError = '';
          return { ok: true, serial: target, adbPath: this.adbPath };
        }
        if (/unauthorized/.test(d.out + d.err)) {
          this.lastError = '需要授权';
          onLog('FydeOS 弹出了「允许调试」授权框，请在安卓界面点「允许」…');
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
      }
      this.lastError = this.lastError || '连接后设备未就绪';
    }
    return {
      ok: false,
      error: this.lastError || '没能连上 FydeOS 安卓子系统。请确认已开启「ADB 调试」，并允许授权框。',
    };
  }

  /** 没有 HWND：返回空数组，上层会自动退到「独立窗口」模式 */
  async windowTargets() { return []; }

  async windowReady() { return { ok: false, reason: 'fydeos-no-hwnd' }; }

  async hideWindow() { return null; }

  /**
   * 不真的去关安卓：那是系统的一部分，关掉会影响用户其它应用。
   * 这里只是断开 adb 连接，保持系统原样。
   */
  async stop() {
    if (this.serial) {
      await this._exec(['disconnect', this.serial], { timeout: 5000 }).catch(() => {});
    }
    return { ok: true, note: 'FydeOS 的安卓子系统由系统管理，这里只断开连接' };
  }

  usage() { return { total: 0, items: [] }; }

  dataInfo() { return { ok: false, note: '数据由 FydeOS 系统管理' }; }

  diagnose() {
    const d = distroInfo();
    return {
      backend: 'fydeos',
      platform: process.platform,
      distro: d.name || d.id || '',
      fydeos: d.fydeos,
      chromeos: d.chromeos,
      adbPath: this.adbPath,
      serial: this.serial,
      hostOverride: this.hostOverride,
      lastError: this.lastError,
    };
  }
}

module.exports = { FydeosBackend, TARGETS, distroInfo };
