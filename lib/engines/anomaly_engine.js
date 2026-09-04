/**
 * 异常单价识别引擎 - 领域逻辑
 *
 * 依赖共享模块: zhishe-common/lib/benchmark.js + risk.js
 * 依赖本地模块: quote_parser.js (报价单解析)
 * 本文件仅包含报价审核特有的审核/漏项/报告逻辑
 */

import { loadBenchmark, buildKeywordIndex, matchBenchmarkItem } from '../../../zhishe-common/lib/benchmark.js';
import { riskLevel } from '../../../zhishe-common/lib/risk.js';
import { parseQuoteText } from '../quote_parser.js';

export { loadBenchmark, buildKeywordIndex, matchBenchmarkItem, riskLevel };

/**
 * 计算调整后的基准价格区间
 */
export function adjustPriceRange(spec, city, tier, benchmark) {
    const cityCoeff = benchmark.city_coefficients[city] || 1.0;
    const tierMult = benchmark.tier_multipliers[tier] || 1.0;

    let min = spec.min * cityCoeff * tierMult;
    let max = spec.max * cityCoeff * tierMult;
    let median = spec.median * cityCoeff * tierMult;

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
 * 核心: 审核单个报价条目
 */
export function auditItem(item, city, tier, keywordIndex, benchmark) {
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

    // 0904 提取稳定性配套: 单位错配守卫——报价单位与基准单位不同纲时不做数值比价
    // (实测: 瓷砖11.8元/片vs基准元/㎡、门套口165元/米vs基准元/樘、乳胶漆520元/桶vs元/㎡均被误判warning)
    const UNIT_NORM = { '㎡': '㎡', 'm²': '㎡', '平米': '㎡', '平方米': '㎡', '平': '㎡', 'm': 'm', '米': 'm', '延米': 'm' };
    const itemUnitRaw = String(item.unit || '').trim().replace(/^元\//, '');
    // 基准unit带「元/」前缀(如元/延米), 条目unit不带(延米)——剥前缀后再比纲, 否则全纲误判(0904实踩)
    const specUnitRaw = String(matched.spec.unit || '').trim().replace(/^元\//, '');
    const itemUnitN = UNIT_NORM[itemUnitRaw] || itemUnitRaw;
    const specUnitN = UNIT_NORM[specUnitRaw] || specUnitRaw;
    // v0.5.0 短板②配套: 结构化OCR直通条目可能缺单位/缺单价——不猜、不比,判unknown人工核对
    // (缺单价若不拦截会掉进下方比较链的else分支变成假pass;文本路径两字段恒在,零回归)
    if (!itemUnitRaw || unitPrice == null) {
        return {
            item: item.name,
            category: matched.category,
            benchmark_name: matched.name,
            unit_price: unitPrice,
            unit: item.unit,
            expected_range: range,
            status: 'unknown',
            message: !itemUnitRaw
                ? '报价条目未识别到计价单位,无法自动比价,请人工核对'
                : '报价条目缺少单价数字,无法自动比价,请人工核对',
            risk: { level: 'unknown', label: !itemUnitRaw ? '单位缺失' : '单价缺失', color: 'gray' },
            quantity: item.quantity,
            total: item.total,
        };
    }
    if (item.unit && itemUnitN !== specUnitN) {
        return {
            item: item.name,
            category: matched.category,
            benchmark_name: matched.name,
            unit_price: unitPrice,
            unit: item.unit,
            expected_range: range,
            status: 'unknown',
            message: `报价按「${item.unit}」计价,基准按「${specUnitRaw}」计——单位不一致无法自动比价,请人工换算核对`,
            risk: { level: 'unknown', label: '单位不一致', color: 'gray' },
            quantity: item.quantity,
            total: item.total,
        };
    }

    // 0904 P5: 费率型费用(unit=%)——费率落在区间≠金额合理,≥10%触发基数放大警示
    // (真实评测: 主材运输及管理费10%×主材合计≈3984元,原逻辑因10<15静默pass,坑命中0/4根因)
    if (matched.spec.unit === '%' && unitPrice != null && unitPrice >= 10) {
        const extra = Math.round((unitPrice - 8) / 100 * 10000);
        return {
            item: item.name,
            category: matched.category,
            benchmark_name: matched.name,
            unit_price: unitPrice,
            unit: '%',
            expected_range: range,
            deviation: Math.round((unitPrice - range.median) / range.median * 1000) / 10,
            direction: 'high',
            status: 'warning_high',
            message: `费率型费用 ${unitPrice}%——行业常见5%~8%,较8%每万元基数多收约${extra}元;请核对计费基数(基数越大放大越狠)与实际金额,费率可谈`,
            risk: riskLevel(30),
            quantity: item.quantity,
            total: item.total,
        };
    }

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
 */
export function checkMissingItems(items) {
    const itemNames = items.map(i => i.name.toLowerCase());
    const missing = [];

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
 */
export function auditQuote(quoteInput, options = {}) {
    const { city = '沈阳', tier = '中档', area = null } = options;
    const benchmark = loadBenchmark();
    const keywordIndex = buildKeywordIndex(benchmark);

    let items;
    if (typeof quoteInput === 'string') {
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

    const results = items.map(item => auditItem(item, city, tier, keywordIndex, benchmark));
    const missing = checkMissingItems(items);

    const stats = {
        total_items: results.length,
        pass: results.filter(r => r.status === 'pass').length,
        warning_high: results.filter(r => r.status === 'warning_high').length,
        warning_low: results.filter(r => r.status === 'warning_low').length,
        unknown: results.filter(r => r.status === 'unknown').length,
        missing_items: missing.length,
    };

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

    const warnings = report.results.filter(r => r.status !== 'pass' && r.status !== 'unknown');
    if (warnings.length > 0) {
        lines.push(`--- 异常项 (${warnings.length}项) ---`);
        for (const w of warnings) {
            lines.push(`  [${w.risk.label}] ${w.item}: ${w.message}`);
        }
        lines.push('');
    }

    const passed = report.results.filter(r => r.status === 'pass');
    if (passed.length > 0) {
        lines.push(`--- 正常项 (${passed.length}项) ---`);
        for (const p of passed) {
            lines.push(`  [✓] ${p.item}: ${p.message}`);
        }
        lines.push('');
    }

    const unknowns = report.results.filter(r => r.status === 'unknown');
    if (unknowns.length > 0) {
        lines.push(`--- 待人工审核 (${unknowns.length}项) ---`);
        for (const u of unknowns) {
            lines.push(`  [?] ${u.message}`);
        }
        lines.push('');
    }

    if (report.missing_items.length > 0) {
        lines.push(`--- 可能漏项 (${report.missing_items.length}项) ---`);
        for (const m of report.missing_items) {
            lines.push(`  [!] ${m.message}`);
        }
        lines.push('');
    }

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
