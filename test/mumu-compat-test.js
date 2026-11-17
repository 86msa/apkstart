'use strict';
/**
 * MuMu 跨机型黑屏自愈 / 大包磁盘预检的纯 Node 测试（无需 Electron / 模拟器）。
 *
 * 实测依据：MuMu 12 的 graphics_log 里反复出现
 *   Requested GLES version (3.2) is greater than max supported (3, 1)
 * 而 gpu_model.high = Adreno 740（宣称 3.2）—— AMD 780M 等宿主的
 * eglCreateContext 失败，游戏进程活着但窗口全黑。
 *
 * 运行：node test/mumu-compat-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  RENDER_PROFILES, profileById, parseGraphicsLog, recommendedProfiles,
  nextProfile, profileSettings, diskRequiredMB, diskVerdict,
} = require('../src/core/mumu-compat');
const { parseRawFrame, frameStats, isMostlyBlack } = require('../src/core/frame');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

/** 造一帧 raw screencap：w,h,format[,colorSpace] + RGBX 像素 */
function rawFrame(w, h, pixel, withColorSpace = true) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    px[i * 4] = pixel[0];
    px[i * 4 + 1] = pixel[1];
    px[i * 4 + 2] = pixel[2];
    px[i * 4 + 3] = 255;
  }
  const head = Buffer.alloc(withColorSpace ? 16 : 12);
  head.writeUInt32LE(w, 0);
  head.writeUInt32LE(h, 4);
  head.writeUInt32LE(1, 8);
  return Buffer.concat([head, px]);
}

(() => {
  console.log('\n[MuMu 黑屏自愈 · 渲染档位策略]');

  test('档位表包含 dx/vk × 高中低，id 唯一且可反查', () => {
    assert(RENDER_PROFILES.length >= 5);
    const ids = new Set();
    for (const p of RENDER_PROFILES) {
      assert(!ids.has(p.id), `重复 id: ${p.id}`);
      ids.add(p.id);
      assert(profileById(p.id) === p);
      assert(['dx', 'vk'].includes(p.renderer_mode));
    }
    assert.equal(profileById('nope'), null);
  });

  test('从真实日志文本解析出 GLES 3.2 / 3.1 落差与显卡型号', () => {
    const log = [
      '[11:55:59.306 E 6220][   ] EGL ERROR: eglCreateContext: Requested GLES version (3.2) is greater than max supported (3, 1).',
      '{"vendor":"ATI Technologies Inc.","renderer":"AMD Radeon 780M Graphics","core_version":"4.6"}',
    ].join('\n');
    const r = parseGraphicsLog(log);
    assert.equal(r.glesMismatch, true);
    assert.equal(r.requested, '3.2');
    assert.equal(r.max, '3.1');
    assert.equal(r.vendor, 'ATI Technologies Inc.');
    assert.match(r.renderer, /780M/);
  });

  test('无匹配日志时不当成 GLES 不匹配', () => {
    const r = parseGraphicsLog('Renderer initialized. App Version: 6.8.8.0');
    assert.equal(r.glesMismatch, false);
    assert.equal(r.vendor, '');
  });

  test('GLES 不匹配时优先中画质（Adreno 640 = GLES 3.1）', () => {
    const order = recommendedProfiles({ glesMismatch: true, vendor: '', renderer: '' });
    assert.equal(order[0], 'dx-mid');
    assert.equal(order[1], 'vk-mid');
    assert(order.indexOf('dx-high') > order.indexOf('dx-low'));
  });

  test('AMD / Intel 集显也优先兼容档位', () => {
    assert.equal(recommendedProfiles({ vendor: 'Intel', renderer: 'Iris Xe' })[0], 'dx-mid');
    assert.equal(recommendedProfiles({ renderer: 'AMD Radeon 780M Graphics' })[0], 'dx-mid');
  });

  test('NVIDIA 独显仍先用高画质', () => {
    assert.equal(recommendedProfiles({ vendor: 'NVIDIA', renderer: 'GeForce RTX 4060' })[0], 'dx-high');
  });

  test('nextProfile 跳过已试过的档位，试完返回 null', () => {
    const host = { glesMismatch: true };
    const first = nextProfile([], host);
    assert.equal(first, 'dx-mid');
    const second = nextProfile([first], host);
    assert.equal(second, 'vk-mid');
    const all = recommendedProfiles(host);
    assert.equal(nextProfile(all, host), null);
  });

  test('档位能翻译成 MuMuManager setting 的 key/value', () => {
    assert.deepEqual(profileSettings('dx-mid'), [
      { key: 'renderer_mode', value: 'dx' },
      { key: 'gpu_mode', value: 'middle' },
    ]);
    assert.deepEqual(profileSettings('vk-high'), [
      { key: 'renderer_mode', value: 'vk' },
      { key: 'gpu_mode', value: 'high' },
    ]);
    assert.deepEqual(profileSettings('unknown'), []);
  });

  console.log('\n[帧内容体检]');

  test('解析 12 字节头（Android 9 及以前）与 16 字节头（10+）', () => {
    const a = parseRawFrame(rawFrame(64, 64, [255, 255, 255], false));
    assert.equal(a.offset, 12);
    assert.deepEqual([a.w, a.h], [64, 64]);
    const b = parseRawFrame(rawFrame(64, 64, [255, 255, 255], true));
    assert.equal(b.offset, 16);
  });

  test('非法头 / 截断帧返回 null（不误判为黑屏）', () => {
    assert.equal(parseRawFrame(Buffer.alloc(4)), null);
    const bad = Buffer.alloc(64);
    bad.writeUInt32LE(1, 0); // 宽度太小
    bad.writeUInt32LE(1, 4);
    assert.equal(parseRawFrame(bad), null);
    const cut = rawFrame(64, 64, [0, 0, 0]);
    assert.equal(parseRawFrame(cut.subarray(0, 100)), null);
  });

  test('全黑帧判为黑屏，带桌面图标的帧判为正常', () => {
    const black = frameStats(rawFrame(64, 64, [0, 0, 0]));
    assert.equal(isMostlyBlack(black), true);
    const launcher = frameStats(rawFrame(64, 64, [40, 120, 220]));
    assert.equal(isMostlyBlack(launcher), false);
    assert(launcher.avg > black.avg);
  });

  test('少量亮点但不足 1% 仍判黑屏（排除鼠标光标误判）', () => {
    const f = rawFrame(64, 64, [0, 0, 0]);
    f.writeUInt8(255, f.length - 16);
    const s = frameStats(f, { step: 1 });
    assert.equal(isMostlyBlack(s), true);
  });

  test('采不到样时不误判成黑屏', () => {
    assert.equal(isMostlyBlack(null), false);
    assert.equal(isMostlyBlack({ samples: 0 }), false);
  });

  console.log('\n[50GB 级游戏磁盘预检]');

  test('按 1.8 倍 + 2GB 预留估算所需空间', () => {
    assert.equal(diskRequiredMB(1024 * 1048576), Math.ceil(1024 * 1.8 + 2048));
  });

  test('空间够放行，不足给出可执行提示', () => {
    const ok = diskVerdict(60000, 50000);
    assert.equal(ok.ok, true);
    const bad = diskVerdict(10000, 50000);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /磁盘空间不足/);
    assert.match(bad.message, /MuMu/);
  });

  test('读不到剩余空间时不挡住安装', () => {
    assert.equal(diskVerdict(0, 50000).ok, true);
  });

  console.log('\n[源码级接线检查]');

  const mumuSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backends', 'mumu.js'), 'utf8');
  test('windowTargets 依赖的 findDeviceWindows / hwndOf 已定义（原版漏实现）', () => {
    assert(/function hwndOf\(/.test(mumuSrc), 'hwndOf 未定义');
    assert(/function findDeviceWindows\(/.test(mumuSrc), 'findDeviceWindows 未定义');
  });
  test('ensure() 接上黑屏体检与自愈', () => {
    assert(/waitForRenderable\(/.test(mumuSrc), 'ensure 未调用帧体检');
    assert(/recoverBlackScreen\(/.test(mumuSrc), 'ensure 未调用自愈');
    assert(/applyRenderProfile\(initial/.test(mumuSrc), '开机前未写渲染档位');
  });
  const builtinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backends', 'builtin.js'), 'utf8');
  test('自带底座也做大包预检（数据分区 + 物理磁盘）', () => {
    assert(/checkDiskFor\(bytes\)/.test(builtinSrc), 'builtin 未实现 checkDiskFor');
    assert(/configuredGB/.test(builtinSrc), 'builtin 未检查 /data 分区容量');
  });
  const installerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'installer.js'), 'utf8');
  test('安装前做磁盘预检', () => {
    assert(/checkDiskFor\(bytes\)/.test(installerSrc), 'installer 未做磁盘预检');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
