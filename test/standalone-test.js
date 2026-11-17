'use strict';
/**
 * 独立运行相关的纯 Node 测试：不需要 Electron、不需要模拟器、不需要联网。
 *
 * 这里守的是一条产品底线：**ApkStart 的安装包必须自带运行时、独立开跑**，
 * 第三方底座（MuMu / 雷电 / 蓝叠）只能是「你机器上本来就有，那可以复用」的增强，
 * 不能变成依赖，也不能被打进包里。
 *
 * 运行：node test/standalone-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findBundled, assertStandalone } = require('../build/guard-standalone');
const { AUTO_ORDER, create } = require('../src/core/backends');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `apkstart-${name}-`));
  return d;
}
function touch(dir, rel, bytes = 8) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

(() => {
  console.log('\n[独立运行 · 默认底座]');

  const store = require('../src/core/store');
  const settings = store.getSettings();

  test('默认引擎是自带运行时，不是任何第三方模拟器', () => {
    assert.equal(settings.engine.mode, 'builtin', `默认 mode=${settings.engine.mode}`);
  });

  test('Windows 上自动挑选把 builtin 排在第一位', () => {
    assert.equal(AUTO_ORDER[0], 'builtin', `AUTO_ORDER=${AUTO_ORDER.join(',')}`);
    assert.ok(!AUTO_ORDER.includes('fydeos') || process.platform !== 'win32');
  });

  test('显式选 mumu 时才创建 MuMu 后端（不会自动抢）', () => {
    const made = create({
      appRoot: ROOT,
      settings: { engine: { mode: 'builtin' } },
      store, log: () => {},
    });
    assert.equal(made.id, 'builtin', '未选 mumu 却创建了别的后端');
  });

  console.log('\n[独立运行 · 缺底座时回退]');

  const engineSrc = read('src', 'core', 'engine.js');
  test('引擎会在第三方底座不可用时退回自带运行时', () => {
    assert(/backendAvailable/.test(engineSrc), '缺少底座可用性判断');
    assert(/_fallbackFrom/.test(engineSrc), '缺少回退标记');
    assert(/本次改用 ApkStart 自带运行时/.test(engineSrc), '回退时没有向用户说明');
    assert(/fallbackFrom/.test(engineSrc), 'ensure 结果没有回退信息，界面无法提示');
  });

  test('重新选择底座会清掉回退标记（装上 MuMu 后能正常切回去）', () => {
    const m = engineSrc.match(/resetBackend\(\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(m, '找不到 resetBackend');
    assert(/_fallbackFrom = ''/.test(m[0]), 'resetBackend 未清回退标记');
  });

  test('显式指定 id 能压过 settings.mode（否则回退会又建成 mumu）', () => {
    const made = create({
      appRoot: ROOT,
      settings: { engine: { mode: 'mumu' } },
      store, log: () => {},
      id: 'builtin',
    });
    assert.equal(made.id, 'builtin', 'settings 里的 mumu 盖掉了回退指定');
    const engineSrc2 = read('src', 'core', 'engine.js');
    assert(/id: want,/.test(engineSrc2), '后端 getter 没有把回退后的 id 传给工厂');
  });

  console.log('\n[独立运行 · 包内不许有别的模拟器]');

  const guard = require('../build/guard-standalone');
  test('守卫能认出 MuMu 二进制', () => {
    const d = tmpDir('guard-hit');
    touch(d, 'runtime/MuMuManager.exe');
    const hits = findBundled(d);
    assert.equal(hits.length, 1, `命中数 ${hits.length}`);
    assert.equal(hits[0].vendor, 'MuMu 模拟器');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('守卫能认出 MuMu 的目录（nx_main / nx_device / nemu）', () => {
    for (const dirName of ['nx_main', 'nx_device', 'nemu']) {
      const d = tmpDir('guard-dir');
      fs.mkdirSync(path.join(d, dirName), { recursive: true });
      touch(d, path.join(dirName, 'whatever.bin'));
      assert.equal(findBundled(d).length, 1, `${dirName} 没被拦下`);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('守卫不会误伤适配器源码 backends/mumu.js', () => {
    const d = tmpDir('guard-src');
    touch(d, 'app/src/core/backends/mumu.js', 64);
    touch(d, 'app/src/core/mumu-compat.js', 64);
    assert.equal(findBundled(d).length, 0, '把源码当成模拟器本体了');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('守卫也认雷电 / 蓝叠', () => {
    const d = tmpDir('guard-others');
    touch(d, 'runtime/LDPlayer.exe');
    touch(d, 'runtime/Bluestacks.exe');
    const vendors = new Set(findBundled(d).map((h) => h.vendor));
    assert.ok(vendors.has('雷电模拟器'), '雷电没被拦下');
    assert.ok(vendors.has('蓝叠模拟器'), '蓝叠没被拦下');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('干净的运行时目录不报错', () => {
    const d = tmpDir('guard-clean');
    touch(d, 'runtime/emulator/emulator.exe', 64);
    touch(d, 'runtime/platform-tools/adb.exe', 64);
    const r = assertStandalone(d, { label: '测试', exit: false });
    assert.equal(r.ok, true, JSON.stringify(r.hits));
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('目录不存在时跳过检查而不是崩掉', () => {
    const r = assertStandalone(path.join(os.tmpdir(), 'apkstart-not-exist-xyz'), { exit: false });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  console.log('\n[独立运行 · 构建链路已接入守卫]');

  test('便携版打包会扫一遍 resources', () => {
    const src = read('build', 'pack.js');
    assert(/assertStandalone\(path\.join\(OUT, 'resources'\)/.test(src), 'pack.js 未接入守卫');
  });

  test('MSIX 打包会扫一遍载荷 app/', () => {
    const src = read('build', 'msix.js');
    assert(/assertStandalone\(appDir/.test(src), 'msix.js 未接入守卫');
  });

  test('打包只带 build/runtime（Google 运行时），没有别的模拟器目录', () => {
    const yml = read('electron-builder.yml');
    const block = yml.slice(yml.indexOf('extraResources:'));
    const head = block.slice(0, block.indexOf('win:'));
    assert(!/mumu|ldplayer|bluestacks/i.test(head), 'extraResources 里出现了第三方模拟器');
    assert(/build\/runtime/.test(head), 'extraResources 没有内置运行时');
  });

  test('MuMu 只作为可选项出现在引擎模式里', () => {
    const html = read('src', 'ui', 'index.html');
    assert(/value="mumu"/.test(html), '设置页缺少 MuMu 选项');
    const builtinFirst = html.indexOf('value="builtin"') < html.indexOf('value="mumu"');
    assert(builtinFirst, '引擎模式下拉里 MuMu 排在了自带运行时前面');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
