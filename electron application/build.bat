@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  打包 玩具包装盒设计助手 为 Windows 安装包
echo  安装包生成在 release 目录
echo ============================================
REM 国内镜像加速（electron 二进制与打包工具下载）
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
REM 跳过代码签名（本工具无证书；也绕开 winCodeSign 符号链接解压 bug）
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm install
if errorlevel 1 goto :err
call npm run dist
if errorlevel 1 goto :err
echo.
echo 打包完成！安装包在 release 目录，双击安装后桌面会出现快捷方式。
pause
exit /b 0
:err
echo.
echo 打包失败，请把上面的报错截图发给开发同事。
pause
exit /b 1
