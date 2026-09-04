/**
 * 合同审核引擎 - 条款风险规则 (P2 Step2, 0903 法条层扩容 v2)
 *
 * 输入: extractClausesFromText(文本启发式) 或 contract_ocr.js(视觉JSON) 产出的条款对象
 * 规则依据(19条): 行业付款惯例(首付30%~35%/尾款≥5%且验收后付) +
 *   《住宅室内装饰装修管理办法》第三十二条(装修保修最低2年,防水5年) +
 *   《民法典》§586(定金≤主合同标的额20%) / §497(格式条款无效情形) +
 *   《消费者权益保护法》§26(霸王条款) + 《建设工程质量管理条例》§40(保修自竣工验收合格日起算) +
 *   行业惯例(增项封顶5%~8% / 日违约金0.5‰~1‰ / 按工程节点付款 / 材料锁定品牌型号)
 * 自足性: 仅依赖本地 gotchas_engine(Step1 内嵌库),不碰 zhishe-common
 */

import { matchGotchasForItem } from '../gotchas/gotchas_engine.js';

/**
 * 文本启发式提取条款(粘贴文本 / 视觉JSON解析失败兜底)
 * 输出与 contract_ocr.js 同构的条款对象
 */
export function extractClausesFromText(text) {
    const t = String(text || '');
    const lines = t.split(/\n+/);

    // 付款节点: 含%的行,节点名取行首非数字段
    // 过滤(0903冒烟修正): 增项/保修/违约/定金等条款也含%,必须排除;且行内要有付款语义词
    const payment_terms = [];
    for (const line of lines) {
        if (!/%|％/.test(line)) continue;
        if (/增项|变更|保修|违约|工期|面积|折|资质|定金|订金/.test(line)) continue;
        if (!/付|款|结算/.test(line)) continue;
        const pm = line.match(/(\d{1,3})\s*[%％]/);
        if (!pm) continue;
        const stage = (line.match(/^[^\d%％]{2,16}/) || [''])[0].trim() || '未名节点';
        const am = line.match(/(\d[\d,，]*)\s*元/);
        payment_terms.push({
            stage,
            percent: Number(pm[1]),
            amount: am ? Number(am[1].replace(/[,,]/g, '')) : null,
            condition: /验收|合格|竣工|开工|进场/.test(line) ? '见原文' : null,
        });
    }

    // 总价(支持 万元)
    let total_price = null;
    const tm = t.match(/总\s*(?:价|价款|造价)[^\d%]{0,10}([\d,，]+(?:\.\d+)?)\s*(万元|元)/);
    if (tm) total_price = Number(tm[1].replace(/[,,]/g, '')) * (tm[2] === '万元' ? 10000 : 1);

    // 工期
    const dm = t.match(/(?:工期|竣工)[^\d]{0,10}(\d{1,4})\s*(?:天|日|工作日)/);
    const dateMatches = t.match(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?/g) || [];
    const duration_days = dm ? Number(dm[1]) : null;
    const duration_text = !dm && dateMatches.length >= 2 ? `${dateMatches[0]} 至 ${dateMatches[dateMatches.length - 1]}` : (dm ? null : (dateMatches.length >= 2 ? `${dateMatches[0]} 至 ${dateMatches[dateMatches.length - 1]}` : null));

    // 保修
    const wm = t.match(/保修[^\d]{0,8}(\d{1,2})\s*年/);
    const wpm = t.match(/防水[^\d]{0,14}?(\d{1,2})\s*年/);
    const warranty_general = wm ? Number(wm[1]) : null;
    const warranty_waterproof = wpm ? Number(wpm[1]) : null;

    // 增项/违约
    const addLine = lines.find(l => /增项|加项|工程变更/.test(l));
    const addition_clause = addLine ? addLine.trim().slice(0, 80) : (/增项|加项|工程变更/.test(t) ? '有增项相关表述(见原文)' : null);

    // —— 0903 法条层扩容: 新增字段提取 ——
    // 定金比例(民法典§586): 优先百分比,其次金额/总价换算;「订金/预付款」不算定金
    let deposit_percent = null;
    const dpm = t.match(/定金[^。\n%]{0,30}?(\d{1,3})\s*[%％]/);
    if (dpm) {
        deposit_percent = Number(dpm[1]);
    } else {
        const dam = t.match(/定金[^。\n]{0,30}?(\d[\d,，]*)\s*元/);
        if (dam && total_price) deposit_percent = Math.round(Number(dam[1].replace(/[,,]/g, '')) / total_price * 100);
    }

    // 霸王条款(民法典§497/消保法§26)
    const format_bad_clauses = [];
    for (const line of lines) {
        if (/最终解释权|概不负责|不承担任何(?:责任|赔偿|法律)|一切(?:损失|责任)均由甲方|由甲方(?:自行)?负责/.test(line)) {
            format_bad_clauses.push(line.trim().slice(0, 60));
        }
    }

    // 材料锁定等级: equivalent(同档替换,最危险) > brand_model > brand > none
    let material_lock_level = null;
    if (/同档|同级|同等品|类似牌|同品质|同等.*替换|同.*级.*替/.test(t)) material_lock_level = 'equivalent';
    else if (/品牌.{0,12}型号|型号.{0,12}品牌/.test(t)) material_lock_level = 'brand_model';
    else if (/品牌|牌号|厂家/.test(t)) material_lock_level = 'brand';
    else if (t.length > 80) material_lock_level = 'none'; // 文本够长却无品牌字样才判 none,短文本不判(防误报)

    // 保修起算点(建设工程质量管理条例§40): 有保修条款时才判
    const hasWarranty = warranty_general != null || warranty_waterproof != null;
    const warranty_start_specified = hasWarranty ? (/(?:保修|质保)[^。\n]{0,24}(?:自|从|起算)|验收合格[^。\n]{0,6}之日起/.test(t)) : null;

    // 增项封顶比例
    let addition_percent = null;
    const apm = t.match(/增项[^。\n%]{0,40}?(?:不超过|上限|封顶)[^。\n\d]{0,8}(\d{1,2})\s*[%％]/);
    if (apm) addition_percent = Number(apm[1]);

    // 每日违约金(行业惯例 0.5‰~1‰/日): %直读,千分之/万分之/‰换算
    let delay_penalty_daily_percent = null;
    if (/违约|延误|延期|逾期/.test(t)) {
        const p1 = t.match(/(?:每日|每天|按日)[^。\n%]{0,20}?(\d(?:\.\d+)?)\s*[%％]/);
        const p2 = t.match(/千分之(\d(?:\.\d+)?)/);
        const p3 = t.match(/万分之(\d(?:\.\d+)?)/);
        const p4 = t.match(/([\d.]+)\s*‰/);
        if (p1) delay_penalty_daily_percent = Number(p1[1]);
        else if (p2) delay_penalty_daily_percent = Number(p2[1]) / 10;
        else if (p3) delay_penalty_daily_percent = Number(p3[1]) / 100;
        else if (p4) delay_penalty_daily_percent = Number(p4[1]) / 10;
    }

    // 争议解决方式
    let dispute_method = null;
    if (/仲裁/.test(t)) dispute_method = 'arbitration';
    else if (/诉讼|人民法院|向.*法院(?:起诉|提起)/.test(t)) dispute_method = 'litigation';

    return {
        is_contract: true,
        parse_mode: 'heuristic',
        parties: { jiafang: null, yifang: null },
        total_price,
        payment_terms,
        addition_clause,
        duration_days,
        duration_text,
        warranty_general,
        warranty_waterproof,
        breach_clause: /违约/.test(t),
        delay_penalty: /违约金/.test(t) || /(延期|延误|逾期)[^\n]{0,24}违约/.test(t),
        deposit_percent,
        format_bad_clauses,
        material_lock_level,
        warranty_start_specified,
        addition_percent,
        delay_penalty_daily_percent,
        dispute_method,
    };
}

/**
 * 条款风险审核
 * @returns {{risks: Array<{rule,severity,label,message}>, overall: {level,label}}}
 */
export function auditContract(clauses, options = {}) {
    const { pii_found = false } = options;
    const c = clauses || {};
    const risks = [];
    const add = (rule, severity, label, message) => risks.push({ rule, severity, label, message });

    // 0. PII 红档旗标(最高优先)
    if (pii_found) {
        add('pii_redline', 'SEV_CRITICAL', '红档警告',
            '检出未脱敏联系方式(已自动打码)——合同原件属红档,当前走 DS 通道(无"不训练"承诺)。请立即停止上传原件,只传涂掉姓名/电话/证件号的脱敏件。');
    }

    // 1. 付款比例
    const terms = Array.isArray(c.payment_terms) ? c.payment_terms.filter(t => t && t.percent != null) : [];
    if (terms.length > 0) {
        const first = terms[0];
        if (first.percent > 50) {
            add('down_payment', 'SEV_HIGH', '首付过高',
                `首笔款 ${first.percent}%(${first.stage || '开工'})超过一半——行业惯例开工款 30%~35%,首付过高失去履约约束,建议谈回 ≤35%。`);
        }
        const last = terms[terms.length - 1];
        if (last.percent < 5) {
            add('tail_payment', 'SEV_MEDIUM', '尾款过少',
                `尾款仅 ${last.percent}%——尾款是验收质量的主要杠杆,建议 ≥10% 且写明"竣工验收合格后 X 日内支付"。`);
        }
        const sum = terms.reduce((s, t) => s + (t.percent || 0), 0);
        if (sum > 100) {
            add('payment_sum', 'SEV_HIGH', '付款比例异常',
                `各节点付款比例合计 ${sum}% >100%,疑似提取误差或合同本身有误,请人工核对原文。`);
        } else if (sum < 80) {
            add('payment_sum_low', 'SEV_MEDIUM', '付款比例不全',
                `已提取节点合计 ${sum}%,与 100% 差距较大——可能有节点漏提取,请人工核对付款条款页。`);
        }
    } else {
        add('payment_missing', 'SEV_HIGH', '未见付款条款',
            '未提取到任何付款比例节点——付款方式是合同核心条款,缺失即重大风险,请人工核对。');
    }

    // 2. 增项上限
    if (!c.addition_clause) {
        add('addition', 'SEV_HIGH', '增项无上限',
            '未见增项/变更条款——"低价签约+后期增项"是行业头号套路。建议补写: "增项合计不超过合同总价 5%,超出部分由施工方承担"或采用总价包干。');
    } else if (!/不超过|上限|%|包干/.test(String(c.addition_clause))) {
        add('addition_open', 'SEV_MEDIUM', '增项条款可能无封顶',
            `有增项条款但未见封顶表述(原文:"${String(c.addition_clause).slice(0, 40)}")——建议明确增项幅度上限。`);
    }

    // 3. 工期
    if (c.duration_days == null && !c.duration_text) {
        add('duration', 'SEV_MEDIUM', '工期未明确',
            '未提取到工期天数或开竣工日期——工期不明则延期无据可追,建议补写总工期与具体开竣工日期。');
    }

    // 4. 保修(法定底线: 总保修≥2年,防水≥5年)
    if (c.warranty_general == null) {
        add('warranty', 'SEV_MEDIUM', '保修期未写明',
            '未提取到保修期——法定最低保修 2 年(防水 5 年),未写明按法定执行但扯皮成本高,建议明确写入。');
    } else if (c.warranty_general < 2) {
        add('warranty', 'SEV_HIGH', '保修期低于法定',
            `约定保修 ${c.warranty_general} 年,低于《住宅室内装饰装修管理办法》规定的最低 2 年——该条款违法无效,必须改回 ≥2 年。`);
    }
    if (c.warranty_waterproof != null && c.warranty_waterproof < 5) {
        add('warranty_waterproof', 'SEV_HIGH', '防水保修不足',
            `防水保修 ${c.warranty_waterproof} 年,法定为 5 年(有防水要求部位防渗漏)——必须改。`);
    }

    // 5. 违约责任
    if (!c.breach_clause) {
        add('breach', 'SEV_MEDIUM', '无违约责任条款',
            '未见违约责任条款——建议补充双方违约责任,尤其是工期延误违约金(常见: 每延误一日按合同总价 0.5‰~1‰)。');
    } else if (!c.delay_penalty) {
        add('delay_penalty', 'SEV_MEDIUM', '无延期违约金',
            '有违约条款但未见工期延误违约金——延期是装修最高发纠纷,建议写明计算标准。');
    }

    // —— 0903 法条层扩容规则(6~13) ——

    // 6. 定金上限(民法典§586: 不超过主合同标的额 20%,超出部分不产生定金效力)
    if (c.deposit_percent != null && c.deposit_percent > 20) {
        add('deposit_cap', 'SEV_HIGH', '定金超法定上限',
            `定金 ${c.deposit_percent}% 超过《民法典》第586条 20% 的法定上限,超出部分不产生定金效力——降回 ≤20%,或改用「订金/预付款」表述(不受定金罚则约束)。`);
    }

    // 7. 霸王条款(民法典§497 格式条款无效 / 消保法§26)
    const bad = Array.isArray(c.format_bad_clauses) ? c.format_bad_clauses : [];
    if (bad.length > 0) {
        add('format_bad', 'SEV_HIGH', '涉嫌无效霸王条款',
            `检出 ${bad.length} 处格式条款风险表述(如"${String(bad[0]).slice(0, 30)}")——「最终解释权归乙方」「概不负责」类条款依《民法典》第497条、《消费者权益保护法》第26条无效,可要求删除或修改。`);
    }

    // 8. 材料锁定(品牌替换/以次充好高发点)
    if (c.material_lock_level === 'equivalent') {
        add('material_lock', 'SEV_HIGH', '材料可被同档替换',
            '材料条款含「同档/同级替换」表述——「同档」由乙方单方解释,是材料调包高发点。建议锁定品牌+型号+等级,或约定任何替换须经甲方书面确认。');
    } else if (c.material_lock_level === 'none') {
        add('material_lock', 'SEV_MEDIUM', '材料未锁品牌型号',
            '未见材料品牌/型号约定——建议附《材料明细表》写明品牌、型号、等级、数量,防止施工时以次充好。');
    }

    // 9. 保修起算点(建设工程质量管理条例§40: 自竣工验收合格之日起算)
    if ((c.warranty_general != null || c.warranty_waterproof != null) && c.warranty_start_specified === false) {
        add('warranty_start', 'SEV_MEDIUM', '保修起算点未写明',
            '有保修条款但未见起算点——法定自竣工验收合格之日起算(《建设工程质量管理条例》第40条),建议写明,防止乙方从「开工日」起算把保修期用掉。');
    }

    // 10. 增项封顶比例(行业惯例 5%~8%)
    if (c.addition_percent != null && c.addition_percent > 8) {
        add('addition_ratio', 'SEV_MEDIUM', '增项封顶偏高',
            `增项封顶 ${c.addition_percent}% 高于行业惯例(5%~8%)——封顶越宽,「低价钓鱼+增项收割」空间越大,建议谈回 ≤5% 并写明超出部分由乙方承担。`);
    }

    // 11. 付款未挂工程进度(只在有明确付款条件可判断时报,信息不足不报——防误报)
    const termsAll = Array.isArray(c.payment_terms) ? c.payment_terms.filter(Boolean) : [];
    if (termsAll.length >= 2) {
        const condKnown = termsAll.map(t2 => String(t2.condition || '')).filter(x => x && x !== '见原文');
        if (condKnown.length > 0 && !condKnown.some(x => /验收|合格|竣工|开工|进场|隐蔽|泥木|油漆|水电|油工|瓦工|安装完毕|贴砖|腻子/.test(x))) {
            add('payment_progress', 'SEV_MEDIUM', '付款未挂钩工程进度',
                '付款节点未见与工程进度挂钩(未检出验收/竣工等进度条件)——建议按节点付款(开工→水电验收→泥木验收→竣工验收),纯按日期付款对业主无保护。');
        }
    }

    // 12. 日违约金偏高(行业惯例 0.05%~0.1%/日; 0904 P5阈值0.5→0.2: 实证千分之四=0.4%/日为惯例上限4倍却未触发)
    if (c.delay_penalty_daily_percent != null && c.delay_penalty_daily_percent > 0.2) {
        add('penalty_ratio', 'SEV_MEDIUM', '日违约金偏高',
            `工期延误违约金 ${c.delay_penalty_daily_percent}%/日,高于行业惯例(0.05%~0.1%/日)——若该违约金由对方(施工方)承担则对你有利,可保留;若由你承担请谈回惯例区间,双向条款下过高一方也可主张法院调低。`);
    }

    // 13. 争议解决方式
    if (c.dispute_method == null) {
        add('dispute_missing', 'SEV_LOW', '争议解决方式未写明',
            '未见仲裁或诉讼约定——发生纠纷时程序被动。建议写明「协商不成,向合同签订地人民法院起诉」或明确约定仲裁委。');
    }

    const hasCrit = risks.some(r => r.severity === 'SEV_CRITICAL');
    const hasHigh = risks.some(r => r.severity === 'SEV_HIGH');
    const overall = hasCrit
        ? { level: 'poor', label: '存在红档风险,立即停止并处理' }
        : hasHigh
            ? { level: 'warn', label: '存在高危条款,签约前必须整改' }
            : risks.length > 0
                ? { level: 'fair', label: '基本齐备,有中危条款建议补强' }
                : { level: 'good', label: '关键条款齐备,未发现明显风险' };

    return { risks, overall };
}

const SEV_LABEL = { SEV_CRITICAL: '致命', SEV_HIGH: '高危', SEV_MEDIUM: '中危', SEV_LOW: '低危' };

/**
 * 签约避坑提示: 按命中的风险主题查 Step1 内嵌坑库,去重取 top2
 */
export function contractGotchaTips(clauses, audit, cap = 2) {
    const topicByRule = {
        down_payment: '付款比例', tail_payment: '尾款', payment_missing: '付款方式',
        addition: '增项', addition_open: '增项', addition_ratio: '增项', payment_sum: '付款比例',
        warranty: '保修期', warranty_waterproof: '防水保修', warranty_start: '保修期', duration: '工期',
        breach: '违约责任', delay_penalty: '延期违约', penalty_ratio: '违约金',
        deposit_cap: '定金', format_bad: '霸王条款', material_lock: '材料品牌',
        payment_progress: '付款方式', dispute_missing: '维权',
    };
    const seen = new Set();
    const tips = [];
    for (const r of audit.risks) {
        const topic = topicByRule[r.rule];
        if (!topic) continue;
        for (const m of matchGotchasForItem(topic, 1)) {
            if (seen.has(m.ku_id)) continue;
            seen.add(m.ku_id);
            tips.push({ topic, ku_id: m.ku_id, title: m.title, severity: m.severity, how_to_avoid: firstStep(m.how_to_avoid) });
            if (tips.length >= cap) return tips;
        }
    }
    return tips;
}

/** how_to_avoid 取第一步 */
function firstStep(text, max = 90) {
    if (!text) return '';
    const first = String(text).split(/(?=[2-9]\s*[.、])/)[0].trim();
    return first.length > max ? first.slice(0, max) + '…' : first;
}

/**
 * 格式化合同审核报告
 */
export function formatContractReport(clauses, audit, tips = [], meta = null) {
    const c = clauses || {};
    const lines = [];
    lines.push('=== 装修合同审核报告 ===');
    const party = c.parties ? [c.parties.jiafang, c.parties.yifang].filter(Boolean).join(' / ') : '';
    lines.push(`甲方/乙方: ${party || '(未提取到)'} | 总价: ${c.total_price != null ? c.total_price + ' 元' : '(未提取到)'}`);

    const terms = Array.isArray(c.payment_terms) ? c.payment_terms : [];
    if (terms.length) {
        lines.push(`付款节点: ${terms.map(t => `${t.stage || '?'}${t.percent != null ? t.percent + '%' : ''}${t.amount != null ? '(' + t.amount + '元)' : ''}`).join(' → ')}`);
    }
    lines.push(`工期: ${c.duration_days != null ? c.duration_days + ' 天' : (c.duration_text || '(未写明)')} | 保修: 总${c.warranty_general != null ? c.warranty_general + '年' : '未写明'} / 防水${c.warranty_waterproof != null ? c.warranty_waterproof + '年' : '未单列'} | 违约条款: ${c.breach_clause ? '有' : '无'}`);
    lines.push(`增项条款: ${c.addition_clause ? String(c.addition_clause).slice(0, 60) : '(未见——重大风险)'}`);
    lines.push(`总体评价: ${audit.overall.label}`);
    lines.push('');

    if (audit.risks.length > 0) {
        lines.push(`--- 风险提示 (${audit.risks.length}项) ---`);
        for (const r of audit.risks) {
            lines.push(`  [${SEV_LABEL[r.severity] || r.severity}] ${r.label}: ${r.message}`);
        }
        lines.push('');
    }

    if (tips.length > 0) {
        lines.push('--- 签约避坑 ---');
        for (const t of tips) {
            lines.push(`  [避坑·${SEV_LABEL[t.severity] || t.severity}] ${t.title}`);
            lines.push(`      应对: ${t.how_to_avoid}`);
        }
        lines.push('');
    }

    lines.push('--- 说明 ---');
    lines.push('  · 红线: 合同原件属红档禁止上传,本工具只处理脱敏件;检出联系方式会自动打码并警告。');
    lines.push('  · 提取由 AI 完成可能遗漏,签约前请以合同原文为准逐条人工复核。');
    if (meta && meta.source === 'image') {
        lines.push(`  · 来源: 合同图片 ${meta.pages_success}/${meta.pages_total} 页提取成功(引擎 DS vision-exp,厘钱级)。`);
    }
    return lines.join('\n');
}
