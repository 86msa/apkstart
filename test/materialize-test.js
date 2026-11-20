'use strict';
/**
 * 系统镜像展开（materializeImages）：纯 Node 测试。
 *   - 并发调用要串行执行，不能两路同时写同一个 .part（Windows 上会 EPERM）；
 *   - 后来的调用必须在前一轮之后重新扫描（一键部署刚解完整包时要能看到新镜像）；
 *   - 杀软短暂占用（EPERM）时换文件名重试；
 *   - 排队等待的调用方也能收到展开进度。
 * 运行：node test/materialize-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Provisioner } = require('../src/core/provision');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-'));
  const p = new Provisioner(root);
  Object.defineProperty(p, 'root', { value: root });
  const dest = path.join(root, 'out');
  p.paths = () => ({ sysImgRoot: dest });
  const addImage = (name) => {
    fs.mkdirSync(path.join(root, 'system-images', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'system-images', 'x', `${name}.img.gz`), zlib.gzipSync(Buffer.alloc(1e6, 7)));
  };
  return { root, p, dest, addImage };
}

(async () => {
  console.log('\n[系统镜像展开]');

  await test('并发调用串行执行，从不同时写', async () => {
    const { p, dest, addImage } = setup();
    addImage('system');
    let active = 0;
    let maxActive = 0;
    const orig = p._extractOne.bind(p);
    p._extractOne = async (j, part) => {
      active += 1; maxActive = Math.max(maxActive, active);
      try { return await orig(j, part); } finally { active -= 1; }
    };
    await Promise.all([p.materializeImages(), p.materializeImages(), p.materializeImages()]);
    assert(maxActive === 1, `同时在写 ${maxActive} 路`);
    assert(fs.statSync(path.join(dest, 'x', 'system.img')).size === 1e6, '展开结果不对');
  });

  await test('后来的调用会重新扫描，能看到前一轮开始后才出现的镜像', async () => {
    const { p, dest, addImage } = setup();
    addImage('system');
    const first = p.materializeImages();
    addImage('vendor'); // 模拟「一键部署」在第一轮扫描之后才解完整包
    await Promise.all([first, p.materializeImages()]);
    assert(fs.existsSync(path.join(dest, 'x', 'vendor.img')), '第二次调用没有展开新出现的镜像');
  });

  await test('EPERM 时换文件名重试，不留 .part', async () => {
    const { p, dest, addImage } = setup();
    addImage('system');
    const orig = p._extractOne.bind(p);
    let n = 0;
    p._extractOne = (j, part) => {
      n += 1;
      if (n === 1) { const e = new Error('EPERM'); e.code = 'EPERM'; return Promise.reject(e); }
      return orig(j, part);
    };
    await p.materializeImages();
    const left = fs.readdirSync(path.join(dest, 'x'));
    assert(n === 2, `应重试 1 次，实际调用 ${n} 次`);
    assert(left.length === 1 && left[0] === 'system.img', `残留：${left.join(', ')}`);
  });

  await test('排队的调用方也能收到前一轮的进度', async () => {
    const { p, addImage } = setup();
    addImage('system');
    const got = [];
    await Promise.all([p.materializeImages(() => {}), p.materializeImages((m) => got.push(m))]);
    assert(got.length > 0, '第二个调用方没有收到任何进度消息');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
