// anomaly_engine.js - 异常单价识别引擎
// 基于基准价格库,对报价单逐项进行价格合理性校验

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载基准价格库
let benchmarkCache = null;
function loadBenchmark() {
  if (!benchmarkCache) {
    const data = readFileSync(join(__dirname, 'benchmark.json'), 'utf-8');
    benchmarkCache = JSON.parse(data);
  }
  return benchmarkCache;
}

/**
 * 构建关键词→基准条目索引(加速匹配)
 */
function buildKeywordIndex(benchmark) {
  const index = new Map();
  for (const [category, items] of Object.entries(benchmark.items)) {
    for (const [itemName, spec] of Object.entries(items)) {
      for (const kw of spec.keywords) {
        if (!index.has(kw)) index.set(kw, []);
        index.get(kw).push({ category, name: itemName, spec });
      }
    }
  }
  return index;
}

/**
 * 匹配报价条目到基准条目
 * @param {string} itemName - 报价条目名称
 * @param {Map} keywordIndex - 关键词索引
 * @returns {{category, name, spec} | null}
 */
function matchBenchmarkItem(itemName, keywordIndex) {
  const lower = itemName.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const [kw, entries] of keywordIndex) {
    if (lower.includes(kw)) {
      const score = kw.length; // 越长越精确
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entries[0]; // 取第一个匹配
      }
    }
  }
  return bestMatch;
}

/**
 * 计算调整后的基准价格区间
 * @param {object} spec - 基准规格
 * @param {string} city - 城市
 * @param {string} tier - 档次
 * @param {object} benchmark - 基准数据
 * @returns {{min, max, median}}
 */
function adjustPriceRange(spec, city, tier, benchmark) {
  const cityCoeff = benchmark.city_coefficients[city] || 1.0;
  const tierMult = benchmark.tier_multipliers[tier] || 1.0;

  let min = spec.min * cityCoeff * tierMult;
  let max = spec.max * cityCoeff * tierMult;
  let median = spec.median * cityCoeff * tierMult;

  // 百分比类项目不乘城市系数
  if (spec.is_percentage) {
    min = spec.min;
    max = spec.max;
    median = spec.median;
  }

  return {
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    median: Math.round(median * 100) / 100,
  };
}

/**
 * 判定风险等级
 * @param {number} deviation - 偏差百分比
 * @returns {{level, label, color}}
 */
function riskLevel(deviation) {
  const abs = Math.abs(deviation);
  if (abs <= 10) return { level: 'normal', label: '正常', color: 'green' };
  if (abs <= 20) return { level: 'low', label: '轻微偏离', color: 'yellow' };
  if (abs <= 30) return { level: 'medium', label: '中度偏离', color: 'orange' };
  return { level: 'high', label: '严重偏离', color: 'red' };
}

/**
 * 核心: 审核单个报价条目
 * @param {object} item - 报价条目 {name, unit_price, unit, quantity, total}
 * @param {string} city - 城市
 * @param {string} tier - 档次
 * @param {Map} keywordIndex - 关键词索引
 * @param {object} benchmark - 基准数据
 * @returns {object} 审核结果
 */
function auditItem(item, city, tier, keywordIndex, benchmark) {
  const matched = matchBenchmarkItem(item.name, keywordIndex);
  if (!matched) {
    return {
      item: item.name,
      status: 'unknown',
      message: `未找到「${item.name}」的基准价格,无法自动审核`,
      risk: { level: 'unknown', label: '待人工审核', color: 'gray' },
    };
  }

  const range = adjustPriceRange(matched.spec, city, tier, benchmark);
  const unitPrice = item.unit_price;

  let deviation, direction, message;
  if (unitPrice < range.min) {
    deviation = ((range.min - unitPrice) / range.min * 100);
    direction = 'low';
    message = `报价 ${unitPrice}${matched.spec.unit} 低于基准下限 ${range.min}${matched.spec.unit} (${deviation.toFixed(1)}%)`;
    if (deviation > 30) {
      message += ' ⚠️ 严重偏低,警惕低开高走/偷工减料/后期增项';
    } else if (deviation > 15) {
      message += ' ⚡ 偏低,需确认是否包含完整工序';
    }
  } else if (unitPrice > range.max) {
    deviation = ((unitPrice - range.max) / range.max * 100);
    direction = 'high';
    message = `报价 ${unitPrice}${matched.spec.unit} 高于基准上限 ${range.max}${matched.spec.unit} (${deviation.toFixed(1)}%)`;
    if (deviation > 30) {
      message += ' ⚠️ 严重偏高,建议对比2-3家报价';
    } else if (deviation > 15) {
      message += '  偏高,确认是否含品牌溢价或特殊工艺';
    }
  } else {
    deviation = 0;
    direction = 'normal';
    message = `报价 ${unitPrice}${matched.spec.unit} 在合理区间 [${range.min}-${range.max}]${matched.spec.unit} 内`;
  }

  const risk = riskLevel(deviation);

  return {
    item: item.name,
    category: matched.category,
    benchmark_name: matched.name,
    unit_price: unitPrice,
    unit: matched.spec.unit,
    expected_range: range,
    deviation: Math.round(deviation * 10) / 10,
    direction,
    status: direction === 'normal' ? 'pass' : (direction === 'low' ? 'warning_low' : 'warning_high'),
    message,
    risk,
    quantity: item.quantity,
    total: item.total,
  };
}

/**
 * 检查常见漏项
 * @param {Array} items - 已解析的报价条目
 * @returns {Array<{name, category, risk}>}
 */
function checkMissingItems(items) {
  const benchmark = loadBenchmark();
  const itemNames = items.map(i => i.name.toLowerCase());
  const missing = [];

  // 必查关键项
  const criticalItems = [
    { name: '防水工程', category: '水电工程', keywords: ['防水'] },
    { name: '强弱电布线', category: '水电工程', keywords: ['布线', '强弱电', '电路'] },
    { name: '水管铺设', category: '水电工程', keywords: ['水管', '水路', '给排水'] },
    { name: '地面找平', category: '瓦工工程', keywords: ['找平'] },
    { name: '墙面基层处理', category: '油漆工程', keywords: ['基层', '腻子'] },
    { name: '垃圾清运', category: '拆除工程', keywords: ['垃圾', '清运'] },
  ];

  for (const critical of criticalItems) {
    const found = itemNames.some(n =>
      critical.keywords.some(kw => n.includes(kw))
    );
    if (!found) {
      missing.push({
        name: critical.name,
        category: critical.category,
        risk: { level: 'medium', label: '可能漏项', color: 'orange' },
        message: `报价单中未发现「${critical.name}」,请确认是否遗漏或已包含在其他项目中`,
      });
    }
  }

  return missing;
}

/**
 * 完整审核流程
 * @param {string|Array} quoteInput - 报价单文本或JSON数组
 * @param {object} options - {city, tier, area}
 * @returns {object} 审核报告
 */
export function auditQuote(quoteInput, options = {}) {
  const { city = '沈阳', tier = '中档', area = null } = options;
  const benchmark = loadBenchmark();
  const keywordIndex = buildKeywordIndex(benchmark);

  // 解析报价条目
  let items;
  if (typeof quoteInput === 'string') {
    // 动态导入解析器
    const { parseQuoteText } = require('./quote_parser.js');
    items = parseQuoteText(quoteInput);
  } else {
    items = Array.isArray(quoteInput) ? quoteInput : [];
  }

  if (items.length === 0) {
    return {
      success: false,
      error: '未能从报价单中提取到有效条目,请检查输入格式',
      hint: '支持格式: "项目名 单价元/单位 [×数量] [=总价]" 或 JSON数组',
    };
  }

  // 逐项审核
  const results = items.map(item => auditItem(item, city, tier, keywordIndex, benchmark));

  // 漏项检查
  const missing = checkMissingItems(items);

  // 统计
  const stats = {
    total_items: results.length,
    pass: results.filter(r => r.status === 'pass').length,
    warning_high: results.filter(r => r.status === 'warning_high').length,
    warning_low: results.filter(r => r.status === 'warning_low').length,
    unknown: results.filter(r => r.status === 'unknown').length,
    missing_items: missing.length,
  };

  // 总体评价
  let overall;
  if (stats.warning_high + stats.warning_low === 0) {
    overall = { level: 'good', label: '报价合理', color: 'green' };
  } else if (stats.warning_high + stats.warning_low <= 2) {
    overall = { level: 'fair', label: '基本合理,有少量偏离', color: 'yellow' };
  } else {
    overall = { level: 'poor', label: '存在多处异常,建议重新比价', color: 'red' };
  }

  return {
    success: true,
    city, tier, area,
    input_items: items.length,
    stats,
    overall,
    results,
    missing_items: missing,
    generated_at: new Date().toISOString(),
  };
}

/**
 * 格式化审核报告为可读文本
 * @param {object} report - auditQuote() 返回的报告
 * @returns {string}
 */
export function formatAuditReport(report) {
  if (!report.success) {
    return `审核失败: ${report.error}\n${report.hint || ''}`;
  }

  const lines = [];
  lines.push(`=== 装修报价审核报告 ===`);
  lines.push(`城市: ${report.city} | 档次: ${report.tier} | 审核条目: ${report.stats.total_items}`);
  lines.push(`总体评价: ${report.overall.label}`);
  lines.push('');

  // 异常项
  const warnings = report.results.filter(r => r.status !== 'pass' && r.status !== 'unknown');
  if (warnings.length > 0) {
    lines.push(`--- 异常项 (${warnings.length}项) ---`);
    for (const w of warnings) {
      lines.push(`  [${w.risk.label}] ${w.item}: ${w.message}`);
    }
    lines.push('');
  }

  // 正常项
  const passed = report.results.filter(r => r.status === 'pass');
  if (passed.length > 0) {
    lines.push(`--- 正常项 (${passed.length}项) ---`);
    for (const p of passed) {
      lines.push(`  [✓] ${p.item}: ${p.message}`);
    }
    lines.push('');
  }

  // 待审核项
  const unknowns = report.results.filter(r => r.status === 'unknown');
  if (unknowns.length > 0) {
    lines.push(`--- 待人工审核 (${unknowns.length}项) ---`);
    for (const u of unknowns) {
      lines.push(`  [?] ${u.message}`);
    }
    lines.push('');
  }

  // 漏项
  if (report.missing_items.length > 0) {
    lines.push(`--- 可能漏项 (${report.missing_items.length}项) ---`);
    for (const m of report.missing_items) {
      lines.push(`  [!] ${m.message}`);
    }
    lines.push('');
  }

  // 建议
  lines.push('--- 建议 ---');
  if (report.stats.warning_high > 0) {
    lines.push(`  · ${report.stats.warning_high}项报价偏高,建议对比2-3家装修公司报价`);
  }
  if (report.stats.warning_low > 0) {
    lines.push(`  · ${report.stats.warning_low}项报价偏低,需警惕低开高走或偷工减料风险`);
  }
  if (report.missing_items.length > 0) {
    lines.push(`  · 发现${report.missing_items.length}项可能漏项,请向装修公司确认`);
  }
  if (report.overall.level === 'good') {
    lines.push('  · 整体报价在合理范围内,建议确认材料品牌和工艺标准后签约');
  }

  return lines.join('\n');
}
