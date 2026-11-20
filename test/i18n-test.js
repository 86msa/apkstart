'use strict';
/**
 * 界面多语言（i18n）测试：纯 Node，不需要 Electron。
 *
 * 守住三件事：
 *   1. 默认（中文）行为与改造前完全一致：__() 原样返回中文、模板变量照常替换；
 *   2. 阿拉伯语词典完整：代码和网页里出现的每一条中文都有译文，占位符一一对应；
 *   3. RTL：阿拉伯语界面会把页面切成从右到左，三个页面都加载了词典与 rtl.css。
 *
 * 运行：node test/i18n-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const i18n = require('../src/i18n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('\n[i18n · 基础]');

test('默认是源语言（简体中文），原文原样返回', () => {
  i18n.setLanguage('zh-CN');
  assert.equal(i18n.language, 'zh-CN');
  assert.equal(i18n.t('安装 APK'), '安装 APK');
  assert.equal(i18n.t('{0} 个应用', 3), '3 个应用');
  assert.equal(i18n.dir, 'ltr');
});

test('语言码归一：ar-SA / ar_EG → ar，zh-TW → zh-CN，其它回落源语言', () => {
  assert.equal(i18n.normalize('ar-SA'), 'ar');
  assert.equal(i18n.normalize('ar_EG'), 'ar');
  assert.equal(i18n.normalize('zh-TW'), 'zh-CN');
  assert.equal(i18n.normalize('en-US'), '');
  assert.equal(i18n.resolve('auto', 'ar-AE'), 'ar');
  assert.equal(i18n.resolve('auto', 'en-US'), 'zh-CN');
  assert.equal(i18n.resolve('zh-CN', 'ar-AE'), 'zh-CN', '手动选择优先于系统语言');
  assert.equal(i18n.resolve('ar', 'en-US'), 'ar');
});

test('阿拉伯语：翻译 + 占位符替换 + RTL', () => {
  i18n.setLanguage('ar');
  assert.equal(i18n.dir, 'rtl');
  assert.equal(i18n.t('安装 APK'), 'تثبيت APK');
  assert.match(i18n.t('{0} 个应用', 5).replace(/\u200F/g, ''), /^5 /);
  // 从右到左：插入的数字 / 英文值两侧加 RLM，避免相邻的值被并成一段左到右的文字
  assert.equal(i18n.t('{0} 个应用', 5), '\u200F5\u200F تطبيق');
  // 词典里没有的条目回落原文，不会抛错
  assert.equal(i18n.t('这条不存在的文字'), '这条不存在的文字');
  i18n.setLanguage('zh-CN');
});

test('核心模块在阿拉伯语下加载出的常量表也是阿拉伯语', () => {
  // keymap 在模块加载时生成预设表，所以要在 require 之前切语言
  const p = require.resolve('../src/core/keymap');
  delete require.cache[p];
  i18n.setLanguage('ar');
  const { PRESETS } = require('../src/core/keymap');
  assert.ok(!/[一-鿿]/.test(PRESETS.fps.label), PRESETS.fps.label);
  delete require.cache[p];
  i18n.setLanguage('zh-CN');
  assert.match(require('../src/core/keymap').PRESETS.fps.label, /射击/);
});

console.log('\n[i18n · 阿拉伯语词典]');

test('词典完整：没有漏翻、占位符一致（tools/i18n-check.js --strict）', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'i18n-check.js'), 'ar', '--strict'], { stdio: 'pipe' });
});

test('译文里不残留中文、HTML 标签数量与原文一致', () => {
  const d = require('../src/i18n/locales/ar.js');
  const tags = (s) => (s.match(/<\/?[a-z]+/gi) || []).sort().join(',');
  for (const [k, v] of Object.entries(d)) {
    if (k === v || /Language/.test(k) || /日常MIKU/.test(v)) continue;
    assert.ok(!/[一-鿿]/.test(v), `残留中文：${k}`);
    assert.equal(tags(v), tags(k), `标签不一致：${k}`);
  }
});

console.log('\n[i18n · 页面]');

test('三个页面都先加载 i18n 与阿拉伯语词典，再加载页面脚本，并引入 rtl.css', () => {
  for (const [html, js] of [['index.html', 'app.js'], ['splash.html', 'splash.js'], ['shell.html', 'shell.js']]) {
    const s = fs.readFileSync(path.join(ROOT, 'src', 'ui', html), 'utf8');
    const a = s.indexOf('../i18n/index.js');
    const b = s.indexOf('../i18n/locales/ar.js');
    const c = s.indexOf(`src="${js}"`);
    assert.ok(a > 0 && b > a && c > b, `${html} 脚本顺序不对`);
    assert.ok(s.includes('href="rtl.css"'), `${html} 缺 rtl.css`);
  }
});

test('主进程按 ?lang= 把语言传给每个页面，设置页有界面语言选择', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.ok(/loadFile\(path\.join\(__dirname, 'ui', 'index\.html'\), uiQuery\(\)\)/.test(main));
  assert.ok(/loadFile\(path\.join\(__dirname, 'ui', 'splash\.html'\), uiQuery\(\)\)/.test(main));
  // 语言必须在加载 core 模块之前定下来
  assert.ok(main.indexOf('applyUiLanguage();') < main.indexOf("require('./core/engine')"));
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  assert.ok(/id="setUiLanguage"[\s\S]{0,200}value="ar"/.test(html));
});

test('安卓系统语言：阿拉伯语界面下默认英文（避免阿拉伯-印度数字打乱解析）', () => {
  const { resolveGuestLocale } = require('../src/core/emulator');
  i18n.setLanguage('ar');
  assert.equal(resolveGuestLocale({ locale: 'zh-CN' }), 'en-US');
  assert.equal(resolveGuestLocale({ locale: 'ar', localeChosen: true }), 'ar', '手动选阿拉伯语仍然生效');
  assert.equal(resolveGuestLocale({ locale: 'zh-CN', localeChosen: true }), 'zh-CN', '用户手动选过就听用户的');
  assert.equal(resolveGuestLocale({ locale: 'off' }), '');
  i18n.setLanguage('zh-CN');
  assert.equal(resolveGuestLocale({ locale: 'zh-CN' }), 'zh-CN', '中文界面行为不变');
});

test('网络地区：中文界面用国内 DNS / 端点，阿拉伯语界面用安卓默认，手动选择优先', () => {
  const region = require('../src/core/region');
  i18n.setLanguage('zh-CN');
  assert.equal(region.useChinaNetwork({ fastDns: true }), true);
  assert.equal(region.connectivityHost({ fastDns: true }), 'connect.rom.miui.com');
  i18n.setLanguage('ar');
  assert.equal(region.useChinaNetwork({ fastDns: true }), false, '海外默认不用国内 DNS');
  assert.equal(region.connectivityHost({ fastDns: true }), 'connectivitycheck.gstatic.com');
  assert.ok(region.captivePortalCommands({ fastDns: true }).every((c) => /settings delete/.test(c)), '海外恢复安卓默认验证地址');
  assert.equal(region.useChinaNetwork({ fastDns: true, fastDnsChosen: true }), true, '手动打开就听用户的');
  i18n.setLanguage('zh-CN');
});

test('阿拉伯语手册：每个自动教程锚点都存在，页面从右到左，正文没有残留中文', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'manual.ar.html'), 'utf8');
  assert.ok(/<html lang="ar" dir="rtl">/.test(html), '手册要声明 lang=ar dir=rtl');
  const { TOPICS } = require('../src/core/manual');
  for (const t of Object.values(TOPICS)) {
    assert.ok(html.includes(`id="${t.anchor}"`), `缺锚点 ${t.anchor}`);
  }
  assert.ok(html.includes('id="6-9-network"'), '阿拉伯语手册要有网络专章');
  // 去掉标签属性（id / href 里的锚点本来就是中文）后，正文不应再有中文
  const text = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  const cjk = (text.match(/[\u4e00-\u9fff]+/g) || []).filter((x) => !/日常/.test(x));
  assert.deepEqual(cjk, [], `正文残留中文：${cjk.slice(0, 5).join(' / ')}`);
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.ok(/manual\.ar\.html/.test(main), '阿拉伯语界面要打开阿拉伯语手册');
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
