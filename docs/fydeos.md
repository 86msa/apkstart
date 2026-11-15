# ApkStart for FydeOS

> 这是 ApkStart 的 **FydeOS 版本**：不再在 Windows 上跑一台安卓虚拟机，而是直接驱动
> FydeOS 系统自带的安卓环境。
>
> 一句话区别：**Windows 版是「在你电脑里开一台安卓手机」，FydeOS 版是「FydeOS 本来就是
> 安卓设备，ApkStart 负责把 APK 装进去、摆到桌面上」。**

## 为什么会有这个版本

Windows 版无论怎么优化，都要付一份虚拟机开销：几个 GB 的镜像、开机几秒到几十秒、
额外 3GB 左右内存。而 FydeOS（基于 ChromiumOS）本身就能跑安卓应用，这些开销天然不存在。

所以 FydeOS 版做的是**减掉一整层**：不下载镜像、不开机、不管快照，只保留 ApkStart 真正
有价值的那部分体验：

- 把 APK 拖进来就装好（不用碰命令行）；
- 自动生成桌面/应用菜单图标，双击直接进应用；
- 每个应用一个干净窗口；
- 应用清单和图标统一管理。

## 它做不到什么（先说清楚）

| 能力 | Windows 版 | FydeOS 版 |
|------|-----------|-----------|
| 窗口嵌入（画面塞进 ApkStart 窗口） | ✅ | ❌ **不支持** |
| 独立窗口（每个应用一个原生窗口） | ✅ | ✅ |
| 自己下载安卓镜像 | ✅ | ❌ 安卓由系统提供 |
| 快速启动快照 | ✅ | ❌ 不需要，系统一直开着 |
| 横竖屏物理面板切换 | ✅ | ❌ 由系统管 |
| 虚拟机内存/核数调整 | ✅ | ❌ 系统管 |

**关于窗口嵌入**：它是靠 Win32 的 `SetParent(HWND)` 实现的，而 FydeOS 的桌面是
Aura/Wayland，根本没有 HWND 这回事。所以 FydeOS 版只有独立窗口模式 —— 好消息是
独立窗口本来就是体验更好的那个模式（没有黑边、点击不会错位）。

## 前置条件

1. **FydeOS 已安装并能正常使用安卓应用**（能从应用商店装应用、能打开安卓设置）。
2. **开启 ADB 调试**：
   - 打开「安卓设置」（不是 FydeOS 设置）→ 系统 → 开发者选项 → 打开 **ADB 调试**；
   - 如果找不到「开发者选项」：安卓设置 → 关于设备 → 连续点「版本号」7 次。
3. **开启 Linux 子系统**（Penguin）：FydeOS 设置 → Linux → 开启。
   ApkStart 的 FydeOS 版跑在 Linux 子系统里。
4. 在 Linux 终端里装 adb：
   ```bash
   sudo apt update && sudo apt install -y adb
   ```

## 安装 ApkStart

### 方式一：AppImage（推荐）

```bash
# 把 ApkStart-*.AppImage 放到一个固定位置
mkdir -p ~/Applications
mv ~/Downloads/ApkStart-*.AppImage ~/Applications/ApkStart.AppImage
chmod +x ~/Applications/ApkStart.AppImage

# 直接运行
~/Applications/ApkStart.AppImage
```

AppImage 不需要安装、不污染系统，删掉文件就等于卸载。

### 方式二：从源码构建

```bash
git clone https://github.com/RoutineMiku/apkstart.git
cd apkstart
git checkout feat/fydeos
npm install
npm run pack:linux        # 产物在 dist-linux/
```

## 第一次使用

1. 打开 ApkStart，进 **设置 → 运行时**，把「引擎模式」选成 **FydeOS 安卓子系统**。
2. 地址留空即可（会自动依次尝试 `arc:5555`、`100.115.92.2:5555`、`127.0.0.1:5555`）。
3. 点「检测」。第一次连接时 **FydeOS 会弹出「允许 USB 调试吗」的授权框，点允许**。
4. 状态栏出现 `● 网络正常`（或设备序列号）就说明接通了。
5. 把 APK 拖进窗口，装好后桌面会出现图标。

## 常见问题

### 提示「没有连上安卓子系统」

按顺序排查：

```bash
# 1. adb 装了吗
which adb

# 2. 目标能连通吗
adb connect arc:5555
adb devices          # 期望看到 arc:5555  device

# 3. 如果显示 unauthorized
adb kill-server && adb start-server
# 然后回到安卓界面点「允许」

# 4. arc 解析不了就换 IP
adb connect 100.115.92.2:5555
```

### 一直显示 unauthorized，授权框也不弹

这是在 FydeOS X 某些版本上已知的问题，原因是宿主机和 Linux 子系统的 adb key 不一致。
手工把 key 同步过去：

```bash
# 1. 在 Linux 子系统里生成 key
adb start-server
ls ~/.android/adbkey.pub          # 确认存在

# 2. 打开 Crosh（Ctrl+Alt+T），输入 shell 进入宿主机
shell

# 3. 把上面的 adbkey.pub 内容写进安卓的授权列表（需要 rootfs 可写）
sudo mount -o remount,rw /
sudo mkdir -p /opt/google/containers/android/rootfs/android-data/data/misc/adb
sudo cat > /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys <<'EOF'
<把你 cat ~/.android/adbkey.pub 的内容粘在这里>
EOF
sudo chown 1000:1000 /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys
sudo mount -o remount,ro /
```

然后重启安卓子系统，再 `adb connect arc:5555`。

### 应用装上了但桌面没有图标

`.desktop` 文件写在两个地方：

- 桌面：`~/Desktop`
- 应用菜单：`~/.local/share/applications/ApkStart/`

检查权限：

```bash
ls -l ~/.local/share/applications/ApkStart/
chmod +x ~/.local/share/applications/ApkStart/*.desktop
```

有些桌面环境需要重新登录（或 `update-desktop-database ~/.local/share/applications`）
才能刷新应用菜单。

### 应用窗口黑屏 / 打不开

FydeOS 的安卓环境对显卡有要求（官方说明：兼容 Intel 显卡和部分 AMD 显卡）。
先确认系统自带的安卓应用能正常打开；如果系统自己的应用都黑屏，那不是 ApkStart 的问题。

## 和 Windows 版的关系

两个版本共用同一套代码，区别只在「底座」这一层：

```
src/core/backends/
  builtin.js    ← Windows：自带 QEMU + Android-x86
  mumu.js       ← Windows：复用已装的 MuMu
  fydeos.js     ← FydeOS / Linux：驱动系统自带安卓环境
```

上层（应用清单、安装流程、图标、窗口编排）完全不变。所以以后要给 FydeOS 版加功能，
通常 Windows 版也会一起受益。

## 目前的状态

- 底座逻辑（连接、授权、错误提示、能力声明）已实现并有单元测试覆盖。
- `.desktop` 生成已实现并测试（可执行位、Exec 转义、PNG 图标）。
- **Linux 二进制需要在 Linux 环境里构建**（`npm run pack:linux`），Windows 上没法交叉
  编译出可用的 AppImage。
- 尚未在真实 FydeOS 设备上跑过端到端流程 —— 如果你有一台，欢迎反馈结果。
