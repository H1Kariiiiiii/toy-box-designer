# 玩具包装盒设计助手 - Photoshop 插件开发者模式安装脚本
# 用法：powershell -ExecutionPolicy Bypass -File install-dev.ps1
$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $src 'CSXS\manifest.xml'))) {
  Write-Host '❌ 未找到 CSXS\manifest.xml，请从 ps-plugin 目录运行本脚本'
  exit 1
}

$target = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.toybox.psplugin'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
# 只复制运行所需内容，排除工具/产物/预览（build=ZXPSignCmd+证书、dist=zxp、preview=浏览器预览、脚本自身）
New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-ChildItem $src | Where-Object { $_.Name -notin @('build', 'dist', 'preview', 'install-dev.ps1', 'build-zxp.ps1') } | ForEach-Object {
  Copy-Item $_.FullName -Destination $target -Recurse -Force
}
Write-Host "✅ 已复制到 $target（不含 build/dist/preview）"

# 开启开发者模式（免签名加载）：CSXS.8=PS2018, CSXS.9=PS2019/2020, CSXS.10/11=PS2021+
foreach ($v in 8..11) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name PlayerDebugMode -Value 1 -Type String
}
Write-Host '✅ 已开启开发者模式（PlayerDebugMode=1，CSXS.8~11）'

Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 完全退出并重启 Photoshop（2018~2020）'
Write-Host '  2. 菜单：窗口 → 扩展功能 → 玩具包装盒设计助手'
Write-Host '  3. 面板右下角点「测试 PS 连接」，应显示绿色已连接'
