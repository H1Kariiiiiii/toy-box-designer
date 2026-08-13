# Photoshop 插件版设计文档（ToyBox Designer PS Plugin）

> 状态：设计稿 v1（待确认）｜平台：CEP（PS 2018~2020）｜与独立版并存
> 定位：**带 AI 的玩具包装设计辅助插件**——在 Photoshop 内直接完成 AI 生图、展开图刀模、合规排版、条码、3D 预览，最终由 PS 导出印刷文件。

---

## 1. 背景与目标

### 1.1 为什么做插件
- 独立版（Electron）的短板是**版面自由度**：只有"单张 AI 主视觉 + 固定合规块 + 条码"，无法实现样品房实物的多区块版面（卖点文字区、系列产品网格、品牌条带、装饰条纹）。
- 设计师的日常工作流在 Photoshop：插件把 AI 辅助能力**嵌入 PS**，版面排版交给 PS 本身（最强的版面工具），插件专注自动化与合规。

### 1.2 目标用户
公司设计部设计师（PS 2018~2020，中文环境，Windows）。

### 1.3 与独立版关系
- **并存**：独立版继续做全流程（一键出稿、PDF/X 导出、批量）；插件版做**设计辅助**（AI 入文档、刀模、合规、3D）。
- 核心逻辑（模板/合规/质检/条码/AI）未来抽为公共模块，两版共用，避免双份维护。

---

## 2. 平台选型：CEP

| 决策项 | 结论 | 依据 |
|---|---|---|
| 平台 | **CEP 8/9**（兼容 PS 2018/2019/2020） | 公司 PS 2018~2020；官方映射：PS 2018=CEP 8、PS 2019/2020=CEP 9（UXP 仅支持 PS 2021+） |
| 渲染内核 | Chromium 57（CEP 8）/ 61（CEP 9） | **支持 WebGL** → 3D 预览可保留 |
| 后端 | CEP 内置 Node（CEP 8=7.7.4 / CEP 9=8.6.0） | 可做配置/缓存/AI 代理（网络请求走 Node，避开面板 CORS） |
| 打包 | ZXP（自签名/未签名本地安装） | 开发期可用开发者模式免签名调试 |

**CEP 能力注意**：
- Node（CEP 8=7.7.4 / CEP 9=8.6.0）：`async/await` ✅、`fetch` ❌（用 `http/https` 模块或打包 `node-fetch@2`）、可选链 `?.` / 空合并 `??` ❌（现有代码需检查转译）
- 面板 JS 的 `XMLHttpRequest` 有跨域限制 → **所有外部请求统一走 CEP Node 侧**
- 面板无 `require` → 通过 `window.__adobe_cep__` + Node 侧 `evalScript` 桥接

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────┐
│ Photoshop（PS 2018~2020）                            │
│  ┌───────────────────────────────────────────────┐  │
│  │ CEP 面板（HTML/CSS/JS，Chromium 内核）          │  │
│  │  ├ 页签：AI 生成｜模板｜合规｜3D｜设置            │  │
│  │  ├ js/templates.js  compliance.js  qc.js       │  │
│  │  ├ js/barcode.js（JsBarcode）                  │  │
│  │  ├ js/mockup3d.js（three.js r150 本地化）      │  │
│  │  └ js/psbridge.js（ExtendScript 调用封装）      │  │
│  └───────────────┬───────────────────────────────┘  │
│                  │ evalScript / CEP 消息             │
│  ┌───────────────▼───────────────────────────────┐  │
│  │ CEP Node 层（node/main.js）                    │  │
│  │  配置读写 · 生成历史 · AI 代理(生图/识图)       │  │
│  │  缓存管理（≈ 独立版 main.js 对应部分）           │  │
│  └───────────────┬───────────────────────────────┘  │
│                  │ evalScript("host.jsx(...)")      │
│  ┌───────────────▼───────────────────────────────┐  │
│  │ ExtendScript 层（jsx/）                        │  │
│  │  新建展开图文档 · 刀模线路径 · 图片/条码/合规入层 │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 数据流（AI 生图 → 入文档）
1. 面板填写提示词/参数 → `psbridge` → CEP Node → 小米 MiMo API → 图片字节回传面板
2. 面板显示缩略图（可重新生成/换种子）
3. 点「放入文档」→ `host.jsx(placeImage)` → 新建图层组，按 mm 换算像素放置到 front 面板区域
4. 合规块/条码同理入层；刀模线作为**路径/形状图层**写入

### 关键换算
- 文档分辨率 300 dpi：`1mm = 300/25.4 ≈ 11.811 px`
- 展开图坐标系：模板 `templates/boxes.js` 的 mm 坐标 → PS 像素坐标（文档原点 = 画布左上，y 轴向下，模板 y 轴向下一致）

---

## 4. 功能清单

### MVP（v0.1）
| # | 功能 | 说明 | 复用来源 |
|---|---|---|---|
| F1 | **AI 主视觉生成** | 提示词/尺寸/风格/种子/批量；缩略图列表；一键入文档（front 面板区域） | main.js generateImage + app.js 面板逻辑 |
| F2 | **展开图刀模** | 三种盒型（天地盖/开窗/双插）展开图，含刀模线/折线/出血，作为路径+形状图层写入 | templates/boxes.js + buildSvg 路径逻辑 |
| F3 | **合规信息块** | 目标市场/标志/CE/警告语自动排版入层（文字图层组） | compliance.js |
| F4 | **条码** | 输入货号 → JsBarcode 生成 → 作为图层放置（条码区留白规则） | JsBarcode + app.js 条码逻辑 |
| F5 | **3D 预览** | 面板内嵌 canvas，三种盒型实时 3D（可旋转/换图/截图入文档） | mockup.js（three.js 本地化） |
| F6 | **设置** | API key（小米 MiMo）、默认尺寸/DPI、模型选择、历史清理 | main.js config 逻辑 |

### v0.2（增强）
| # | 功能 | 说明 |
|---|---|---|
| F7 | **识图反推提示词** | 把 PS 当前画布/选中图层发给视觉模型 → 生成提示词草稿回填 |
| F8 | **质检** | 对 PS 文档做条码留白/合规块溢出/出血检查，结果面板列出问题项 |
| F9 | **系列网格** | 多图网格（编号 + 说明文字）一键生成入层 |
| F10 | 历史方案库 | 生成记录/参数存档、重新入文档 |

---

## 5. 目录结构与文件清单

```
ps-plugin/
├── CSXS/
│   └── manifest.xml            # CEP 清单：面板注册、权限（network）、Node 入口
├── index.html                  # 面板 UI（页签布局）
├── css/panel.css
├── js/
│   ├── panel.js                # 面板主逻辑（页签切换、表单、事件）
│   ├── ai.js                   # AI 生成面板逻辑（搬 app.js 生成段）
│   ├── vision.js               # 识图反推（v0.2）
│   ├── templates.js            # 复制自 templates/boxes.js（三盒型）
│   ├── compliance.js           # 复制自 renderer/compliance.js
│   ├── qc.js                   # 复制自 renderer/qc.js（v0.2）
│   ├── barcode.js              # JsBarcode（打包进 ZXP）
│   ├── mockup3d.js             # 3D：mockup.js 适配面板（three.js 本地化）
│   ├── psbridge.js             # evalScript 封装 + Promise 化
│   └── util.js                 # mm↔px、坐标转换、防抖
├── node/
│   ├── main.js                 # CEP Node：配置/缓存/AI 代理/历史（搬 main.js 对应部分）
│   ├── config.json.template    # key 配置模板
│   └── node_modules/           # node-fetch@2 等（打包进 ZXP）
├── jsx/
│   ├── host.jsx                # ExtendScript 宿主：命令分发、错误回传
│   ├── createDoc.jsx           # 新建展开图文档（尺寸/DPI/背景）
│   ├── drawDieLine.jsx         # 刀模线路径 + 出血线
│   ├── placeImage.jsx          # 图片入图层（按 mm 定位/缩放）
│   ├── placeText.jsx           # 合规文字图层组
│   └── placeBarcode.jsx        # 条码位图入层
├── lib/
│   ├── three.min.js            # r150（CEP Chromium 兼容）
│   └── OrbitControls.js
├── build/
│   ├── build.zxp.ps1           # 打包脚本（ZXPSignCmd 自签）
│   └── README-安装.md
└── README.md
```

---

## 6. 与 PS 交互设计（ExtendScript 接口草案）

所有命令经 `host.jsx` 分发，参数 JSON 字符串传入，结果/错误 JSON 回传。

```
createDoc({boxType, size:{w,d,h}, dpi:300, bleed:3, background:'#ffffff'})
  → 新建文档：展开图总宽高 × dpi 换算；名称「盒型_尺寸_日期」

drawDieLine({docId, panels:[{kind,x,y,w,h,fold:[]}], bleed})   // 数据来自 templates.js
  → 路径图层：刀模线（实线）+ 折线（虚线）+ 出血框（外扩 3mm）

placeImage({docId, dataUrl, x, y, w, h, group:'主视觉'})
  → 新建图层组（无则建）→ 位图图层，按 mm 定位缩放

placeText({docId, items:[{text,sizePt,x,y,align,font}], group:'合规信息'})
  → 文字图层组（合规块逐行）

placeBarcode({docId, value, format, x, y, hMm, group:'条码'})
  → JsBarcode 生成 PNG → 位图入层（含下方数字文字）

renderMockupShot({boxType, size, imageDataUrl}) → dataUrl   // 3D 面板内完成
  → 3D 截图入文档（可选项）
```

**图层组织**（PS 图层结构）：
```
展开图文档
├─ 📁 刀模线（路径/形状，锁定）
├─ 📁 合规信息（文字图层组）
├─ 📁 条码
├─ 📁 主视觉（AI 生成图）
└─ 背景（白）
```

---

## 7. UI 设计（面板草图）

宽 360px 面板，五个页签：

| 页签 | 内容 |
|---|---|
| **AI 生成** | 提示词多行输入（可引用识图反推）｜尺寸选择（盒型面板 W×D）｜风格下拉｜种子/批量｜生成按钮｜缩略图网格（点选 → 放入文档/换种子） |
| **模板** | 盒型三选一（天地盖/开窗/双插）｜尺寸输入｜「新建展开图文档」「画刀模线」按钮 |
| **合规** | 目标市场/语言/标志/警告语输入（复用独立版表单）｜「排入文档」 |
| **3D** | canvas 预览 + 旋转/缩放/换图 + 截图入文档 |
| **设置** | API key、模型、默认 DPI、历史管理、关于 |

---

## 8. 配置与数据

- 配置：`%APPDATA%\ToyBoxDesignerPlugin\config.json`（key 等，与独立版 `config.json` 可共用/迁移）
- 生成历史：`%APPDATA%\ToyBoxDesignerPlugin\history\`（缩略图 + 参数 json，上限 200 条）
- 缓存：AI 图临时缓存（独立版 cacheDir 逻辑移植）
- key 来源：小米 MiMo（OpenAI 兼容，`https://api.xiaomimimo.com/v1`），与独立版同一 key 可复用

---

## 9. 打包与安装

- **开发期**：`install-dev.ps1` 一键部署（复制到 `%APPDATA%\Adobe\CEP\extensions\com.toybox.psplugin` + 注册表 `HKCU\Software\Adobe\CSXS.8/9` 写 `PlayerDebugMode=1`，PS 2018=CSXS.8、2019/2020=CSXS.9）→ 免签名加载
- **发布期**：ZXPSignCmd 自签名 → `.zxp` → PS「帮助→扩展功能」安装；或直接分发解压目录 + 一键注册脚本
- 安装器：后续可做 bat 一键安装（复制目录 + 写注册表）

---

## 10. 里程碑（AI 优先）

| 里程碑 | 内容 | 预计工作量 |
|---|---|---|
| M1 | CEP 面板骨架 + 开发者模式跑通 + host.jsx 桥（新建文档/创建图层验证） | 1 天 |
| M2 | **AI 生图移植**：CEP Node 代理 → 面板缩略图 → 入文档（F1） | 2~3 天 |
| M3 | 模板/合规/条码移植（F2/F3/F4）+ 图层组织 | 2~3 天 |
| M4 | 3D 预览嵌入（F5） | 1~2 天 |
| M5 | ZXP 打包 + PS 2018 实机安装测试 + 中文兼容 | 1 天 |
| M6 | 设置页（F6）+ 收尾（历史、错误处理） | 1 天 |

合计约 **1.5~2 周**；M2 完成后即可先给设计师试用 AI 入文档主流程。

---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| Node 8 无 `fetch`/可选链 | Node 侧用 `http/https` + `node-fetch@2`；JS 侧代码过一遍兼容性检查（现有代码少量用 `?.`，需替换） |
| CEP 面板 XHR 跨域 | 所有外网请求走 CEP Node |
| three.js 新版本不兼容 Chromium 57/61 | 锁定 r150 及以下；3D 为辅助功能，降级为 2D 折叠示意兜底 |
| CEP 是 Adobe 旧平台 | PS 2018~2020 是其稳定主场；预留未来 UXP 迁移（核心逻辑已抽纯 JS，UI 壳重写） |
| ZXP 签名证书 | 自签名即可本地安装；公司内网分发用目录 + 注册表脚本 |
| 中文路径/中文文档名 | ExtendScript 字符串编码处理（utf8/GBK 边界），实机测试覆盖 |
| 与独立版逻辑漂移 | 核心模块复制后同步维护；后续抽公共包 |

---

## 12. 验收标准

- M1：PS 2018 打开面板；「新建展开图文档」能建出 300dpi 正确尺寸文档；能创建图层组
- M2：填提示词 → 生成 → 缩略图 → 一键入文档（尺寸/位置正确）
- M3：刀模线/合规块/条码图层生成正确，mm 与像素换算无偏差
- M4：3D 预览可旋转、换图、截图入文档
- M5：`.zxp` 安装成功，功能全通，中文无乱码
- 全流程：新建文档 → AI 主视觉入 front → 合规/条码入层 → 3D 确认 → PS 导出 PDF/X → 印刷厂可生产
