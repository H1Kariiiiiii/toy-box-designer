/**
 * PDF/X 印刷稿导出模块（主进程）
 * 链路：渲染进程 SVG（含 3mm 出血）→ 隐藏窗口 printToPDF（sRGB PDF，mm 精确页面）
 *      → Ghostscript -dPDFX=3 -sColorConversionStrategy=CMYK 转 PDF/X-3 + CMYK + TrimBox/BleedBox
 * 参考：Ghostscript VectorDevices 文档 "Creating a PDF/X document"
 */
const { BrowserWindow, app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BLEED_MM = 3; // 出血

/* ---------------- Ghostscript 定位 ---------------- */
function resourcesRoot() {
  // 打包后：resources 在 app.asar 同级的 resources 目录；开发时：项目根 /resources
  if (fs.existsSync(path.join(process.resourcesPath, 'gs'))) return process.resourcesPath;
  return path.join(__dirname, 'resources');
}

function findGs() {
  const root = resourcesRoot();
  const candidates = [
    path.join(root, 'gs', 'Library', 'bin', 'gswin64c.exe'),
    path.join(root, 'gs', 'bin', 'gswin64c.exe'),
    path.join(root, 'gs', 'gswin64c.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function findIcc() {
  const root = resourcesRoot();
  const gsRoot = path.join(root, 'gs');
  const candidates = [
    path.join(gsRoot, 'Library', 'lib', 'iccprofiles', 'default_cmyk.icc'),
    path.join(gsRoot, 'share', 'ghostscript', 'iccprofiles', 'default_cmyk.icc'),
    path.join(gsRoot, 'iccprofiles', 'default_cmyk.icc'),
  ];
  // share/ghostscript/<version>/iccprofiles 探测
  const verDir = path.join(gsRoot, 'share', 'ghostscript');
  if (fs.existsSync(verDir)) {
    for (const v of fs.readdirSync(verDir)) {
      candidates.push(path.join(verDir, v, 'iccprofiles', 'default_cmyk.icc'));
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function gsStatus() {
  const exe = findGs();
  return {
    available: !!exe,
    path: exe || null,
    icc: exe ? !!findIcc() : false,
  };
}

/* ---------------- 工具 ---------------- */
function tmpDir() {
  const d = path.join(app.getPath('userData'), 'tmp');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function runProcess(exe, args, env, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true, env });
    let out = '';
    let errOut = '';
    const killTimer = setTimeout(() => {
      try { p.kill(); } catch (e) { /* ignore */ }
      reject(new Error('Ghostscript 超时（120 秒），已终止'));
    }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < 4096) out += d.toString(); }); // 截断，防 gs 疯狂输出占内存
    p.stderr.on('data', (d) => { if (errOut.length < 4096) errOut += d.toString(); });
    p.on('error', (e) => { clearTimeout(killTimer); reject(new Error(`无法启动 ${path.basename(exe)}：${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else {
        const detail = (errOut + '\n' + out).trim().slice(-1200);
        reject(new Error(`Ghostscript 转换失败（退出码 ${code}）：\n${detail}`));
      }
    });
  });
}

/** 校验 PDF 输出文件真实有效（防 gs 退出码 0 但输出缺失/损坏） */
function assertPdfFile(p) {
  const st = fs.statSync(p);
  if (!st.isFile() || st.size < 100) throw new Error('PDF/X 输出异常（文件缺失或过小）');
  const head = fs.readFileSync(p).subarray(0, 5).toString('latin1');
  if (!head.startsWith('%PDF-')) throw new Error('PDF/X 输出异常（非 PDF 文件）');
}

/** GS 库目录探测：按实际找到的 exe 反推（候选 1: gs/Library/bin；候选 2/3: gs/bin、gs/），兼容 share/ghostscript/<ver> 布局 */
function gsLibDirs(gsExe) {
  const root = path.dirname(path.dirname(gsExe)); // bin 的上一级（Library 或 gs 根）
  const dirs = [path.join(root, 'lib'), path.join(root, 'Init')];
  const verRoot = path.join(root, 'share', 'ghostscript');
  if (fs.existsSync(verRoot)) {
    for (const v of fs.readdirSync(verRoot)) {
      dirs.push(path.join(verRoot, v, 'lib'), path.join(verRoot, v, 'Init'));
    }
  }
  return dirs.filter(fs.existsSync);
}

/* ---------------- 导出主流程 ---------------- */
/** 生成 PDFX_def.ps：官方模板（应用资源）+ ICC 绝对路径。dir 为本次导出的唯一临时目录。
 * 注意：ICC 路径不能含空格（gs 读失败），先复制到无空格临时目录；SAFER 下经 GS_LIB 放行读取 */
function writePdfxDef(iccPath, dir) {
  const iccCopy = path.join(dir, 'default_cmyk.icc');
  fs.copyFileSync(iccPath, iccCopy);
  // 模板在捆绑的 gs 资源里：打包后位于 process.resourcesPath/gs，开发时位于项目根 resources/gs
  const tmpl = fs.readFileSync(path.join(resourcesRoot(), 'gs', 'official_pdfx_def.ps'), 'utf8');
  // PostScript 字符串转义：路径若含括号/反斜杠会破坏模板语法
  const escPs = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const def = tmpl.replace(/\(ISO Coated sb\.icc\)/g, `(${escPs(iccCopy.replace(/\\/g, '/'))})`);
  const p = path.join(dir, 'pdfx_def.ps');
  fs.writeFileSync(p, def, 'utf8');
  return p;
}

async function exportPdfX({ svg, widthMm, heightMm, defaultName, forcePath }) {
  const gsExe = findGs();
  if (!gsExe) {
    throw new Error('未找到 Ghostscript，无法生成 PDF/X。请确认应用资源完整（resources/gs/）。');
  }
  const iccPath = findIcc();
  if (!iccPath) {
    throw new Error('未找到 CMYK ICC 配置文件（default_cmyk.icc）。');
  }

  // 输入校验：页面尺寸必须为有限正数（1-2000mm），svg 必须是合法 SVG 且不含可执行/嵌入元素
  const wMm = Number(widthMm), hMm = Number(heightMm);
  if (!Number.isFinite(wMm) || !Number.isFinite(hMm) || wMm <= 0 || wMm > 2000 || hMm <= 0 || hMm > 2000) {
    throw new Error('无效的页面尺寸（需为 1-2000mm 的有限数值）');
  }
  if (typeof svg !== 'string' || !/<svg[\s>]/i.test(svg) || !/<\/svg>/i.test(svg) || svg.length > 80 * 1024 * 1024) {
    throw new Error('无效的 SVG 内容');
  }
  if (/<script|<\/script|<foreignObject/i.test(svg)) {
    throw new Error('SVG 包含不允许的元素（script/foreignObject）');
  }

  // printToPDF 的 pageSize 数字单位实测为"英寸"（Electron 33），mm 需换算
  const W = wMm / 25.4; // 英寸
  const H = hMm / 25.4;
  const winW = W.toFixed(4);
  const winH = H.toFixed(4);

  // 本次导出的唯一临时目录（防并发导出互相覆盖/互删临时文件，finally 整目录删除）
  const runDir = path.join(tmpDir(), 'run_' + crypto.randomUUID().slice(0, 8));
  fs.mkdirSync(runDir, { recursive: true });

  // 1) 打印页 HTML：@page/body/svg 全部用英寸（与 printToPDF 同源）；svg 需 display:block 消除 inline baseline 间隙
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${winW}in ${winH}in; margin: 0; }
html, body { margin: 0; padding: 0; }
body { width: ${winW}in; height: ${winH}in; overflow: hidden; }
svg { display: block; width: ${winW}in !important; height: ${winH}in !important; }
</style></head><body>${svg}</body></html>`;
  const htmlPath = path.join(runDir, 'print.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  // 2) 隐藏窗口 printToPDF → sRGB PDF
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadFile(htmlPath);
    const pdfBuf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'none' },
      pageSize: { width: W, height: H }, // 英寸（Electron 33 d.ts 确认 pageSize 对象单位为 inches）
    });
    const srcPdf = path.join(runDir, 'print_srgb.pdf');
    fs.writeFileSync(srcPdf, pdfBuf);

    // 3) Ghostscript 转 PDF/X-3 + CMYK（GS_LIB 指向 gs 的 lib/Init；-dNOSAFER 允许读 ICC；
    //    TrimBox/BleedBox 出血偏移是页面设备参数，须经 setpagedevice 传入（单位 pt）
    const outPdf = path.join(runDir, 'print_pdfx.pdf');
    const defFile = writePdfxDef(iccPath, runDir);
    const env = { ...process.env };
    // runDir 必须进 GS_LIB：SAFER 模式下 GS_LIB/-I 目录默认可读，pdfx_def.ps 在 PostScript 层用 file 打开 ICC 才能成功
    env.GS_LIB = [...gsLibDirs(gsExe), runDir].filter(fs.existsSync).join(';');
    const bleedPt = (BLEED_MM / 25.4 * 72).toFixed(4); // 3mm → 8.5039pt
    await runProcess(gsExe, [
      // 开启 SAFER 沙箱并按目录白名单放行临时目录读写（读 ICC/输入 PDF、写出 PDF），替代 -dNOSAFER。
      // 注意：--permit-file-* 必须出现在 -dSAFER 之前，路径用正斜杠
      `--permit-file-read=${runDir.replace(/\\/g, '/')}`,
      `--permit-file-write=${runDir.replace(/\\/g, '/')}`,
      '-dSAFER',
      '-dPDFX=3', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pdfwrite',
      '-sColorConversionStrategy=CMYK', '-dAutoRotatePages=/None',
      // 位图压缩：Chromium printToPDF 会把 SVG 页面按 720dpi 栅格化（1.7 亿像素级），
      // 直接输出会让 PDF 膨胀到 7-14MB、查看器打开白屏数秒。三步处理：
      // 1) DCTEncode(JPEG Q90) 压缩位图（默认 Flate 对照片无效）；2) 降采样到印刷标准 300dpi
      // （720dpi 是打印冗余，300dpi 视觉无损）；3) 灰度/单色同规则
      '-dAutoFilterColorImages=false', '-dColorImageFilter=/DCTEncode', '-dJPEGQ=90',
      '-dDownsampleColorImages=true', '-dColorImageResolution=300',
      '-dAutoFilterGrayImages=false', '-dGrayImageFilter=/DCTEncode',
      '-dDownsampleGrayImages=true', '-dGrayImageResolution=300',
      '-dDownsampleMonoImages=true', '-dMonoImageResolution=1200',
      `-sOutputFile=${outPdf}`,
      '-c',
      `<</PDFXTrimBoxToMediaBoxOffset [${bleedPt} ${bleedPt} ${bleedPt} ${bleedPt}] /PDFXBleedBoxToTrimBoxOffset [${bleedPt} ${bleedPt} ${bleedPt} ${bleedPt}] /PDFXSetBleedBoxToMediaBox false /PDFXSetTrimBoxToMediaBox false>>setpagedevice`,
      '-f',
      defFile, srcPdf,
    ], env);
    assertPdfFile(outPdf); // 转换后校验输出真实有效

    // 4) 保存（正式走对话框；forcePath 仅 SMOKE 自动化测试使用）
    let filePath;
    if (process.env.SMOKE && forcePath) {
      filePath = forcePath;
      fs.copyFileSync(outPdf, filePath);
      return { saved: true, filePath, gs: gsExe };
    }
    // 传父窗口让对话框置顶（pdfx 模块无窗口引用，用当前焦点窗口）
    const parentWin = (typeof BrowserWindow !== 'undefined' && BrowserWindow.getFocusedWindow()) || undefined;
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(parentWin, {
      title: '保存印刷稿（PDF/X-3，CMYK，3mm 出血）',
      defaultPath: path.join(app.getPath('downloads'), defaultName || 'print.pdf'),
      filters: [{ name: 'PDF 印刷稿', extensions: ['pdf'] }],
    });
    if (canceled || !chosen) return { saved: false };

    fs.copyFileSync(outPdf, chosen);
    return { saved: true, filePath: chosen, gs: gsExe };
  } finally {
    win.destroy();
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不阻塞 */ }
  }
}

module.exports = { exportPdfX, gsStatus };
