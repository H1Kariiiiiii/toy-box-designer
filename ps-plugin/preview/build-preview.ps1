# build-preview.ps1 - 生成浏览器预览页（无 Photoshop 时查看插件 UI/3D）
# 用法：powershell -ExecutionPolicy Bypass -File ps-plugin/preview/build-preview.ps1
# 效果：从 index.html 生成 preview/index.html（路径改 ../ 前缀 + 注入 preview-mock.js），
#       然后浏览器直接打开 ps-plugin/preview/index.html 即可预览。
$ErrorActionPreference = 'Stop'
$previewDir = Split-Path -Parent $MyInvocation.MyCommand.Path   # ps-plugin/preview/
$srcHtml = Join-Path (Split-Path -Parent $previewDir) 'index.html'   # ps-plugin/index.html
$outHtml = Join-Path $previewDir 'index.html'

$html = Get-Content $srcHtml -Raw -Encoding UTF8
# 相对路径 → ../ 前缀（preview/index.html 在 ps-plugin 的子目录）
$html = $html -replace 'href="css/', 'href="../css/'
$html = $html -replace 'src="js/', 'src="../js/'
$html = $html -replace 'src="lib/', 'src="../lib/'
# 注入 preview-mock.js（在 three.js 之前，保证 require/CSInterface mock 先就位）
$mock = '  <script src="preview-mock.js"></script>' + "`n"
$html = $html -replace '  <script src="../lib/three.min.js">', ($mock + '  <script src="../lib/three.min.js">')
# 移除真实 CSInterface.js（预览环境无 CEP，真实库会覆盖 mock 的 CSInterface，导致 PS 提示失效）
$html = $html -replace '  <script src="../js/CSInterface.js"></script>' + "`n", ''

# 保留 BOM（PowerShell 5.1 中文兼容）
[System.IO.File]::WriteAllText((Resolve-Path $previewDir).Path + '\index.html', $html, (New-Object System.Text.UTF8Encoding $true))
Write-Host "✅ 已生成预览页: $outHtml"
Write-Host "浏览器打开该文件即可预览（无需 Photoshop）"
