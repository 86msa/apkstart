/**
 * i18n — 界面多语言（主进程 / 渲染进程共用）
 *
 * 采用 gettext 风格：源码里的中文原文本身就是 key，
 *   __('安装 APK')                 → 'تثبيت APK'
 *   __('已安装 {0} 个应用', n)      → 'تم تثبيت {0} تطبيق' 并把 {0} 换成 n
 * 词典里没有的条目原样返回中文，所以漏翻不会崩，只是显示原文。
 *
 * 词典：src/i18n/locales/<lang>.js（Node 用 require，网页用 <script> 注册）。
 * 新增一种语言 = 在 LANGS 里登记 + 新建一份词典文件，
 * 用 `node tools/i18n-check.js <lang>` 查漏翻条目。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.I18N = api;
    root.__ = api.t;
    api.bootBrowser();
  }
}(typeof self !== 'undefined' ? self : this, (root) => {
  'use strict';

  /** 源语言：代码里写的就是它，不需要词典 */
  const SOURCE = 'zh-CN';
  /** 支持的界面语言。dir=rtl 的语言会把整个界面镜像成从右到左 */
  const LANGS = [
    { code: 'zh-CN', name: '简体中文', dir: 'ltr', dateLocale: 'zh-CN' },
    { code: 'ar', name: 'العربية', dir: 'rtl', dateLocale: 'ar' },
  ];

  const dicts = Object.create(null);
  let lang = SOURCE;
  let dict = null;

  function info(code) { return LANGS.find((l) => l.code === code) || LANGS[0]; }

  /** 把任意 locale 字符串（ar-SA / zh_CN / ar）归一成受支持的语言码；不支持返回 '' */
  function normalize(code) {
    const s = String(code || '').trim().replace('_', '-').toLowerCase();
    if (!s) return '';
    if (s === 'ar' || s.startsWith('ar-')) return 'ar';
    if (s.startsWith('zh')) return 'zh-CN';
    return '';
  }

  /** pref = 设置里的 uiLanguage（'auto' 或语言码），systemLocale = 系统语言 */
  function resolve(pref, systemLocale) {
    if (pref && pref !== 'auto') return normalize(pref) || SOURCE;
    return normalize(systemLocale) || SOURCE;
  }

  function register(code, d) {
    dicts[code] = Object.assign(dicts[code] || Object.create(null), d || {});
    if (code === lang) dict = dicts[code];
  }

  function loadDict(code) {
    if (dicts[code]) return dicts[code];
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      try { register(code, require(`./locales/${code}.js`)); } catch (_) { /* 没有词典：回落原文 */ }
    }
    return dicts[code] || null;
  }

  function setLanguage(code) {
    lang = normalize(code) || SOURCE;
    dict = lang === SOURCE ? null : loadDict(lang);
    return lang;
  }

  function format(s, args) {
    if (!args.length) return s;
    return s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m));
  }

  /** 翻译。key 是中文原文（模板里的 ${x} 换成 {0}、{1}…） */
  function t(key, ...args) {
    const k = String(key);
    const v = dict ? dict[k] : undefined;
    return format(typeof v === 'string' && v ? v : k, args);
  }

  /** 网页里的文本节点带缩进换行，查词典前统一压成单个空格 */
  function normText(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  const CJK = /[　-〿一-鿿＀-￯]/;
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip', 'data-title', 'label'];

  function translateText(node) {
    const raw = node.nodeValue;
    if (!raw || !CJK.test(raw) || !dict) return;
    const key = normText(raw);
    const v = dict[key];
    if (typeof v !== 'string' || !v) return;
    // 保留原文前后的空白，避免和相邻内联元素粘在一起
    const lead = /^\s/.test(raw) ? ' ' : '';
    const tail = /\s$/.test(raw) ? ' ' : '';
    node.nodeValue = lead + v + tail;
  }

  function translateEl(el) {
    if (!dict || !el.getAttribute) return;
    for (const a of ATTRS) {
      const raw = el.getAttribute(a);
      if (!raw || !CJK.test(raw)) continue;
      const v = dict[normText(raw)];
      if (typeof v === 'string' && v) el.setAttribute(a, v);
    }
  }

  /** 把一棵 DOM 子树里所有中文文本 / 提示属性换成当前语言 */
  function translateDom(rootNode) {
    if (!dict || !rootNode) return;
    const doc = rootNode.ownerDocument || rootNode;
    if (rootNode.nodeType === 3) { translateText(rootNode); return; }
    if (rootNode.nodeType === 1) translateEl(rootNode);
    const w = doc.createTreeWalker(rootNode, 1 | 4);
    let n = w.nextNode();
    while (n) {
      if (n.nodeType === 3) {
        const p = n.parentNode;
        if (!p || (p.nodeName !== 'SCRIPT' && p.nodeName !== 'STYLE')) translateText(n);
      } else {
        translateEl(n);
      }
      n = w.nextNode();
    }
  }

  function bootBrowser() {
    let q = '';
    try { q = new URLSearchParams(root.location.search).get('lang') || ''; } catch (_) { /* ignore */ }
    setLanguage(q || SOURCE);
    const apply = () => {
      const doc = root.document;
      const li = info(lang);
      doc.documentElement.setAttribute('lang', lang);
      doc.documentElement.setAttribute('dir', li.dir);
      if (!dict) return;
      if (doc.title && CJK.test(doc.title)) doc.title = t(normText(doc.title));
      translateDom(doc.body || doc.documentElement);
      // 兜底：之后动态插入的中文（没包 __() 的）也自动翻
      const mo = new root.MutationObserver((list) => {
        for (const m of list) {
          if (m.type === 'characterData') translateText(m.target);
          else if (m.type === 'attributes') translateEl(m.target);
          else m.addedNodes.forEach((x) => translateDom(x));
        }
      });
      mo.observe(doc.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
      });
    };
    // 词典脚本在本文件之后加载，等它们注册完再翻
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', apply);
    else root.setTimeout(apply, 0);
  }

  return {
    SOURCE,
    LANGS,
    t,
    register,
    setLanguage,
    resolve,
    normalize,
    normText,
    translateDom,
    bootBrowser,
    get language() { return lang; },
    get dir() { return info(lang).dir; },
    get dateLocale() { return info(lang).dateLocale; },
  };
}));
