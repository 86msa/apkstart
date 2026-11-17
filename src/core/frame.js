'use strict';
/**
 * 帧内容体检：判断 adb `exec-out screencap` 抓到的画面是否"全黑"。
 *
 * 这是纯函数模块，不依赖 Electron / Win32 / MuMu，CI 里可以直接单测。
 *
 * 为什么不用 PNG：PNG 要解 IHDR/IDAT/每行 filter，成本高；raw screencap
 * 头 12~16 字节后面就是 RGBX_8888 像素，抽样几十个点就足以区分「launcher
 * 有画面」和「渲染后端初始化失败导致的纯黑」。
 */

/** 解析 raw screencap：{w,h,format,offset,pixels}；不是合法帧返回 null */
function parseRawFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const w = buf.readUInt32LE(0);
  const h = buf.readUInt32LE(4);
  const format = buf.readUInt32LE(8);
  // 画面尺寸上限按 8K 给，防止把 PNG/文本误认成 raw 帧
  if (!(w >= 32 && w <= 8192 && h >= 32 && h <= 8192)) return null;
  const px = w * h * 4;
  let offset = 12;
  // Android 10 起 adb 会在 format 后再写一个 colorSpace(uint32)。
  // ColorSpace 是个很小的枚举（0~8），像素首字节同时也是 R 通道，也可能落在
  // 这个范围；但只有「多出来的 4 字节 + 完整一帧像素」都齐了才当头部处理。
  if (buf.length >= 16 + px && buf.readUInt32LE(12) <= 8) offset = 16;
  if (buf.length < offset + px) return null;
  return { w, h, format, offset, pixels: buf };
}

/**
 * 抽样统计帧亮度。
 * @param {Buffer} buf raw screencap
 * @param {object} opts { step: 每隔多少像素抽一个 }
 * @returns {{w:number,h:number,samples:number,nonBlack:number,bright:number,avg:number,max:number}|null}
 */
function frameStats(buf, opts = {}) {
  const f = parseRawFrame(buf);
  if (!f) return null;
  const step = Math.max(1, Math.floor(Number(opts.step) || 64));
  const total = f.w * f.h;
  let samples = 0;
  let nonBlack = 0;
  let bright = 0;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < total; i += step) {
    const p = f.offset + i * 4;
    // raw screencap 的 pixel format 是 RGBA/RGBX，四个字节一小节；
    // 取 R/G/B 最大值当亮度，比加权亮度便宜且不会漏掉纯红/纯蓝画面。
    const lum = Math.max(f.pixels[p], f.pixels[p + 1], f.pixels[p + 2]);
    samples += 1;
    sum += lum;
    if (lum > 16) nonBlack += 1;
    if (lum > 48) bright += 1;
    if (lum > max) max = lum;
  }
  return {
    w: f.w,
    h: f.h,
    samples,
    nonBlack,
    bright,
    avg: samples ? Math.round(sum / samples) : 0,
    max,
  };
}

/**
 * 是否「基本全黑」。
 *
 * 判据故意宽松：只要 1% 的抽样点有明显颜色（>48）就认为渲染活着。
 * 开机动画/深色壁纸通常也远高于这个阈值；真正的渲染故障是 0~2 个亮点。
 */
function isMostlyBlack(stats, opts = {}) {
  if (!stats || !stats.samples) return false; // 采不到样就别误判成黑屏
  const minRatio = Number.isFinite(Number(opts.minRatio)) ? Number(opts.minRatio) : 0.01;
  const p = stats.bright / stats.samples;
  return p < minRatio;
}

module.exports = { parseRawFrame, frameStats, isMostlyBlack };
