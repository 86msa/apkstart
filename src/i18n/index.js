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

  /**
   * pref = 设置里的 uiLanguage（'auto' 或语言码），systemLocale = 系统语言，
   * fallback = 系统语言既不是中文也不是阿拉伯语时用哪种（例如英文 Windows）。
   */
  function resolve(pref, systemLocale, fallback) {
    if (pref && pref !== 'auto') return normalize(pref) || SOURCE;
    return normalize(systemLocale) || normalize(fallback) || SOURCE;
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

  /**
   * 从右到左的语言里，插进句子的值（数字、英文、路径）前后加 RLM（U+200F，不可见）。
   * 否则相邻的两个值会被双向算法并成一段从左到右的文字：
   *   「ذاكرة 3.0GB · 2 نواة」会显示成「ذاكرة 2 · 3.0GB نواة」。
   * 只给含拉丁字母 / 数字的值加；中文界面完全不受影响。
   */
  const RLM = '\u200F';
  function bidiArg(v) {
    const s = String(v);
    if (info(lang).dir !== 'rtl' || !/[A-Za-z0-9]/.test(s)) return s;
    return RLM + s + RLM;
  }

  function format(s, args) {
    if (!args.length) return s;
    return s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? bidiArg(args[Number(i)]) : m));
  }

  /** 翻译。key 是中文原文（模板里的 ${x} 换成 {0}、{1}…） */
  function t(key, ...args) {
    const k = String(key);
    const v = dict ? dict[k] : undefined;
    return format(typeof v === 'string' && v ? v : k, args);
  }

  /**
   * 拼接几段界面文字。中文句子之间不需要空格，原样相连（行为与改造前完全一致）；
   * 阿拉伯语等以空格分词的语言，在两段之间补一个空格——除非前一段已以空白结尾，
   * 或后一段以空白 / 标点开头。代码里 `__('甲。') + __('乙')` 统一写成 `__.cat(__('甲。'), __('乙'))`。
   */
  function cat(...parts) {
    const strs = parts.filter((p) => p !== undefined && p !== null && p !== '').map(String);
    if (lang === SOURCE) return strs.join('');
    let out = '';
    for (const p of strs) {
      if (out && !/\s$/.test(out) && !/^[\s.,،؛:;!?؟)\]»】）。，、]/.test(p)) out += ' ';
      out += p;
    }
    return out;
  }
  t.cat = cat;

  /** 网页里的文本节点带缩进换行，查词典前统一压成单个空格 */
  function normText(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  const CJK = /[　-〿一-鿿＀-￯]/;
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip', 'data-title', 'label'];

  /** 应用名等用户数据不翻译：所在元素（或祖先）带 data-i18n-skip */
  function skipped(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest('[data-i18n-skip]'));
  }

  function translateText(node) {
    const raw = node.nodeValue;
    if (!raw || !CJK.test(raw) || !dict || skipped(node)) return;
    const key = normText(raw);
    const v = dict[key];
    if (typeof v !== 'string' || !v) return;
    // 保留原文前后的空白，避免和相邻内联元素粘在一起。
    // 中文原文与 <b>/<code>/<kbd> 之间本来就不留空格；阿拉伯语按词分隔，
    // 紧挨着内联元素的一侧要补一个空格（标点开头 / 结尾的不补）。
    const spaced = lang !== SOURCE;
    const prevEl = node.previousSibling && node.previousSibling.nodeType === 1;
    const nextEl = node.nextSibling && node.nextSibling.nodeType === 1;
    const lead = /^\s/.test(raw) || (spaced && prevEl && !/^[\s.,،؛:;!?؟)»]/.test(v)) ? ' ' : '';
    const tail = /\s$/.test(raw) || (spaced && nextEl && !/[\s(«]$/.test(v)) ? ' ' : '';
    node.nodeValue = lead + v + tail;
  }

  function translateEl(el) {
    if (!dict || !el.getAttribute || skipped(el)) return;
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
