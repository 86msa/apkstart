'use strict';
/**
 * MuMu 跨机型兼容策略（纯函数，便于 CI 单测）。
 *
 * 背景（本机实测，MuMu 12.0 / 6.8.8）：
 *   graphics_log 每次开机都报
 *     EGL ERROR: eglCreateContext: Requested GLES version (3.2) is greater
 *     than max supported (3, 1)
 *   而实例配置的 gpu_model.high = "Adreno (TM) 740"（对外宣称支持 GLES 3.2）。
 *   在 AMD Radeon 780M 这类只提供 GLES 3.1 的宿主上，游戏按 3.2 创建上下文
 *   就失败 —— 表现为「应用进程活着、ADB 正常、窗口一片黑」。
 *
 * 这里的策略是：按宿主 GPU / 历史日志挑一组渲染档位，开机后用真实帧做体检，
 * 黑屏就换下一档重启，直到有一档能画出画面并记住它。
 */

/** 候选渲染档位，按「画质高 → 兼容性好」排序；每项都可直接翻译成 MuMuManager setting */
const RENDER_PROFILES = [
  { id: 'dx-high', renderer_mode: 'dx', gpu_mode: 'high', label: 'DirectX / Adreno 740' },
  { id: 'vk-high', renderer_mode: 'vk', gpu_mode: 'high', label: 'Vulkan / Adreno 740' },
  { id: 'dx-mid', renderer_mode: 'dx', gpu_mode: 'middle', label: 'DirectX / Adreno 640' },
  { id: 'vk-mid', renderer_mode: 'vk', gpu_mode: 'middle', label: 'Vulkan / Adreno 640' },
  { id: 'dx-low', renderer_mode: 'dx', gpu_mode: 'low', label: 'DirectX / Adreno 530' },
];

function profileById(id) {
  return RENDER_PROFILES.find((p) => p.id === id) || null;
}

/** 解析 MuMu 的 graphics_log，拿到宿主 GPU 与 GLES 版本不匹配证据 */
function parseGraphicsLog(text) {
  const s = String(text || '');
  const out = { glesMismatch: false, requested: '', max: '', vendor: '', renderer: '' };
  const egl = /Requested GLES version \(([\d.]+)\) is greater than max supported \(([\d,\s]+)\)/i.exec(s);
  if (egl) {
    out.glesMismatch = true;
    out.requested = egl[1];
    out.max = egl[2].replace(/,\s*/g, '.').trim();
  }
  const vendor = /"vendor"\s*:\s*"([^"]+)"/.exec(s);
  const renderer = /"renderer"\s*:\s*"([^"]+)"/.exec(s);
  if (vendor) out.vendor = vendor[1];
  if (renderer) out.renderer = renderer[1];
  return out;
}

/**
 * 给出尝试顺序（id 数组）。
 * @param {object} host { glesMismatch, vendor, renderer }
 */
function recommendedProfiles(host = {}) {
  const gpu = `${host.vendor || ''} ${host.renderer || ''}`.toLowerCase();
  // GLES 3.2 -> 3.1 的落差是黑屏的直接证据：先把 640(3.1) 档放前面
  if (host.glesMismatch) return ['dx-mid', 'vk-mid', 'dx-low', 'dx-high', 'vk-high'];
  // AMD / Intel 集显的 ANGLE-D3D 后端普遍只到 GLES 3.1
  if (/amd|radeon|intel|iris|uhd|hd graphics/.test(gpu)) {
    return ['dx-mid', 'vk-mid', 'dx-low', 'dx-high', 'vk-high'];
  }
  // NVIDIA / 独显一般能完整撑住 3.2
  if (/nvidia|geforce|rtx|gtx|quadro/.test(gpu)) {
    return ['dx-high', 'vk-high', 'dx-mid', 'vk-mid', 'dx-low'];
  }
  return RENDER_PROFILES.map((p) => p.id);
}

/** 从已试过的档位里挑下一个；全试完返回 null */
function nextProfile(tried, host) {
  const seen = new Set(Array.isArray(tried) ? tried : []);
  return recommendedProfiles(host).find((id) => !seen.has(id)) || null;
}

/** 档位翻译成 MuMuManager setting 的 key/value 参数 */
function profileSettings(profileId) {
  const p = profileById(profileId);
  if (!p) return [];
  return [
    { key: 'renderer_mode', value: p.renderer_mode },
    { key: 'gpu_mode', value: p.gpu_mode },
  ];
}

/**
 * 50GB 级游戏的磁盘预检：APK/XAPK 本体 + 解压/OBB/存档的经验系数。
 * 低于所需空间就直接报错，而不是装到一半被 INSUFFICIENT_STORAGE 打断。
 */
function diskRequiredMB(bytes) {
  const mb = Math.max(1, Math.round(Number(bytes || 0) / 1048576));
  return Math.ceil(mb * 1.8 + 2048);
}

function diskVerdict(freeMB, requiredMB) {
  const free = Number(freeMB) || 0;
  const need = Number(requiredMB) || 0;
  if (!free) return { ok: true, unknown: true, message: '' };
  if (free >= need) return { ok: true, freeMB: free, requiredMB: need, message: '' };
  return {
    ok: false,
    freeMB: free,
    requiredMB: need,
    message: `磁盘空间不足：还要约 ${Math.ceil(need / 1024)} GB，但模拟器所在磁盘只剩 ${(free / 1024).toFixed(1)} GB。`
      + '请把 MuMu 的数据盘挪到空间更大的分区后重试。',
  };
}

module.exports = {
  RENDER_PROFILES, profileById, parseGraphicsLog, recommendedProfiles,
  nextProfile, profileSettings, diskRequiredMB, diskVerdict,
};
