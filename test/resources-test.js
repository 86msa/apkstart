'use strict';
/**
 * 资源分配（内存 / CPU / 存储）的纯 Node 测试：不需要 Electron、不需要模拟器。
 *
 * 这一层的价值就是「填错也不出事」：用户随便填 32GB 内存、128GB 分区，
 * 保存前都要被收敛到宿主真的给得出的范围，否则表现是开机黑屏 / 装到一半失败，
 * 用户根本看不出是哪里错了。
 *
 * 运行：node test/resources-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  hostProfile, memoryLimits, clampMemoryMB, clampCores, memVerdict,
  diskRequiredMB, diskLimits, clampDataGB, storageVerdict,
  mumuResourcePairs, parseMumuResources,
} = require('../src/core/resources');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const GB = 1024 * 1024 * 1024;

(() => {
  console.log('\n[资源分配 · 宿主能力]');

  test('hostProfile 接受注入值（测试环境不碰真机）', () => {
    const h = hostProfile({ totalMB: 32768, cores: 16 });
    assert.equal(h.totalMB, 32768);
    assert.equal(h.cores, 16);
  });

  test('hostProfile 没给值时不会返回 0 核 / NaN', () => {
    const h = hostProfile({});
    assert.ok(h.cores >= 1);
    assert.ok(Number.isFinite(h.totalMB));
  });

  test('内存上限给宿主留 25%', () => {
    const lim = memoryLimits(32768);
    assert.equal(lim.maxMB, 24576, `32GB 宿主最多分 24GB，实际 ${lim.maxMB}`);
    assert.equal(lim.stepMB, 512);
    assert.equal(lim.minMB, 1024);
  });

  test('读不到宿主内存时也给一个保守上限', () => {
    const lim = memoryLimits(0);
    assert.ok(lim.maxMB >= 4096 && lim.maxMB <= 16384);
  });

  console.log('\n[资源分配 · 内存收敛]');

  test('0 表示自动，原样返回 0', () => {
    const r = clampMemoryMB(0, 32768);
    assert.equal(r.mb, 0);
    assert.equal(r.reason, 'auto');
  });

  test('填 3GB 按 512MB 对齐到 3072', () => {
    const r = clampMemoryMB(3000, 32768);
    assert.equal(r.mb, 3072);
    assert.equal(r.capped, true);
  });

  test('填 64GB 被压到宿主上限并给出原因', () => {
    const r = clampMemoryMB(64 * 1024, 32768);
    assert.equal(r.mb, 24576);
    assert.equal(r.capped, true);
    assert.ok(/最多只能分 24 GB/.test(r.reason), r.reason);
  });

  test('填 128MB 被抬到最低可启动值', () => {
    const r = clampMemoryMB(128, 32768);
    assert.equal(r.mb, 1024);
    assert.equal(r.capped, true);
  });

  test('小内存机器（4GB）不会给出 4GB 全给安卓', () => {
    const r = clampMemoryMB(4096, 4096);
    assert.equal(r.mb, 3072);
  });

  console.log('\n[资源分配 · CPU 收敛]');

  test('16 核机器最多分 15 核', () => {
    assert.equal(clampCores(16, 16).cores, 15);
  });

  test('单核机器仍然给 1 核', () => {
    assert.equal(clampCores(8, 1).cores, 1);
  });

  test('0 = 自动', () => {
    assert.equal(clampCores(0, 8).cores, 0);
  });

  console.log('\n[资源分配 · 内存占比提示]');

  test('分得太满会提示 Windows 换页', () => {
    const v = memVerdict(28672, 32768);
    assert.equal(v.level, 'insufficient');
    assert.ok(/换页/.test(v.note), v.note);
  });

  test('正常区间不打扰用户', () => {
    assert.equal(memVerdict(8192, 32768).level, 'ok');
    assert.equal(memVerdict(8192, 32768).note, '');
  });

  test('低于 768MB 判定起不来', () => {
    assert.equal(memVerdict(512, 32768).level, 'insufficient');
  });

  console.log('\n[资源分配 · 存储]');

  test('50GB 游戏按 1.8 倍 + 2GB 预留估算', () => {
    const need = diskRequiredMB(50 * GB);
    assert.equal(need, Math.ceil(50 * 1024 * 1.8) + 2048);
  });

  test('数据分区上限取所在磁盘的 80%', () => {
    assert.equal(diskLimits(100 * 1024).maxGB, 80);
  });

  test('磁盘只剩 20GB 时不允许填 64GB 分区', () => {
    const r = clampDataGB(64, 20 * 1024);
    assert.equal(r.gb, 16);
    assert.equal(r.capped, true);
    assert.ok(/只剩 20\.0 GB/.test(r.reason), r.reason);
  });

  test('磁盘充足时 64GB 分区放行', () => {
    const r = clampDataGB(64, 200 * 1024);
    assert.equal(r.gb, 64);
    assert.equal(r.capped, false);
  });

  test('空间不够时 storageVerdict 给出还差多少', () => {
    const v = storageVerdict(30 * 1024, 50 * GB);
    assert.equal(v.ok, false);
    assert.ok(v.shortMB > 0);
    assert.ok(/还差/.test(v.note), v.note);
  });

  test('读不到磁盘剩余时跳过预检而不是拦死', () => {
    assert.equal(storageVerdict(0, 50 * GB).ok, true);
  });

  console.log('\n[资源分配 · MuMu 落点]');

  test('都填 0 时不动 MuMu 的任何配置', () => {
    assert.deepEqual(mumuResourcePairs(0, 0), []);
  });

  test('只填内存也要切到 custom 模式', () => {
    const p = mumuResourcePairs(8, 0);
    assert.deepEqual(p.map((x) => x.key), ['performance_mode', 'performance_mem.custom']);
    assert.equal(p[0].value, 'custom');
    assert.equal(p[1].value, '8.000000');
  });

  test('只填核心时不动内存', () => {
    const p = mumuResourcePairs(0, 6);
    assert.deepEqual(p.map((x) => x.key), ['performance_mode', 'performance_cpu.custom']);
    assert.equal(p[1].value, '6');
  });

  test('内存按 0.5GB 对齐、核心封顶 16（MuMu 自己的上限）', () => {
    const p = mumuResourcePairs(7.3, 32);
    const mem = p.find((x) => x.key === 'performance_mem.custom');
    const cpu = p.find((x) => x.key === 'performance_cpu.custom');
    assert.equal(mem.value, '7.500000');
    assert.equal(cpu.value, '16');
  });

  test('parseMumuResources 读出性能模式与实际分配', () => {
    const r = parseMumuResources({
      performance_mode: 'custom', vm_mem: '9', vm_cpu: '6',
      'performance_mem.custom': '7.500000', 'performance_cpu.custom': '4',
    });
    assert.equal(r.mode, 'custom');
    assert.equal(r.memoryGB, 9);
    assert.equal(r.cores, 6);
    assert.equal(r.customMemoryGB, 7.5);
    assert.equal(r.customCores, 4);
  });

  console.log('\n[资源分配 · 接线检查]');

  const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'store.js'), 'utf8');
  test('设置里持久化 MuMu 内存/CPU 分配', () => {
    assert(/mumuMemoryGB: 0/.test(storeSrc), 'store 缺少 mumuMemoryGB');
    assert(/mumuCores: 0/.test(storeSrc), 'store 缺少 mumuCores');
  });

  const mumuSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backends', 'mumu.js'), 'utf8');
  test('MuMu 后端在开机前应用内存/CPU 分配', () => {
    assert(/applyResources\(alloc/.test(mumuSrc), 'ensure() 未应用资源分配');
    assert(/mumuResourcePairs/.test(mumuSrc), 'mumu 后端未使用统一的分配翻译');
    assert(/async resources\(\)/.test(mumuSrc), 'mumu 后端缺少 resources()');
  });

  const builtinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backends', 'builtin.js'), 'utf8');
  test('自带底座也提供 resources()', () => {
    assert(/resources\(\) \{/.test(builtinSrc), 'builtin 缺少 resources()');
  });

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  test('主进程收敛越界值并暴露资源总览', () => {
    assert(/sanitizeResourcePatch/.test(mainSrc), '保存设置时未收敛资源值');
    assert(/engine:resources/.test(mainSrc), '缺少 engine:resources IPC');
    assert(/unsupported: true/.test(mainSrc), '第三方底座的数据分区扩容未拦掉');
    assert(/runtime:resetAndResize/.test(mainSrc), '缺少重置+按新容量重建的通道');
  });

  const emulatorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
  test('quickboot 差量盘挡住就地扩容时如实报错，不假成功', () => {
    assert(/_hasDataOverlay/.test(emulatorSrc), '未检测 qcow2 差量盘');
    assert(/needsReset: true/.test(emulatorSrc), '扩容失败未标记 needsReset');
    assert(/fsGB/.test(emulatorSrc), 'dataInfo 未暴露文件系统实际大小');
  });

  const doctorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
  test('自动档位里的内存/核心上限跟着宿主走，不再写死 8GB/8核', () => {
    assert(/memoryLimits\(host\.totalMB\)/.test(doctorSrc), 'doctor 未按宿主收敛内存');
    assert(!/1536, 8192/.test(doctorSrc), 'doctor 仍在写死 8192 上限');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
