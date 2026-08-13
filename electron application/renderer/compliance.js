/**
 * 合规检查清单（数据驱动）——依据 2026-08 联网调研结果整理
 * 来源摘要：
 *  中国：市场监管总局 2023 第36号公告（3C 目录）；GB 6675-2025（2026-11-01 实施）；产品质量法 27 条
 *  欧盟：玩具安全指令 2009/48/EC + (EU) 2025/2509；CE 标志最小 5mm；TSD 附件 V 警告语原样照抄
 *  美国：CPSIA / ASTM F963-23；CPSC Tracking Label（包装必印）；16 CFR 1500.19/1500.20；UPC（GS1 US）
 *  印刷：出血 3mm（英制 1/8in）、刀线出血 ~6mm、安全边距、300DPI、CMYK、刀模线单独图层
 * 注意：本清单供设计期自查，不构成法律意见；出口前请与检测机构/客户最终确认。
 */
(function (root) {
  root.ComplianceData = {
    markets: {
      cn: {
        id: 'cn',
        name: '中国内销',
        items: [
          { label: '3C 强制认证标志（列入 CCC 目录的玩具必施）', ref: '市场监管总局 2023 第36号公告' },
          { label: '产品名称、生产厂厂名和厂址（中文）', ref: '产品质量法 第27条' },
          { label: '产品质量检验合格证明', ref: '产品质量法 第27条' },
          { label: '适用年龄标注（年龄组）', ref: 'GB 6675 / 市场监管重点' },
          { label: '警示标志或中文警示说明（小零件/危险情形）', ref: '产品质量法 第27/28条' },
          { label: '规格、等级、主要成分（按需）', ref: '产品质量法 第27条' },
          { label: '执行标准：GB 6675（2026-11-01 起为新版 GB 6675-2025）', ref: '国标全文公开系统' },
          { label: '品名 / 货号 / 材质 / 条形码（企业惯例）', ref: '行业惯例' },
        ],
      },
      eu: {
        id: 'eu',
        name: '欧盟',
        items: [
          { label: 'CE 标志（两字母等高、建议高度 ≥5mm、不可磨灭；欧盟无官方法定最小尺寸，5mm 为行业惯例）', ref: 'YourEurope CE marking' },
          { label: '制造商名称 + 可联系地址（进口商名称地址）', ref: 'TSD 2009/48/EC' },
          { label: '可追溯标识（型号/批次/序列号）', ref: 'TSD 2009/48/EC' },
          { label: '警告语以 "Warning/Warnings" 开头，附件 V 文字原样照抄不得改动', ref: 'TSD 附件 V Part B' },
          { label: '0-3 岁窒息警告（"Not suitable for children under 36 months..."）', ref: 'TSD 附件 V' },
          { label: '警告语使用目的国语言（成员国语言要求不同）', ref: 'TSD 附件 V' },
          { label: 'EN 71 系列符合性（EN 71-1/2/3 等）', ref: '(EU) 2023/740' },
          { label: '2030 起需数字产品护照（DPP）数据载体', ref: '欧盟玩具安全法规 (EU) 2025/2509' },
        ],
      },
      us: {
        id: 'us',
        name: '美国',
        items: [
          { label: 'ASTM F963 / CPSIA 符合性（12 岁及以下）', ref: '16 CFR part 1250' },
          { label: 'CPC 儿童产品证书（随货/测试）', ref: 'CPSC CPC FAQ' },
          { label: 'Tracking Label：制造商、生产地点和日期、批次号、工厂地址', ref: 'CPSC Tracking Label' },
          { label: '窒息警告标签（小零件/气球/小球/弹珠）', ref: '16 CFR 1500.19/1500.20' },
          { label: 'UPC 条码（GS1 US 发行；不同颜色/规格须不同条码）', ref: 'GS1 US' },
          { label: '年龄标注（3 岁以下小零件禁令 16 CFR 1501）', ref: 'CPSC FAQ' },
        ],
      },
    },
    printing: [
      { label: '出血位 3mm（英制 1/8in ≈ 3.175mm）', ref: 'Bleed (printing) 惯例' },
      { label: '刀模线出血约 6mm（模切公差更大）', ref: 'Print Production Handbook' },
      { label: '安全边距：内容保留在裁切线内，出血区只放底色/延伸图文', ref: '印刷惯例' },
      { label: '图片 ≥300DPI；文字/线稿用矢量', ref: '印刷惯例' },
      { label: 'CMYK 四色；品牌专色单独通道；刀模线单独图层/专色', ref: '印刷惯例' },
    ],
  };
})(typeof self !== 'undefined' ? self : this);
