'use strict';
/* warning-templates.js - 多语言警告语模板（玩具安全标准文案）
 * 数据源：欧盟 TSD 2009/48/EC 附件 V + 实物贴纸（英/西/阿三语窒息警告）
 * 组合键含义：如 'choking-zh-en' = 模板 choking × 语言 [zh, en] */
const WARNING_TEMPLATES = {
  choking: {
    label: '窒息危险（小零件）',
    en: 'WARNING: CHOKING HAZARD - Small parts. Not for children under 3 years.',
    zh: '警告：窒息危险 - 小零件。不适合 3 岁以下儿童。',
    es: 'ADVERTENCIA: PELIGRO DE ASFIXIA - Piezas pequeñas. No recomendado para niños menores de 3 años.',
    ar: 'تحذير: خطر الاختناق - أجزاء صغيرة غير مناسبة للأطفال تحت 3 سنوات',
    fr: "ATTENTION: RISQUE D'ÉTOUFFEMENT - Petites pièces. Ne convient pas aux enfants de moins de 3 ans.",
    de: 'ACHTUNG: ERSTICKUNGSGEFAHR - Kleinteile. Nicht für Kinder unter 3 Jahren geeignet.',
  },
  under36: {
    label: '36 个月以下不适用',
    en: 'Not suitable for children under 36 months.',
    zh: '不适合 36 个月以下儿童使用。',
    es: 'No recomendado para niños menores de 36 meses.',
    ar: 'غير مناسب للأطفال دون 36 شهرًا',
    fr: 'Ne convient pas aux enfants de moins de 36 mois.',
    de: 'Nicht für Kinder unter 36 Monaten geeignet.',
  },
  supervision: {
    label: '成人监护',
    en: 'WARNING! To be used under the direct supervision of an adult.',
    zh: '警告！请在成人直接监护下使用。',
    es: '¡ADVERTENCIA! Debe utilizarse bajo la supervisión directa de un adulto.',
    ar: 'تحذير! يجب استخدامه تحت إشراف مباشر من شخص بالغ',
    fr: "ATTENTION! À utiliser sous la surveillance directe d'un adulte.",
    de: 'ACHTUNG! Nur unter direkter Aufsicht von Erwachsenen verwenden.',
  },
};

// 预设组合：{ id, label, tpl, langs }
const WARNING_COMBOS = [
  { id: 'choking-zh-en', label: '窒息警告（中英）', tpl: 'choking', langs: ['zh', 'en'] },
  { id: 'choking-en-es-ar', label: '窒息警告（英西阿）', tpl: 'choking', langs: ['en', 'es', 'ar'] },
  { id: 'choking-5', label: '窒息警告（中英西法德）', tpl: 'choking', langs: ['zh', 'en', 'es', 'fr', 'de'] },
  { id: 'under36-zh-en', label: '36 个月以下（中英）', tpl: 'under36', langs: ['zh', 'en'] },
  { id: 'supervision-zh-en', label: '成人监护（中英）', tpl: 'supervision', langs: ['zh', 'en'] },
];

/** 生成多语言警告文本（换行分隔各语言） */
function composeWarning(comboId) {
  const combo = WARNING_COMBOS.find((c) => c.id === comboId);
  if (!combo) return '';
  const tpl = WARNING_TEMPLATES[combo.tpl];
  if (!tpl) return '';
  return combo.langs.map((l) => tpl[l] || '').filter(Boolean).join('\n');
}

if (typeof window !== 'undefined') {
  window.WARNING_TEMPLATES = WARNING_TEMPLATES;
  window.WARNING_COMBOS = WARNING_COMBOS;
  window.composeWarning = composeWarning;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WARNING_TEMPLATES, WARNING_COMBOS, composeWarning };
}