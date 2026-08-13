// electron-builder afterPack 钩子：win-unpacked 生成后、NSIS 打包前，用 rcedit 注入应用图标与版本信息
// （signAndEditExecutable:false 时 electron-builder 跳过 exe 编辑以避开 winCodeSign 符号链接权限问题，这里用本地 rcedit-x64.exe 手动补上）
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function (context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'win32') return;
  const productName = packager.appInfo.productFilename; // 玩具包装盒设计助手
  const version = packager.appInfo.version;
  const exe = path.join(appOutDir, `${productName}.exe`);
  const ico = path.join(__dirname, 'icon.ico');
  const rcedit = path.join(__dirname, 'rcedit-x64.exe');
  if (!fs.existsSync(exe) || !fs.existsSync(ico) || !fs.existsSync(rcedit)) {
    console.log('afterPack: skip (exe/ico/rcedit missing)');
    return;
  }
  const args = [
    exe,
    '--set-icon', ico,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'CompanyName', '澄海玩具',
    '--set-version-string', 'LegalCopyright', `Copyright ${new Date().getFullYear()}`,
    '--set-file-version', version,
    '--set-product-version', version,
  ];
  console.log('afterPack: rcedit ->', exe);
  execFileSync(rcedit, args, { stdio: 'inherit' });
};
