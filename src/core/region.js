'use strict';
/**
 * 网络「地区」选择：ApkStart 原本只面向中国大陆用户，网络相关的默认值都是国内的：
 *   - 给安卓指定国内公共 DNS（阿里 223.5.5.5 / 腾讯 119.29.29.29）；
 *   - 把安卓的联网验证地址换成小米的 connect.rom.miui.com；
 *   - 用同一个地址做「真能上网吗」的探测。
 * 在中国以外这些地址可能很慢或不可达：解析失败 → 应用一直离线；联网验证失败 →
 * 安卓给 Wi-Fi 打「已连接，但无法访问互联网」，很多应用据此判定离线。
 *
 * 规则：用户在设置里手动选过「网络加速（国内 DNS）」就听用户的（engine.fastDnsChosen）；
 * 没选过时，阿拉伯语界面视为海外用户，用安卓 / 本机默认值；中文界面保持原来的国内设置。
 */
const i18n = require('../i18n');

function engineSettings() {
  try { return require('./store').getSettings().engine || {}; } catch (_) { return {}; }
}

/** 是否使用国内网络设置（国内 DNS + 国内联网验证端点） */
function useChinaNetwork(engine) {
  const e = engine || engineSettings();
  if (e.fastDnsChosen) return e.fastDns !== false;
  // 没手动选过时：只有中文界面才默认用国内网络设置；其它语言一律视为海外用户
  if (i18n.language !== 'zh-CN') return false;
  return e.fastDns !== false;
}

/** 「真能上网吗」探测用的主机（HTTP 80 端口，返回 204；只用于界面提示，不影响安卓的判断） */
function connectivityHost(engine) {
  return useChinaNetwork(engine) ? 'connect.rom.miui.com' : 'connectivitycheck.gstatic.com';
}

/**
 * 写入安卓联网验证设置的 shell 命令。
 * 海外：删掉以前写进去的国内地址（恢复安卓默认的 Google 地址），
 * 但 captive_portal_mode 仍设为 0（IGNORE）：安卓不再做联网验证，
 * 直接把 Wi-Fi 当作可用——否则在 Google 探测地址被拦 / 很慢的网络（公司代理、VPN、
 * DNS 过滤）上，系统会给 Wi-Fi 打「已连接，但无法访问互联网」，应用据此判定离线。
 */
function captivePortalCommands(engine) {
  if (useChinaNetwork(engine)) {
    return [
      'settings put global captive_portal_http_url http://connect.rom.miui.com/generate_204',
      'settings put global captive_portal_https_url https://connect.rom.miui.com/generate_204',
      'settings put global captive_portal_mode 0',
    ];
  }
  return [
    'settings delete global captive_portal_http_url',
    'settings delete global captive_portal_https_url',
    'settings put global captive_portal_mode 0',
  ];
}

module.exports = { useChinaNetwork, connectivityHost, captivePortalCommands };
