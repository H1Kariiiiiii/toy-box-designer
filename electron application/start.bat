@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 玩具包装盒设计助手 ...
call npm start
pause
