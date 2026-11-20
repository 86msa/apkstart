#!/usr/bin/env node
'use strict';
/**
 * 界面翻译检查（零依赖）
 *
 *   node tools/i18n-check.js            # 默认检查阿拉伯语 ar
 *   node tools/i18n-check.js ar --strict  # 有漏翻 / 未包 __() 的中文就以非 0 退出（CI 用）
 *
 * 输出三类问题：
 *   1. 漏翻：代码 __('…') 或网页里出现的中文原文，词典里没有
 *   2. 未包裹：JS 里写了中文字符串字面量却没有用 __() 包起来（启发式，注释已跳过）
 *   3. 占位符不一致：译文里的 {0}/{1} 与原文对不上
 * 以及词典里已经用不到的旧条目（仅提示，不算错误）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const lang = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'ar';
const strict = process.argv.includes('--strict');
const CJK = /[　-〿一-鿿＀-￯]/;
/** 这些文件只写日志或是 PowerShell，不参与界面翻译 */
// manual.html 是整份中文手册，阿拉伯语版本是单独的整页翻译（manual.ar.html），不走词典
const SKIP = new Set(['preload.js', 'splash-preload.js', 'manual.html', 'manual.ar.html']);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      if (f !== 'i18n') walk(p, out);
    } else out.push(p);
  }
  return out;
}

function unescapeJs(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' })[e] ?? e;
  });
}

/**
 * 极简 JS 扫描：跳过注释与正则，找出所有字符串 / 模板字面量，
 * 并记录它是不是 __( 的第一个参数。模板里的 ${…} 递归扫描。
 * exprMode=true 时遇到不配对的 } 就返回（即模板表达式结束）。
 */
function scanJs(src, from = 0, exprMode = false, out = []) {
  let i = from;
  let lastSig = '';
  let depth = 0;
  const n = src.length;
  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && /^([(,=:[!&|?{};+\-*%<>~^]|return)?$/.test(lastSig)) {
      // 正则字面量
      i += 1;
      let cls = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) break;
        else if (src[i] === '\n') break;
        i += 1;
      }
      i += 1;
      lastSig = 'regex';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i += 1;
      let body = '';
      let hasExpr = false;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { body += src[i] + src[i + 1]; i += 2; continue; }
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          hasExpr = true;
          i = scanJs(src, i + 2, true, out) + 1;
          body += '${…}';
          continue;
        }
        body += src[i];
        i += 1;
      }
      i += 1;
      const before = src.slice(Math.max(0, start - 4), start);
      const lineStart = src.lastIndexOf('\n', start) + 1;
      const lineEnd = src.indexOf('\n', start);
      const lineText = src.slice(lineStart, lineEnd < 0 ? n : lineEnd);
      out.push({
        // appLog 文件日志与手册锚点（anchor: 必须与 manual.html 的 id 一致）不翻译
        log: /\bappLog\(|\banchor:/.test(lineText),
        value: unescapeJs(body),
        wrapped: /__\(\s*$/.test(before),
        hasExpr,
        line: lineOf(start),
      });
      lastSig = 'str';
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      if (exprMode && depth === 0) return exprMode ? i : out;
      depth -= 1;
    }
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) {
        let w = '';
        while (i < n && /[A-Za-z0-9_$]/.test(src[i])) { w += src[i]; i += 1; }
        lastSig = w === 'return' || w === 'typeof' ? 'return' : 'id';
        continue;
      }
      lastSig = c === ')' || c === ']' ? 'close' : c;
    }
    i += 1;
  }
  return exprMode ? n : out;
}

function normText(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** 网页：文本节点 + title / placeholder / aria-label / alt */
function scanHtml(src) {
  const keys = [];
  const body = src.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/\s(?:title|placeholder|aria-label|alt|data-tip|data-title|label)="([^"]*)"/g)) {
    if (CJK.test(m[1])) keys.push(normText(decodeEntities(m[1])));
  }
  for (const part of body.split(/<[^>]*>/)) {
    if (CJK.test(part)) keys.push(normText(decodeEntities(part)));
  }
  return keys;
}

const dictFile = path.join(SRC, 'i18n', 'locales', `${lang}.js`);
if (!fs.existsSync(dictFile)) {
  console.error(`没有词典：${path.relative(ROOT, dictFile)}`);
  process.exit(2);
}
const dict = require(dictFile);

const used = new Map();
const unwrapped = [];
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (SKIP.has(path.basename(file))) continue;
  if (file.endsWith('.js')) {
    for (const s of scanJs(fs.readFileSync(file, 'utf8'))) {
      if (!CJK.test(s.value)) continue;
      if (s.wrapped && !s.hasExpr) {
        if (!used.has(s.value)) used.set(s.value, `${rel}:${s.line}`);
      } else if (!s.wrapped && !s.log) {
        unwrapped.push(`${rel}:${s.line}  ${JSON.stringify(s.value).slice(0, 90)}`);
      }
    }
  } else if (file.endsWith('.html')) {
    for (const k of scanHtml(fs.readFileSync(file, 'utf8'))) {
      if (!used.has(k)) used.set(k, rel);
    }
  }
}

const missing = [...used].filter(([k]) => !(k in dict));
const placeholder = Object.entries(dict).filter(([k, v]) => {
  const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
  return ph(k) !== ph(v);
});
const unused = Object.keys(dict).filter((k) => !used.has(k));

console.log(`语言：${lang}   词典条目：${Object.keys(dict).length}   界面用到：${used.size}`);
console.log(`漏翻：${missing.length}   未包 __()：${unwrapped.length}   占位符不一致：${placeholder.length}   未使用：${unused.length}`);
if (missing.length) {
  console.log('\n— 漏翻（把这些 key 加进词典）—');
  for (const [k, where] of missing) console.log(`  ${where}\n    ${JSON.stringify(k)}`);
}
if (unwrapped.length) {
  console.log('\n— 中文字面量没有包 __()（日志 / 正则可忽略）—');
  for (const u of unwrapped) console.log('  ' + u);
}
if (placeholder.length) {
  console.log('\n— 占位符不一致 —');
  for (const [k, v] of placeholder) console.log(`  ${JSON.stringify(k)}\n    => ${JSON.stringify(v)}`);
}
if (process.argv.includes('--unused') && unused.length) {
  console.log('\n— 词典里已用不到的条目 —');
  for (const k of unused) console.log('  ' + JSON.stringify(k));
}
if (strict && (missing.length || placeholder.length)) process.exit(1);
