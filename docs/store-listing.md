# Microsoft Store 提交材料（ApkStart 0.5.0）

> 这份文件是给 Partner Center 表单直接复制用的。包体、图标、清单由脚本产出，
> 只有「注册账号 → 预留名称 → 上传 → 送审」必须在网页上人工完成。

---

## 1. 基本信息

| 字段 | 值 |
|---|---|
| Product name | `ApkStart` |
| Category | Developer tools → Utilities & tools（备选：Productivity） |
| Price | Free |
| Package | `dist/store/ApkStart_0.5.0.0_x64.msix`（x64，约 852 MB） |
| 支持语言 | 简体中文 / English (United States) |
| 官网 | https://github.com/RoutineMiku/apkstart |
| 支持邮箱 | <!-- 填你的邮箱 --> |
| 隐私政策 | https://github.com/RoutineMiku/apkstart/blob/main/docs/privacy.md（或自建页面） |

---

## 2. 短描述（≤100 字符）

**中文**
```
双击 APK 即可在 Windows 上运行安卓应用：独立窗口、桌面图标、运行时内置，装完即用。
```

**English**
```
Run Android apps on Windows by double-clicking an APK. Each app gets its own window.
```

---

## 3. 详细描述（≤10,000 字符）

**中文**

```
ApkStart 把安卓应用变成 Windows 上"能被安装和打开"的普通软件。

不用先开模拟器、不用配置 ADB、不用找镜像。装好 ApkStart 之后，你在资源管理器里
双击一个 .apk 文件，它就会自动解析、安装，并在桌面和开始菜单各放一个带真实应用
图标的快捷方式——之后双击那个图标，就是直接启动这个安卓应用。

■ 应用就是一个窗口
每个安卓应用运行在独立窗口里：竖屏应用保持手机比例并铺满屏幕高度，横屏应用按
16:9 铺满；窗口模式可以自由拖动缩放，每个应用的尺寸单独记住。按 F11 随时切换
全屏 / 窗口。

■ 像原生软件一样被找到
安装 APK 后会自动创建桌面与开始菜单快捷方式，Windows 搜索里直接输应用名就能
打开，任务栏也按应用分组。

■ 文件互通
%USERPROFILE%\ApkStartShared 与安卓内的 /sdcard/ApkStartShared 双向同步。
安卓应用存下来的文件，Windows 这边直接就能看到。

■ 一次下载，装完即用
安装包内置完整的 Android 运行时（模拟器、platform-tools、系统镜像），
运行时不下载任何可执行内容。

■ 轻量
壳层零第三方依赖；运行时按需拉起、空闲自动回收。也可以复用你机器上已有的
Android 运行时，额外占用为零。

■ 网络直接用主机的
安卓侧走 QEMU 用户态 NAT，出口复用主机物理网卡，不会创建任何虚拟网卡或
虚拟交换机，不需要装驱动。

──────────── 系统要求 ────────────
· Windows 10 版本 2004（build 19041）或更高，x64
· 需要启用"虚拟机平台"（Windows 功能里的 Windows Hypervisor Platform / WHPX），
  这是微软商店版唯一支持的硬件加速方式（商店应用不允许安装内核驱动）
· 建议 8 GB 以上内存；系统盘预留约 4 GB 用于展开系统镜像

──────────── 首次启动 ────────────
第一次打开会把安装包内的系统镜像展开到 %USERPROFILE%\ApkStart\data
（约 3.3 GB，通常 1 分钟内完成）。之后启动不需要联网。

──────────── 说明 ────────────
· 商店版由 Microsoft Store 负责更新，应用内不提供自更新。
· 卸载应用不会自动删除 %USERPROFILE%\ApkStart\data 里的数据；需要彻底清理时
  请手动删除该目录。
· 本应用不收集个人数据，不含广告，不含内购。
```

**English**（可选，若只提交中文可留空）

```
ApkStart turns Android apps into regular Windows software you can install and open.

After installing ApkStart, double-click any .apk in File Explorer. It is parsed and
installed automatically, and a shortcut with the app's real icon appears on your
Desktop and in the Start menu. Double-clicking that shortcut launches the Android
app directly.

· One app, one window — portrait apps keep their phone aspect ratio and fill the
  screen height; landscape apps fill 16:9. Windowed mode is freely resizable and
  remembers each app's size. F11 toggles full screen.
· Discoverable like native software — Desktop and Start menu shortcuts are created
  on install, so Windows Search finds apps by name.
· Shared files — %USERPROFILE%\ApkStartShared syncs both ways with
  /sdcard/ApkStartShared inside Android.
· One download, ready to use — the Android runtime (emulator, platform-tools,
  system image) ships inside the package. Nothing executable is downloaded at runtime.
· Lightweight — zero third-party dependencies in the shell; the runtime starts on
  demand and is reclaimed when idle.
· Host networking — Android uses QEMU user-mode NAT over the host NIC. No virtual
  adapter, no driver.

Requirements: Windows 10 2004 (build 19041) or later, x64; "Virtual Machine Platform"
(Windows Hypervisor Platform) enabled; 8 GB RAM recommended; ~4 GB free disk for the
system image.

First launch expands the bundled system image to %USERPROFILE%\ApkStart\data
(~3.3 GB, usually under a minute). No network access is needed afterwards.
```

---

## 4. 功能列表（Features，每条 ≤200 字符，最多 20 条）

1. 双击 .apk 自动安装，无需打开模拟器界面
2. 每个应用生成独立桌面图标与开始菜单快捷方式
3. 应用以独立窗口运行，支持全屏 / 窗口模式与尺寸记忆
4. 自动识别竖屏 / 横屏应用并按正确比例铺满
5. Windows 搜索可直接搜到已安装的安卓应用
6. Windows 与安卓共享文件夹双向同步
7. 内置完整运行时，安装后不再下载任何可执行内容
8. 运行时按需启动、空闲回收，壳层零第三方依赖
9. 不创建虚拟网卡、不安装内核驱动，网络直接复用主机
10. 自动授予运行时权限，闪退自动重试

---

## 5. 截图（至少 1 张，建议 4 张）

要求：PNG，**1366×768 或更大**，单张 ≤50 MB，最多 10 张。

建议顺序：

1. 主界面（应用列表 + 已安装应用卡片）
2. 一个竖屏应用正在运行（红果短剧）
3. 一个横屏应用正在运行（墨读）
4. 安装 APK 的瞬间（拖入 / 双击后自动解析）

> 现有 `docs/images/app.png` 等是 1140×740，**不满足** 1366×768 下限，
> 需要按 `docs/store-msix.md` 第 6 节重新截 1920×1080。

---

## 6. Notes for certification（给审核员，必填）

```
ApkStart is an Android app runner for Windows. It bundles Google's official Android
emulator (qemu-system-x86_64.exe) and an AOSP system image inside the MSIX package.
No executable content is downloaded at runtime.

How to test:
1. Install the package and launch ApkStart.
2. On first launch it expands the bundled system image to
   %USERPROFILE%\ApkStart\data (~3.3 GB, about one minute). This is local extraction,
   not a download.
3. Drag any .apk onto the window (or double-click an .apk after enabling the file
   association in Settings) to install it. A shortcut appears on the Desktop.
4. Double-click the shortcut to run the Android app in its own window.

Notes:
· The app does not install APKs from the network on its own; the user must provide
  the .apk file.
· Hardware acceleration uses Windows Hypervisor Platform (WHPX), which is part of
  Windows. No driver or service is installed. If WHPX is not enabled, the app shows
  instructions instead of falling back silently.
· Full-trust desktop app (runFullTrust). Data is stored under %USERPROFILE%\ApkStart,
  outside AppData, to avoid MSIX write virtualization breaking child processes.
· No telemetry, no ads, no in-app purchases, no account required.
```

---

## 7. 年龄分级（IARC 问卷）

- 应用本身不含内容，但可运行第三方安卓应用 → 选择「用户可访问第三方内容」
- 不含用户生成内容分享、不含社交功能、不含位置共享
- 结果通常为 3+ / Everyone

---

## 8. 上传步骤（人工，约 15 分钟）

1. 打开 <https://partner.microsoft.com/dashboard>，进入 **Apps and games → New product → MSIX or PWA app**。
2. 预留名称 `ApkStart`，进入 **Product management → Product identity**，
   复制 `Package/Identity/Name` 与 `Package/Identity/Publisher`。
3. 如果这两个值和 `RoutineMiku.ApkStart` / `CN=RoutineMiku` 不同，重新出包：
   ```powershell
   node build/msix.js --identity "<Identity/Name>" --publisher "<Identity/Publisher>"
   ```
   （只换图标不需要改身份，直接 `node build/msix.js` 即可。）
4. **Packages** → 上传 `dist/store/ApkStart_0.5.0.0_x64.msix`，等待校验通过。
5. **Store listing** → 填第 2–5 节的内容、上传截图、选分类。
6. **Pricing and availability** → Free，市场选中国 + 全球。
7. **Submission options** → 粘贴第 6 节的 certification notes。
8. **Age ratings** → 完成 IARC 问卷。
9. 提交审核。首个包通常 1–3 个工作日。

> 不要用 Store submission API 创建首个 submission：一旦用 API 建过，
> 该 submission 就不能再回网页编辑，会进入不可恢复的 error 状态。
