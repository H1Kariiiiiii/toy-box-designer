# Bug 清单（测试驱动修复记录）

> 来源：`SMOKE` 测试（多批次 / 112 个硬断言，见 `main.js`），每次打包自动回归；任何断言失败将导致 `app.exit(1)`（红牌退出）。
> 验证基线：开发版 + 打包版均 **112/112 断言通过**、零 JS 错误。

---

## v0.7.0（2026-08-18，重大更新：装饰/徽章/认证/提手/存档补漏）

| # | 严重度 | 描述 | 修复 |
|---|--------|------|------|
| BUG-70 | 高 | **版面套版从不随方案存档**：`SCHEME_FIELDS` 白名单缺 `layout`/`badges`，历史方案载入后品牌/产品/网格/装饰全部丢失（README 声称支持但实际失效） | `main.js`：白名单补字段 + `cleanLayout()` 清洗（logo dataURL ≤500KB、blocks/gridItems clamp、字段白名单）；save/update/import 三处统一应用 |
| BUG-71 | 中 | **开窗窗口配置从不随方案存档**：`boxSize` 只存 w/d/h，窗口形状/位置/自定义形状丢失 | `main.js`：`cleanWin()` 清洗（百分比 clamp/形状白名单/提手参数），save/update/import 应用 |
| BUG-72 | 低 | **拖拽位置 blocks 不随方案恢复**（layout 未存档的连带问题） | 随 BUG-70 修复；`loadScheme` 恢复 blocks |
| — | — | **新功能（审查反馈 P0/P1/P2）**：版面装饰（渐变背景+斜切带，含出血延伸）、品牌 logo 上传（bar 区块图片）、功能徽章（8 种预设可拖拽）、认证标志扩展（UKCA/NOM/纸类回收）、开窗盒顶部提手（挂孔）、SMOKE +9 断言 | `layoutTemplates.js`/`app.js`/`boxes.js`/`index.html`/`style.css` |

> 说明：v0.7.0 让三张实物样例（黑红车模/黄色工程车/紫色宠物屋）的主要视觉元素均可产出：渐变/斜切背景、logo 图、功能徽章、UKCA/NOM/回收标志、提手结构；美术字 logo 仍需外部设计或上传图片。

---

## v0.6.2 修复（2026-08-18，P0/P1 生产性改进 + 审查反馈）

| # | 严重度 | 描述 | 修复 |
|---|--------|------|------|
| BUG-67 | 高 | **天地盖盖底同尺寸**：盖内径 = 底外径，无纸厚公差——实际工艺中盖子插不进去（样品房必打回） | `templates/boxes.js`：新增 `tol`（盖公差，默认 1.5mm/边），盖尺寸 = 底 + 2×tol（Wl/Dl 独立计算）；盒型页新增「盖公差」输入（仅天地盖可编辑，切换盒型自动禁用）；`getSize()` 透传 tol；SMOKE +6 断言 |
| BUG-68 | 中 | **印刷稿刀线无专色约定**：刀线是普通灰色 SVG 线条，GS 转 CMYK 后为四色灰，印厂无法识别模切版 | `renderer/app.js` `buildSvg` 新增 `dieSpot` 选项：印刷稿（PDF/X）导出时刀线（面板轮廓/窗口挖孔）改用 **100% Magenta（#ff00ff，印刷业 CutContour 约定色）**，折线/出血框保持橙色虚线（线型区分刀线/折线）；PNG 预览保持原配色；SMOKE +4 断言 |
| BUG-69 | 低 | **印刷稿合规小字发糊**：合规块最小字号 6px（≈1.5pt），300dpi 位图下仅 ~25px 高，再经 JPEG Q90 压缩严重发糊（必印信息不可读） | 合规块字号下限 6→8px（`drawComplianceBlock` 与质检 `runQualityCheck` 同步）；`pdfx.js` JPEG Q90→Q95（改善文字边缘振铃） |
| — | 低 | **P2 审查项确认**：exe 图标已由 `build/after-pack.js`（rcedit 注入）解决，无需改；app.js 单文件 2600+ 行拆分列为技术债（SMOKE 直接引用 window 全局 90+ 处，拆分风险>收益，后续版本评估） | 无代码改动 |

> 说明：刀线专色为**行业约定色方案**（100% Magenta = CutContour），SVG 无法原生表达专色通道；印厂按品红实线开模切版即可。若需真正的 Separation 专色通道，需导出后处理（后续版本评估）。

---

## 二轮审查修复（2026-08-08，高/中严重度共 28 项）

> 审查方式：4 并行只读子代理分模块（main.js / renderer / pdfx+lib / boxes+3D）审查 + 逐项回源码验证。

### 高严重度（6 项，已修复）

| # | 严重度 | 描述 | 修复 |
|---|--------|------|------|
| BUG-17 | 中 | **「本地质检」按钮点了不显示报告**：`renderQc()` 无参调用永远走空提示分支 | `renderer/app.js`：`renderQc(runQualityCheck())` |
| BUG-18 | 高 | **天地盖 3D 左右侧面纹理拉伸 2.17 倍且旋转 90°**：H×D 横躺面板贴到 D×H 竖立面 | `renderer/mockup.js`：宽高互换时先旋转 90°（left 逆时针/right 顺时针，按折叠边位置推导）再贴 |
| BUG-19 | 高 | **开窗盒条码与合规块重叠 + 条码溢出面板底部**：条码只按宽度缩放 | `renderer/app.js`：缩放同时受面板高度约束（shared 时 ≤45%），条码移至合规块下方，标注文字移到条码下方 |
| BUG-20 | 中 | **双插盒背面贴正面主视觉图**（与条码/合规块三层叠压） | `templates/boxes.js`：back 面板 `face → side` |
| BUG-21 | 高 | **生成流程无并发防护**：等待期间可并行发多个请求互相覆盖 state、方案库错乱 | `renderer/app.js`：全局 `lockGen/unlockGen` 并发锁（生成/批量/视觉质检互斥） |
| BUG-22 | 中 | **载入历史方案/导入后「导出 PNG」按钮仍禁用** | `renderer/app.js`：`loadScheme` 成功且有图时启用导出按钮 |

### 中严重度（20 项，已修复）

| # | 严重度 | 描述 | 修复 |
|---|--------|------|------|
| BUG-23 | 高 | **网络调用无超时**：generateImage/图片下载/vision:check/gs 进程挂死则 IPC 永久 pending | `main.js` 新增 `safeFetch`（超时+协议白名单+redirect:error）、`readBodyLimited`（流式限长）；`pdfx.js` `runProcess` 120s 超时+kill |
| BUG-24 | 高 | **scheme:import 无文件/张数/总量上限**：GB 级 JSON 吃内存、几万张 15MB 图填盘 | `main.js`：文件 ≤50MB、张数 ≤20、总量 ≤50MB、base64 长度预判先于解码 |
| BUG-25 | 中 | **scheme:save 无字段白名单**：`...s` 可覆盖 id/ts 撞删方案、伪造排序 | `main.js`：SCHEME_FIELDS 白名单 + 各字段长度 clamp |
| BUG-26 | 中 | **config:set 无 schema 校验 + 非原子写** | `main.js`：白名单字段校验（含 profiles/activeIndex）+ 临时文件 rename 原子写 |
| BUG-27 | 中 | **getSize 无上限**：99999mm 导出生成 118 万像素 canvas 内存爆炸 | `renderer/app.js`：20-3000mm 双向 clamp + input `max=3000` |
| BUG-28 | 中 | **导出/3D 用超长 data URL 加载 SVG**（2K/4K 图 base64 3-20MB，有长度限制和性能损耗） | `exportPng`/`svgToCanvas` 改 `Blob + createObjectURL`（finally revoke） |
| BUG-29 | 中 | **批量生成中途失败：已生成图不保留**（额度已花成果丢失） | `renderer/app.js`：部分成功时保留已生成方案并提示「部分完成」 |
| BUG-30 | 中 | **3D 多面纹理方向错误**：天地盖 bottom 条码倒置、back 文字镜像、双插盒 top 前后翻转 | `templates/boxes.js` 声明 `texFlip`（back 水平镜像、bottom/双插盒 top 垂直翻转），`renderer/mockup.js` 应用 |
| BUG-31 | 中 | **3D 资源泄漏**：重建时旧几何/材质/纹理不 dispose，GPU 显存累积 | `renderer/mockup.js`：`disposeGroup` 递归释放 |
| BUG-32 | 中 | **合规块行数截断**：60mm 高面板只能显示 2 行，6 字段静默丢 4 个 | `renderer/app.js`：块高按行数自适应（字号下限 6px）+ 质检 warn |
| BUG-33 | 中 | **3D 相机距离不足**：近正方体时盒子上下各裁约 40% | `renderer/mockup.js`：`dist = maxDim × 2.0` |
| BUG-34 | 中 | **cleanCache 误删导入方案图片**（manifest 引用失效） | `main.js`：清理跳过 `import_` 前缀 |
| BUG-35 | 中 | **pdfx 输入无校验**：NaN/负/超大尺寸、svg 裸嵌入 HTML | `pdfx.js`：尺寸 1-2000mm 有限数校验、svg 正则校验（拒绝 script/foreignObject）、80MB 上限 |
| BUG-36 | 中 | **vision:check dataUrl 无 MIME/大小校验** | `main.js`：仅接受 png/jpeg/webp base64 且 ≤10MB |
| BUG-37 | 中 | **未设 setWindowOpenHandler/will-navigate**（子窗口继承 preload 的纵深缺口） | `main.js`：deny 子窗口 + 仅 file: 导航 |
| BUG-38 | 中 | **pdfx -dNOSAFER 关闭 GS 沙箱** | `pdfx.js`：`-dSAFER` + `--permit-file-*`（须在 -dSAFER 前、正斜杠）+ tmpDir 加入 GS_LIB（PostScript 层 file 读 ICC 必需） |
| BUG-39 | 中 | **tmp 目录永不清理**、errOut 无上限拼接 | `pdfx.js`：导出 finally 清理本次临时文件 + 输出截断 4KB |
| BUG-40 | 低 | **图片文件名 Date.now()+序号碰撞覆盖** | `main.js`：追加 `crypto.randomUUID()` 前缀 |
| BUG-41 | 低 | **detectImageFormat 魔数不匹配仍按 png 落盘**（脏数据可落盘） | `main.js`：返回 null，调用点拒绝 |
| BUG-42 | 低 | **白名单仅字符串前缀比较**（junction/symlink 可逃逸）；白名单内文件无大小上限 | `main.js`：`realpathSync` 双端比较；readImage/save/export ≤64MB |
| BUG-43 | 低 | **api:test/vision:check 协议无白名单**（SSRF 面 + 凭据外泄） | `main.js`：统一 `safeFetch` 仅 http/https |
| BUG-44 | 低 | **SMOKE 文档断言数过时**（29 → 实际 53） | 本文档与 README 同步更新 |

---

## 后续修复（2026-08-10，7 项）

| # | 严重度 | 描述 | 修复 |
|---|--------|------|------|
| BUG-59 | 中 | **seed 范围校验缺失**：超范围 seed（>21 亿/0）被直接发给 API 报 HTTP 400 | `renderer/app.js` + `main.js`：仅接受 1~2147483647 整数，非法/超范围忽略并提示 |
| BUG-60 | 中 | **seed 类型错误**：seed 以字符串（`"1"`）发送，方舟严格 schema 报 400 `seed not valid` | `lib/imgRequest.js`：JSON 分支 `seed: Number(seed)` |
| BUG-61 | 中 | **图生图 image 参数格式错误**：裸 base64 被方舟拒（`invalid url specified`） | `lib/imgRequest.js`：改为完整 data URL `data:{mime};base64,...` |
| BUG-62 | 高 | **3D 方向校正（texFlip）加反**：天地盖/双插盒 back 面文字镜像、bottom 条码颠倒（推导时观察者屏幕方向用反） | 删除 `templates/boxes.js` 全部 `texFlip`（用 4 候选实验 + 识图确认"无翻转"为正立）；保留左右侧面 90° 旋转 |
| BUG-63 | 中 | **非法条码静默失败**：UPC 位数错/校验位错时条码不绘制且无提示（质检只在导出时跑） | `renderer/app.js` `updateBarcode` 即时校验（位数 + EAN-13/UPC-A 校验位）+ 界面红色提示 |
| BUG-64 | 低 | **方案导出后合规排版无法恢复**（FEAT-01 配套） | 方案新增 `compAuto/compFields/markets/barcode/bleed` 字段，存档/载入/导出/导入全链路携带（主进程 `cleanCompInfo` 白名单清洗） |
| BUG-65 | 低 | **pdfx 保存对话框无父窗口**（不置顶） | `pdfx.js`：`BrowserWindow.getFocusedWindow()` 作为父窗口 |
| BUG-66 | 低 | **SMOKE 断言覆盖缺口**：0.2.3~0.2.8 的功能（seed 类型/图生图 dataURL/条码即时校验/合规存档恢复/全选按钮/缓存保护）无回归保护 | `main.js`：新增 11 个断言（53→64），缓存测试改为自包含并验证"方案引用图保护" |

## 新功能（2026-08-10）

| # | 内容 | 说明 |
|---|------|------|
| FEAT-01 | **合规排版信息随历史方案存档/恢复** | 方案新增 `compAuto/compFields/markets/barcode/bleed` 字段（主进程 `cleanCompInfo` 白名单清洗），生成自动存档、历史方案载入、`.toybox.json` 导出/导入均完整携带；旧方案无字段时保持当前状态，完全兼容 |
| FEAT-02 | **缓存清理保护方案引用图片** | `cleanCache` 改为跳过 manifest 中所有方案引用的图片（含生成图 `box_*` 与导入图 `import_*`），替代原先仅保护 `import_` 的特判——生成图存档为方案后不再被"清空缓存"误删导致方案图片失效 |
| FEAT-03 | **合规检查「全部勾选/取消全部」** | 清单区顶部两个按钮，一键勾选/取消当前选中市场的全部合规项，统计与展开图同步更新 |

---

## 低严重度修复（2026-08-08，14 项）

| # | 严重度 | 描述 | 修复 |
|---|--------|------|------|
| BUG-45 | 低 | **loadFile promise 无 catch**（页面加载失败 unhandled rejection） | `main.js`：`loadDone.catch(console.error)` |
| BUG-46 | 低 | **api:test 错误回显可能泄漏凭据**（服务端回显 Authorization 头） | `main.js`：回显剥离 authorization/bearer 字样 |
| BUG-47 | 低 | **apiKey/visionApiKey 明文存 config.json** | `main.js`：`safeStorage`（Windows DPAPI）加密落盘，`enc:` 前缀标记，不可用时自动回退明文；读取时解密 |
| BUG-48 | 低 | **静态数据拼 innerHTML 未转义**（盒型名/合规清单项，本地数据无风险但防数据变更） | `renderer/app.js`：`t.name/t.desc`、`it.label/it.ref`、`p.label` 统一过 `escXml` |
| BUG-49 | 低 | **参考图未校验文件类型**（`accept="image/*"` 可绕过）+ innerHTML 拼接 | `renderer/app.js`：`f.type.startsWith('image/')` 校验 + 属性赋值代替拼接 |
| BUG-50 | 低 | **seed 输入 `.`/`e` 产生 NaN 传给 API** | `renderer/app.js`：`/^\d+$/` 校验，非法按空处理 |
| BUG-51 | 低 | **`gate.startsWith('已取消')` 死代码**（qcGate 从不返回该值） | `renderer/app.js`：清理，统一 `status err` |
| BUG-52 | 低 | **saveConfig/testApi/setActive 无 try/catch**（IPC 失败 unhandled rejection） | `renderer/app.js`：三处补 try/catch + 状态提示 |
| BUG-53 | 低 | **exportArmed 跨导出类型共享**（PNG 确认后 3 秒内 PDF/X 跳过确认） | `renderer/app.js`：按导出类型（png/pdfx）区分武装状态 |
| BUG-54 | 低 | **GS_LIB 推导依赖固定路径**（候选 2/3 布局会错） | `pdfx.js`：`gsLibDirs` 按实际 exe 反推 + 探测 share/ghostscript/<ver> |
| BUG-55 | 低 | **pdfx_def.ps ICC 路径未做 PostScript 转义**（用户名含括号/反斜杠会破坏模板） | `pdfx.js`：`escPs` 转义 `\ ( )` |
| BUG-56 | 低 | **resources/gs/pdfx_def.ps 残留开发机绝对路径**（未被引用却打进包） | 删除该文件 |
| BUG-57 | 低 | **config.example.json 与 DEFAULT_CONFIG 不一致**（缺视觉质检/接口字段） | 补齐全部字段 |
| BUG-58 | 低 | **CE 标志"最小 5mm"表述不准**（5mm 是 UKCA 要求，欧盟无官方法定尺寸） | `renderer/compliance.js`：改为「建议高度 ≥5mm、行业惯例」 |

---

## 一、功能类（4 项，已修复）

| # | 严重度 | 描述 | 触发方式 | 修复 |
|---|--------|------|----------|------|
| BUG-01 | 中 | **天地盖展开图面板重叠**：盒盖下折边（lidDown/lidDownFlap）与底围边（boxUp）重叠 20mm，刀模线交叉 | 盒型=天地盖，导出展开图 | `templates/boxes.js`：`baseY` 公式增加 `+ H`，使 boxUp 顶 = 盖下折边底 + gap，重叠清零 |
| BUG-02 | 中 | **双插盒展开图面板重叠**：背面（back）与顶部（top）重叠 20mm，同样产生交叉刀模线 | 盒型=双插盒，导出展开图 | `templates/boxes.js`：主体行 y 从 `H` 改为 `flap + H`，top 紧贴主体顶；leftFlap/rightFlap 同步对齐 |
| BUG-03 | 高 | **无图方案载入崩溃**：`loadScheme` 对 `images: []` 的方案执行 `images[0].dataUrl`，解引用 undefined 抛 TypeError | 导入"仅文本信息、无图片"的 .toybox.json 方案 | `renderer/app.js`：`state.currentImage = images.length ? images[0].dataUrl : null` |
| BUG-04 | 低 | **批量数量无上限防护**：`batchGenerate` 未 clamp，异常值可触发超量请求 | 渲染端被绕过/未来 UI 改动 | `renderer/app.js`：`Math.min(12, Math.max(1, Number(v) || 4))`；另提取共享函数 `clampBatchCount` 供测试与实现共用（防镜像漂移） |

## 二、安全类（9 项，已修复）

| # | 严重度 | 描述 | 触发方式 | 修复 |
|---|--------|------|----------|------|
| BUG-05 | 高 | **方案导入路径透传 → 任意文件读取 / NTLM 泄露**：`scheme:import` 把 `forcePath` 直传 `readImage`，攻击者可读任意本地文件、UNC 路径触发 NTLM 凭据泄露 | 导入构造 `forcePath: "C:\Windows\win.ini"` 或 `\\x.x.x.x\...` 的方案文件 | `main.js`：导入仅接受 `data:mime;base64,...` URL；非 dataURL → 空占位；新增 `isInsideImagesDir` 白名单（`path.resolve` 防 `..`/大小写/UNC）强制于 `file:readImage` 与 `scheme:export`；`forcePath` 仅 `process.env.SMOKE` 下生效 |
| BUG-06 | 中 | **方案列表 XSS**：`renderSchemes` 将方案 `boxType` 未经转义插入 innerHTML | 方案名/盒型含 `<img onerror=...>` | `renderer/app.js`：tName、prompt 均经 `escXml`（转义 `& < > "`） |
| BUG-07 | 中 | **质检报告 XSS**：`renderQc` 将质检消息 `i.msg` 未经转义插入 innerHTML | 本地文件名/路径含 HTML 字符 | `renderer/app.js`：`i.msg` 经 `escXml` |
| BUG-08 | 低 | **SMOKE 页面注入**：`SMOKE_LAST_PAGE` 用字符串拼接进 `executeJavaScript`，含引号/反斜杠会语法错误或注入 | SMOKE 环境 + 页面名含特殊字符 | `main.js`：改用 `JSON.stringify` 生成合法 JS 字面量 |
| BUG-09 | 中 | **forcePath 任意路径写**：pdfx 导出可用 forcePath 覆盖任意文件 | 渲染进程发起 `pdf:export` 带 forcePath | `pdfx.js`：forcePath 仅 `process.env.SMOKE` 下生效（三处统一门控） |
| BUG-10 | 中 | **readImage 无白名单**：任意路径读取（同 BUG-05 关联） | 同上 | `main.js`：`file:readImage` 强制 `isInsideImagesDir` |
| BUG-11 | 低 | **base64 导入无大小上限**：超大 dataURL 可耗尽磁盘/内存 | 导入 GB 级 base64 方案 | `main.js`：单图解码后 >15MB 丢弃 |
| BUG-12 | 低 | **import 非字符串字段 TypeError**：`images` 元素为对象等非字符串 truthy 值时 `d.match` 抛错 | 恶意/损坏方案文件 | `main.js`：`typeof d === 'string' && d.match(...)` 短路防护 |
| BUG-13 | 低 | **主进程 maxImages 无兜底 clamp**：渲染端被绕过可超量组图烧额度 | 渲染端篡改 IPC 参数 | `main.js`：`image:generate` 处 `Math.min(6, Math.max(1, Number(v) || 1))` |

## 三、测试工程类（3 项，已修复）

| # | 严重度 | 描述 | 触发方式 | 修复 |
|---|--------|------|----------|------|
| BUG-14 | 中 | **SMOKE 无硬断言**：原测试只打日志不失败，回归无法红牌 | 任何断言漂移 | `main.js`：新增 29 个 `sa(name, cond)` 硬断言，失败收集后 `app.exit(1)`；负向验证：故意改错断言 → exit 1 实测 |
| BUG-15 | 中 | **测试镜像漂移**：测试复制实现常量，改实现忘了改测试 | 常量变更 | 提取共享 `clampBatchCount()` 挂到 `window.__app`，测试直接调用真实实现 |
| BUG-16 | 低 | **浮点精确比较**：pdfx 导出尺寸 `trimInset === 8.5039` 对浮点不稳定 | 平台/版本差异 | 改 `Math.abs(v - 8.5039) < 0.005` 容差断言 |

---

## 排查确认无问题的项（非 bug）

- `batch-count` 批量数量：UI 为 `<select>`（仅 2/4/6），用户无法输入越界值（BUG-04 属加固而非实际可触发）
- 坏校验位条码：JsBarcode 对非法 EAN 抛错被捕获 → 不绘制，行为正确
- 负数/非数字盒尺寸：`getSize` fallback 到 20（最小约束），行为正确
- 空提示词生成：`generateGuard` 拦截并提示，不崩溃
- 3D mockup：三种盒型（天地盖/开窗盒/双插盒）均正常渲染，无多余框/变形

## 复现与验证

```powershell
# 全量回归（64 硬断言）
$env:SMOKE='1'; node_modules\.bin\electron.cmd .
# 期望：exit 0、SMOKE_ASSERT_OK 64/64、无 ASSERT_FAIL、无 JS 错误
```

安全审查结论：`security_review` — **no security issues found**；`review` — **ship as-is**。
二轮审查（2026-08-08）修复的 26 项见文首「二轮审查修复」节。
