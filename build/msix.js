'use strict';
/**
 * 微软商店（MSIX）打包。
 *
 * 为什么不用 electron-builder 的 appx 目标：
 *   - 26.x 只有 appx（没有 msix），且会在构建期偷偷下载一整套 Windows SDK
 *     工具集（windows-kits-bundle-10_0_26100_0.zip）当黑盒依赖；
 *   - 我们要在清单里塞自己的一批东西（runFullTrust、文件关联、审核备注对应的
 *     身份信息），手写清单比改它的模板更可控。
 * 所以这里自己组 stage + 自己调 makeappx，只依赖 Windows SDK 里的两个 exe。
 *
 * 用法：
 *   node build/msix.js                       # 用 dist/release/win-unpacked 打不签名的包
 *   node build/msix.js --stage <dir>         # 指定已解包的目录
 *   node build/msix.js --sign                # 顺手生成自签证书并签名（本地测试用）
 *   node build/msix.js --identity Name --publisher "CN=..." --display 名称
 *
 * 环境变量也可以：APKSTART_MSIX_IDENTITY / APKSTART_MSIX_PUBLISHER / APKSTART_MSIX_DISPLAY
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodePng, drawAppIcon } = require('../src/core/png');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

// ---------------- 参数 ----------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const VERSION = String(pkg.version || '0.0.0');
// MSIX 的 Version 必须是四段，且第四段固定为 0（Store 要求）
function msixVersion(v) {
  const p = String(v).split(/[.\-+]/).filter((x) => /^\d+$/.test(x)).slice(0, 3);
  while (p.length < 3) p.push('0');
  return `${p[0]}.${p[1]}.${p[2]}.0`;
}

const IDENTITY = arg('identity') || process.env.APKSTART_MSIX_IDENTITY || 'RoutineMiku.ApkStart';
const PUBLISHER = arg('publisher') || process.env.APKSTART_MSIX_PUBLISHER || 'CN=RoutineMiku';
const PUBLISHER_DISPLAY = arg('publisherDisplay') || process.env.APKSTART_MSIX_PUBLISHER_DISPLAY || 'RoutineMiku';
const DISPLAY = arg('display') || process.env.APKSTART_MSIX_DISPLAY || 'ApkStart';
const APP_ID = arg('appId') || 'ApkStart';
const DO_SIGN = !!arg('sign', false);

const STAGE = path.resolve(String(arg('stage')
  || path.join(ROOT, 'dist', 'release', 'win-unpacked')));
const OUT_DIR = path.resolve(String(arg('out') || path.join(ROOT, 'dist', 'store')));

// ---------------- 资源图标 ----------------
// 清单里只写 100% 尺寸的那 5 张图。一旦目录里出现 .scale-* / .targetsize-*
// 文件，就必须额外生成 resources.pri（makepri），复杂度陡增 —— 首版不碰。
const ASSETS = [
  { file: 'StoreLogo.png', w: 50, h: 50 },
  { file: 'Square44x44Logo.png', w: 44, h: 44 },
  { file: 'Square150x150Logo.png', w: 150, h: 150 },
  { file: 'Wide310x150Logo.png', w: 310, h: 150 },
  { file: 'SplashScreen.png', w: 620, h: 300 },
];

const BG = [20, 22, 27];        // #14161b 深底
const ACCENT = [61, 220, 132];  // #3ddc84 安卓绿

/** 圆角矩形命中（用于在非正方形画布上画品牌图标） */
function inRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 在 w×h 画布中央画一个边长 side 的品牌图标（圆角深块 + 绿色播放三角） */
function composeIcon(w, h, side) {
  const rgba = new Uint8Array(w * h * 4);
  const ox = (w - side) / 2;
  const oy = (h - side) / 2;
  const pad = side * 0.06;
  const box = { x: ox + pad, y: oy + pad, w: side - pad * 2, h: side - pad * 2, r: side * 0.24 };
  const tW = side * 0.30;
  const tH = side * 0.34;
  const tcx = ox + side * 0.5 + side * 0.02;
  const tcy = oy + side * 0.5;
  const ax = tcx - tW * 0.38;
  const ay = tcy - tH / 2;
  const bx = tcx - tW * 0.38;
  const by = tcy + tH / 2;
  const cx2 = tcx + tW * 0.62;
  const cy2 = tcy;
  const inTri = (px, py) => {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx2) * (by - cy2) - (bx - cx2) * (py - cy2);
    const d3 = (px - ax) * (cy2 - ay) - (cx2 - ax) * (py - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // 底板：整块深色（磁贴/启动画面都是满幅背景）
      let r = BG[0];
      let g = BG[1];
      let b = BG[2];
      let a = 255;
      const px = x + 0.5;
      const py = y + 0.5;
      if (inRoundRect(px, py, box.x, box.y, box.w, box.h, box.r)) {
        const t = (x / w) * 0.6 + (y / h) * 0.4;
        r = Math.round(20 + t * 14);
        g = Math.round(26 + t * 18);
        b = Math.round(33 + t * 24);
        if (inTri(px, py)) { r = ACCENT[0]; g = ACCENT[1]; b = ACCENT[2]; }
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return encodePng(w, h, rgba);
}

function writeAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const a of ASSETS) {
    const buf = (a.w === a.h)
      ? drawAppIcon(a.w)
      : composeIcon(a.w, a.h, Math.min(a.h * 0.72, a.w * 0.42));
    fs.writeFileSync(path.join(dir, a.file), buf);
  }
  return ASSETS.map((a) => `${a.file} ${a.w}x${a.h}`);
}

// ---------------- 清单 ----------------

function manifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  ApkStart · Microsoft Store (MSIX) 清单
  由 build/msix.js 生成，不要手改；改模板请改 build/msix.js。

  两个必须和 Partner Center 逐字一致的字段：
    Identity/@Name          ← Product identity → Package/Identity/Name
    Identity/@Publisher     ← Product identity → Package/Identity/Publisher
  本地自签测试时，Publisher 必须等于自签证书的 Subject。
-->
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">

  <Identity
    Name="${IDENTITY}"
    Publisher="${PUBLISHER}"
    Version="${msixVersion(VERSION)}"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>${DISPLAY}</DisplayName>
    <PublisherDisplayName>${PUBLISHER_DISPLAY}</PublisherDisplayName>
    <Description>${pkg.description || DISPLAY}</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>

  <Resources>
    <Resource Language="zh-CN" />
    <Resource Language="en-US" />
  </Resources>

  <Capabilities>
    <!-- 全信任桌面应用（Desktop Bridge）唯一必需的能力。 -->
    <rescap:Capability Name="runFullTrust" />
    <!--
      刻意不声明 unvirtualizedResources / broadFileSystemAccess：
      前者只给微软及其合作方发行的 PC 游戏，Store 基本不批；后者是给
      AppContainer 应用突破沙箱用的，full-trust 应用本来就是用户身份。
      为了避开 AppData 写重定向，我们把数据目录放到了 %USERPROFILE%\\ApkStart，
      完全不进虚拟化范围（见 src/core/store.js 的 STORE_BUILD）。
    -->
  </Capabilities>

  <Applications>
    <Application Id="${APP_ID}" Executable="app\\ApkStart.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="${DISPLAY}"
        Description="${pkg.description || DISPLAY}"
        BackgroundColor="#14161B"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png" />
        <uap:SplashScreen Image="Assets\\SplashScreen.png" BackgroundColor="#14161B" />
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
`;
}

// ---------------- 找 makeappx / signtool ----------------

function which(exe) {
  const cands = [];
  const push = (p) => { if (p) cands.push(p); };
  // 1) PATH
  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try { if (fs.statSync(p).isFile()) push(p); } catch (_) { /* next */ }
  }
  // 2) Windows SDK（10.0.x 任意版本，优先 x64）
  const kits = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Windows Kits', '10', 'bin'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'App Certification Kit'),
  ];
  for (const k of kits) {
    let versions = [];
    try { versions = fs.readdirSync(k); } catch (_) { continue; }
    for (const v of versions) {
      for (const arch of ['x64', 'x86', '']) {
        const p = arch ? path.join(k, v, arch, exe) : path.join(k, v, exe);
        try { if (fs.statSync(p).isFile()) push(p); } catch (_) { /* next */ }
      }
    }
  }
  // 3) electron-builder 自己下载的工具缓存（跑过一次 --win appx 就有）
  const cacheRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
  const stack = [cacheRoot];
  let guard = 0;
  while (stack.length && guard < 6000) {
    const dir = stack.pop();
    guard += 1;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === exe.toLowerCase()) push(p);
    }
  }
  if (!cands.length) return null;

  /**
   * 挑最新的一份工具。
   *
   * 这一步很关键：winCodeSign 解出来的工具集里同时有 windows-6 / windows-8 /
   * windows-10 三代 signtool.exe。windows-6 那份签 MSIX 会直接报
   * `0x80080209 (SignerSign failed)` —— 它还不认识 MSIX 的 SIP 结构。
   * 所以必须显式偏好 windows-10\x64，而不是「先把哪个找出来就用哪个」。
   */
  const score = (p) => {
    const l = p.toLowerCase();
    let s = 0;
    if (/\\windows-10\\x64\\/.test(l)) s += 100;
    else if (/\\windows-10\\/.test(l)) s += 60;
    if (/\\windows-1[01]\\x64\\/.test(l)) s += 40;
    if (/\\x64\\/.test(l)) s += 10;
    if (/\\windows-6\\|\\windows-8\\|\\darwin\\|\\linux\\/.test(l)) s -= 200;
    return s;
  };
  cands.sort((a, b) => (score(b) - score(a)) || b.localeCompare(a, 'en'));
  return cands[0];
}

function run(exe, args, opts = {}) {
  return execFileSync(exe, args, { stdio: 'inherit', windowsHide: true, ...opts });
}

// ---------------- 主流程 ----------------

function stagePackage() {
  const appSrc = STAGE;
  if (!fs.existsSync(path.join(appSrc, 'ApkStart.exe'))) {
    console.error(`\n找不到 ${path.join(appSrc, 'ApkStart.exe')}。`);
    console.error('先跑一次：npx electron-builder --win dir --x64');
    console.error('（只有 dir 目标会把 build/runtime 放进 resources/runtime；');
    console.error('  手工拼出来的 dist/ApkStart-win64-portable 不含完整运行时。）\n');
    process.exit(1);
  }
  const work = path.join(OUT_DIR, '.stage');
  fs.rmSync(work, { recursive: true, force: true });
  const appDir = path.join(work, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  console.log('复制应用载荷…');
  fs.cpSync(appSrc, appDir, { recursive: true });
  // 这些是 Electron/electron-builder 的中间产物，不该进包
  for (const junk of ['builder-debug.yml', 'builder-effective-config.yaml', '.icon-ico']) {
    fs.rmSync(path.join(appDir, junk), { force: true, recursive: true });
  }
  console.log('生成商店图标…');
  const made = writeAssets(path.join(work, 'Assets'));
  for (const m of made) console.log(`  ${m}`);
  fs.writeFileSync(path.join(work, 'AppxManifest.xml'), manifest(), 'utf8');
  console.log(`清单：Identity=${IDENTITY} Publisher=${PUBLISHER} Version=${msixVersion(VERSION)}`);
  return work;
}

function main() {
  console.log(`ApkStart MSIX 打包  版本 ${VERSION} → ${msixVersion(VERSION)}`);
  console.log(`载荷目录 ${STAGE}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = stagePackage();

  const makeappx = which('makeappx.exe');
  if (!makeappx) {
    console.error('\n找不到 makeappx.exe。两条路任选：');
    console.error('  A. 装 Windows SDK（只勾 Windows SDK 即可，不用装 Visual Studio）：');
    console.error('     https://developer.microsoft.com/windows/downloads/windows-sdk/');
    console.error('  B. 先跑一次 npx electron-builder --win appx，让它把 windows-kits-bundle 下到缓存里，');
    console.error('     这个脚本会自动从 electron-builder 缓存里找。');
    console.error(`\nstage 目录已经准备好，手工打包：\n  "${'<makeappx.exe>'}" pack /d "${work}" /p "${path.join(OUT_DIR, artifactName())}" /o\n`);
    process.exit(2);
  }
  const out = path.join(OUT_DIR, artifactName());
  console.log(`\n用 ${makeappx} 打包…`);
  fs.rmSync(out, { force: true });
  run(makeappx, ['pack', '/d', work, '/p', out, '/o', '/v']);

  const mb = fs.statSync(out).size / 1048576;
  console.log(`\n完成：${out}  (${mb.toFixed(0)} MB)`);

  // 用 .NET 的 ZipFile 自检：包内必须有清单 + 块映射 + 内容类型
  try {
    const { execFileSync: ex } = require('child_process');
    const ps = [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem;`
      + `$z=[IO.Compression.ZipFile]::OpenRead('${out.replace(/'/g, "''")}');`
      + `$n=$z.Entries | ForEach-Object { $_.FullName }; $z.Dispose();`
      + `foreach($k in @('AppxManifest.xml','AppxBlockMap.xml','[Content_Types].xml')){`
      + ` if($n -contains $k){ "OK   $k" } else { "MISS $k" } }`
      + `"entries: " + $n.Count`,
    ];
    ex('powershell.exe', ps, { stdio: 'inherit', windowsHide: true });
  } catch (_) { /* 自检失败不影响产物 */ }

  if (DO_SIGN) sign(out);
  else {
    console.log('\n未签名（Store 会用自己的证书重签，提交时不需要签名）。');
    console.log('本地想装的话加 --sign 生成自签证书并签名。');
  }
  console.log(`\n提交前先读一遍 docs/store-msix.md。`);
}

function artifactName() {
  return `ApkStart_${msixVersion(VERSION)}_x64.msix`;
}

function sign(file) {
  const signtool = which('signtool.exe');
  if (!signtool) {
    console.error('\n找不到 signtool.exe，跳过签名。');
    return;
  }
  const pfx = path.join(OUT_DIR, 'ApkStart-test.pfx');
  const pwd = process.env.APKSTART_MSIX_PFX_PASSWORD || 'ApkStart!test';
  const subject = PUBLISHER;   // 必须与清单里的 Publisher 逐字一致
  if (!fs.existsSync(pfx)) {
    console.log(`\n生成自签证书（Subject=${subject}）…`);
    const ps = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$c = New-SelfSignedCertificate -Type Custom -KeyUsage DigitalSignature`
      + ` -CertStoreLocation 'Cert:\\CurrentUser\\My'`
      + ` -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')`
      + ` -Subject '${subject}' -FriendlyName 'ApkStart MSIX Test';`
      + `$p = ConvertTo-SecureString -String '${pwd}' -Force -AsPlainText;`
      + `Export-PfxCertificate -Cert ("Cert:\\CurrentUser\\My\\" + $c.Thumbprint) -FilePath '${pfx}' -Password $p | Out-Null;`
      + `"thumbprint=" + $c.Thumbprint`,
    ];
    try { run('powershell.exe', ps); } catch (e) { console.error(`生成证书失败：${e.message}`); return; }
  }
  console.log('签名…');
  try {
    run(signtool, ['sign', '/a', '/v', '/fd', 'SHA256', '/f', pfx, '/p', pwd, file]);
  } catch (e) {
    console.error(`签名失败：${e.message}`);
    console.error('\n注意：electron-builder 缓存里的 winCodeSign 工具集是裁剪过的，');
    console.error('里面的 signtool.exe 签 MSIX 会报「A required function is not present」');
    console.error('（缺少 MSIX 的 SIP 提供程序注册）。真要本地试装，请用完整 Windows SDK 里的 signtool：');
    console.error('  "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe" \\');
    console.error(`    sign /fd SHA256 /a /f "${pfx}" /p "${pwd}" "${file}"`);
    console.error('\n**上架不需要本地签名**：Microsoft Store 会用自己的证书重签你上传的包。');
    return;
  }
  console.log('\n信任证书（管理员 PowerShell 里执行一次，之后才能 Add-AppxPackage）：');
  console.log(`  Import-PfxCertificate -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPeople' -FilePath '${pfx}' -Password (ConvertTo-SecureString '${pwd}' -Force -AsPlainText)`);
  console.log(`  Add-AppxPackage -Path '${file}'`);
}

if (require.main === module) main();

module.exports = { msixVersion, manifest, composeIcon, which, ASSETS };
