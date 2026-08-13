# build-zxp.ps1 - 打包 PS 插件为 .zxp（M5）
# 用法：powershell -ExecutionPolicy Bypass -File ps-plugin/build-zxp.ps1 [-CertPassword 'xxx']
# 流程：读 manifest 版本 → 生成/复用自签名证书（build/certs/toybox.p12，约 1 年有效）→ staging 复制（排除工具/产物）→
#       ZXPSignCmd -sign 签名打包 → ZXPSignCmd -verify 验证 → 输出 ps-plugin/dist/com.toybox.psplugin-<ver>.zxp
param([string]$CertPassword = 'toybox2026')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path   # ps-plugin/
$signCmd = Join-Path $root 'build\ZXPSignCmd.exe'
$certsDir = Join-Path $root 'build\certs'
$staging = Join-Path $env:TEMP 'toybox_zxp_staging'
$dist = Join-Path $root 'dist'
$certMaxAgeDays = 330 # 自签名证书约 1 年有效，提前 35 天提示重建

if (-not (Test-Path $signCmd)) { Write-Host "缺少 ZXPSignCmd.exe（应位于 ps-plugin\build\ZXPSignCmd.exe）"; exit 1 }

# 1. 版本号（从 manifest.xml 读 ExtensionBundleVersion）
$manifest = Get-Content (Join-Path $root 'CSXS\manifest.xml') -Raw -Encoding UTF8
$ver = [regex]::Match($manifest, 'ExtensionBundleVersion="([^"]+)"').Groups[1].Value
if (-not $ver) { Write-Host '无法从 manifest.xml 读取版本号'; exit 1 }
$outZxp = Join-Path $dist "com.toybox.psplugin-$ver.zxp"
Write-Host "版本: $ver"

# 2. 自签名证书（无则生成；过期前提示重建）
New-Item -ItemType Directory -Force -Path $certsDir | Out-Null
$p12 = Join-Path $certsDir 'toybox.p12'
$needCert = -not (Test-Path $p12)
if (-not $needCert -and ((Get-Date) - (Get-Item $p12).LastWriteTime).Days -gt $certMaxAgeDays) {
  Write-Host "证书已超过 $certMaxAgeDays 天，自动重建…"
  Remove-Item $p12 -Force
  $needCert = $true
}
if ($needCert) {
  Write-Host '生成自签名证书（约 1 年有效；到期前脚本会自动重建）…'
  & $signCmd -selfSignedCert CN Guangdong 'Toy Design Dept.' ToyBoxDesigner $CertPassword $p12
  if ($LASTEXITCODE -ne 0) { Write-Host '证书生成失败'; exit 1 }
}

# 3. staging 复制（排除 build/ dist/ install-dev.ps1 build-zxp.ps1）
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Get-ChildItem $root | Where-Object { $_.Name -notin @('build', 'dist', 'preview', 'install-dev.ps1', 'build-zxp.ps1') } | ForEach-Object {
  Copy-Item $_.FullName -Destination $staging -Recurse -Force
}
Write-Host "staging: $staging"

# 4. 签名打包
Write-Host '签名打包 .zxp …'
& $signCmd -sign $staging $outZxp $p12 $CertPassword
if ($LASTEXITCODE -ne 0) { Write-Host '打包失败'; exit 1 }

# 5. 验证
Write-Host '验证签名…'
& $signCmd -verify $outZxp -skipOnlineRevocationChecks
if ($LASTEXITCODE -ne 0) { Write-Host '验证失败'; exit 1 }

Remove-Item -Recurse -Force $staging
Write-Host "✅ 打包完成: $outZxp"
