'use strict';
/**
 * 更新来源测试：阿拉伯语版本的「检查更新」只问 package.json 里配置的仓库（fork），
 * 不会把程序换回没有阿拉伯语的原版；该仓库还没发布过版本时显示「已是最新」而不是报错。
 * 运行：node test/update-source-test.js
 */
const assert = require('assert/strict');
const { Sources, makeSources } = require('../src/core/sources');
const { Updater } = require('../src/core/updater');
const pkg = require('../package.json');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

(async () => {
  console.log('\n[更新来源]');

  await test('package.json 配置了程序更新仓库，Updater 用它而不是原作者仓库', async () => {
    const repo = pkg.apkstart && pkg.apkstart.updateRepos && pkg.apkstart.updateRepos.github;
    assert.ok(repo, '缺少 apkstart.updateRepos.github');
    assert.equal(Updater.repoUrl(), `https://github.com/${repo}/releases`);
    const u = new Updater({ currentVersion: pkg.version, dataDir: '/tmp', exePath: '/tmp/x/ApkStart.exe', settings: () => ({}) });
    assert.ok(u.sources.defs.github.api.endsWith(`/repos/${repo}`), u.sources.defs.github.api);
    assert.ok(!u.sources.defs.gitee, '更新仓库没有 Gitee 镜像时不应再问原作者的 Gitee');
  });

  await test('运行时整包等公共资源仍走默认（原作者）仓库', async () => {
    const s = new Sources(() => ({}));
    assert.ok(/RoutineMiku\/apkstart$/.test(s.defs.github.api), s.defs.github.api);
    assert.ok(s.defs.gitee, '默认应保留 Gitee');
  });

  await test('仓库还没发布任何版本（404）→「没有更新」而不是「连不上」', async () => {
    const s = new Sources(() => ({ runtime: {} }), { github: 'someone/fork', gitee: '' });
    s.fetchReleases = async () => [{ source: 'github', name: 'GitHub', error: 'HTTP 404 Not Found' }];
    const r = await s.latest({ force: true });
    assert.equal(r.noRelease, true);
    const u = new Updater({ currentVersion: '0.6.3', dataDir: '/tmp', exePath: '/tmp/x/ApkStart.exe', settings: () => ({}) });
    u.sources = s;
    s._relCache = { at: 0, key: '', value: null };
    const c = await u.check({ force: true });
    assert.equal(c.hasUpdate, false);
    assert.equal(c.noRelease, true);
  });

  await test('真正连不上（非 404）仍然报错，不会被当成「已是最新」', async () => {
    const s = new Sources(() => ({ runtime: {} }), { github: 'someone/fork', gitee: '' });
    s.fetchReleases = async () => [{ source: 'github', name: 'GitHub', error: 'ETIMEDOUT' }];
    await assert.rejects(() => s.latest({ force: true }));
  });

  await test('选了「只用 Gitee」但更新仓库没有 Gitee：退回 GitHub，不会空跑', async () => {
    const defs = makeSources({ github: 'someone/fork', gitee: '' });
    assert.deepEqual(Object.keys(defs), ['github']);
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
