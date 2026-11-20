; ApkStart 安装包（原生 makensis 构建，不需要 wine）
;
;   node build/pack.js 或 electron-builder --dir 先产出程序目录，然后：
;   makensis -DSRC=<程序目录> -DVERSION=0.6.1 -DOUT=<输出.exe> build/nsis/ApkStart-installer.nsi
;
; 与 electron-builder 的 NSIS 目标保持一致：按用户安装（不要管理员）、可选安装目录、
; 桌面 + 开始菜单快捷方式、控制面板卸载项；卸载 / 覆盖安装前先结束残留的运行时进程。
; 安装向导界面支持阿拉伯语与英语（跟随 Windows 语言）。

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!ifndef SRC
  !error "缺少 -DSRC=<程序目录>"
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef OUT
  !define OUT "ApkStart-${VERSION}-Setup.exe"
!endif

!define APPNAME "ApkStart"
!define COMPANY "RoutineMiku"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ApkStart"

Name "${APPNAME}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\ApkStart"
InstallDirRegKey HKCU "Software\ApkStart" "InstallDir"
BrandingText "${APPNAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=0 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=0 "FileDescription" "${APPNAME} Setup"
VIAddVersionKey /LANG=0 "CompanyName" "${COMPANY}"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "LegalCopyright" "Copyright (c) 2026 ApkStart"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!define MUI_ICON "${SRC}\resources\app\src\ui\assets\appicon.ico"
!define MUI_UNICON "${SRC}\resources\app\src\ui\assets\appicon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\ApkStart.exe"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Arabic"
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

LangString KillMsg ${LANG_ARABIC} "جارٍ إغلاق ApkStart والعمليات المتبقية…"
LangString KillMsg ${LANG_ENGLISH} "Closing ApkStart and leftover processes…"
LangString KillMsg ${LANG_SIMPCHINESE} "正在结束 ApkStart 残留进程…"
LangString ShortcutDesc ${LANG_ARABIC} "ApkStart — تشغيل تطبيقات Android على الحاسوب"
LangString ShortcutDesc ${LANG_ENGLISH} "ApkStart — run Android apps on your PC"
LangString ShortcutDesc ${LANG_SIMPCHINESE} "ApkStart — 在电脑上直接运行安卓应用"

; 安装 / 卸载前结束运行时进程，否则文件被锁，覆盖安装或卸载会不完整。
; 进程不存在时 taskkill 返回 128，忽略即可。
!macro KillRuntime
  DetailPrint "$(KillMsg)"
  nsExec::Exec 'taskkill.exe /F /T /IM ApkStart.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  Sleep 1500
!macroend

Function .onInit
  ; 跟随 Windows 显示语言：阿拉伯语系统用阿拉伯语向导，中文系统用中文，其余英文
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $1 $0 & 0x3FF
  ${If} $1 = 0x01
    StrCpy $LANGUAGE ${LANG_ARABIC}
  ${ElseIf} $1 = 0x04
    StrCpy $LANGUAGE ${LANG_SIMPCHINESE}
  ${Else}
    StrCpy $LANGUAGE ${LANG_ENGLISH}
  ${EndIf}
FunctionEnd

Function un.onInit
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $1 $0 & 0x3FF
  ${If} $1 = 0x01
    StrCpy $LANGUAGE ${LANG_ARABIC}
  ${ElseIf} $1 = 0x04
    StrCpy $LANGUAGE ${LANG_SIMPCHINESE}
  ${Else}
    StrCpy $LANGUAGE ${LANG_ENGLISH}
  ${EndIf}
FunctionEnd

Section "ApkStart" SecMain
  SectionIn RO
  !insertmacro KillRuntime
  SetOutPath "$INSTDIR"
  ; 覆盖安装时先清掉旧的程序文件（数据在 %APPDATA%\apkstart，不在这里，不受影响）
  RMDir /r "$INSTDIR\resources\app"
  File /r "${SRC}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall ApkStart.exe"
  WriteRegStr HKCU "Software\ApkStart" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\ApkStart.exe,0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall ApkStart.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall ApkStart.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  CreateShortcut "$DESKTOP\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 SW_SHOWNORMAL "" "$(ShortcutDesc)"
  CreateDirectory "$SMPROGRAMS\ApkStart"
  CreateShortcut "$SMPROGRAMS\ApkStart\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 SW_SHOWNORMAL "" "$(ShortcutDesc)"
SectionEnd

Section "Uninstall"
  !insertmacro KillRuntime
  Delete "$DESKTOP\ApkStart.lnk"
  Delete "$SMPROGRAMS\ApkStart\ApkStart.lnk"
  RMDir "$SMPROGRAMS\ApkStart"
  ; 只删程序目录；安卓数据与已装应用在 %APPDATA%\apkstart，按用户意愿另行清理
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\ApkStart"
SectionEnd
