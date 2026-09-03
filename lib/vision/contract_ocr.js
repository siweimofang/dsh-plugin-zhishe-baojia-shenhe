/**
 * 合同条款OCR模块 - 基于 DeepSeek V4-Flash-Vision-Exp (P2 Step2)
 *
 * 合同截图 → 关键条款结构化 JSON(付款比例/增项条款/工期/保修期/违约责任)
 * 复用 quote_ocr.js 的通用底层 visionExtractText(同一 DS 铁律:thinking:disabled)
 *
 * 红线(项目书 §5): 合同原件属红档,永不上云——工具描述强制只收脱敏件;
 * 本模块对提取文本做 PII 扫描,检出手机号/身份证号自动打码并旗标。
 * 注: 当前引擎路由仍为 DS(无不训练承诺),PII 打码是过渡护栏;
 *     「未脱净只走百炼或拒收」的硬路由留待 spec 定稿,此处不装死。
 */

import { visionExtractText } from './quote_ocr.js';

const CONTRACT_OCR_PROMPT = `你是一个装修合同条款提取专家。请从合同图片中提取关键条款,只输出一个JSON对象,不要输出任何其他文字或代码块标记。

输出格式:
{"is_contract": true, "parties": {"jiafang": "甲方名或null", "yifang": "乙方公司名或null"}, "total_price": 数字或null, "payment_terms": [{"stage": "节点名", "percent": 数字或null, "amount": 数字或null, "condition": "付款条件原文或null"}], "addition_clause": "增项/变更条款原文摘要或null", "duration_days": 数字或null, "duration_text": "开工竣工日期原文或null", "warranty_general": 数字或null, "warranty_waterproof": 数字或null, "breach_clause": true或false, "delay_penalty": true或false, "deposit_percent": 数字或null, "format_bad_clauses": ["霸王条款原文"], "material_lock_level": "brand_model", "warranty_start_specified": true或false或null, "addition_percent": 数字或null, "delay_penalty_daily_percent": 数字或null, "dispute_method": "litigation", "contact_info": "合同中出现的联系方式原文或null"}

字段规则:
1. is_contract: 不是装修合同图片时为 false,且其他字段全部填 null/false/[]
2. 只提取图中实际内容,不确定或图中没有的一律填 null/false/[],禁止编造
3. percent 为百分数数字(30 表示 30%),不带%号; amount 单位统一为元
4. payment_terms 按付款顺序排列,不漏"尾款/质保金"类末笔款项; condition 抄录付款条件原文(如"竣工验收合格后")
5. addition_clause: 增项/工程变更条款的原文摘要;图中无增项条款则填 null(这本身是重大风险)
6. warranty_general: 装修工程总保修年数; warranty_waterproof: 防水工程保修年数
7. breach_clause: 是否存在违约责任条款; delay_penalty: 是否约定工期延误违约金
8. deposit_percent: 合同约定的"定金"占合同总价百分比(写"订金/预付款"的不算定金,填 null)
9. format_bad_clauses: 图中出现的霸王条款原文数组,如"最终解释权归本公司""概不负责""不承担任何责任",没有则填空数组[]
10. material_lock_level: 材料约定等级——"brand_model"=品牌+型号都写明 / "brand"=仅写品牌 / "equivalent"=含"同档/同级替换"表述 / "none"=无品牌型号约定 / null=图中无材料条款或不确定
11. warranty_start_specified: 保修条款是否写明自"竣工验收合格之日"起算(true/false;图中无保修条款填 null)
12. addition_percent: 增项封顶百分比数字(如"增项不超过合同总价5%"填 5),无封顶填 null
13. delay_penalty_daily_percent: 工期延误违约金每日百分比,必须统一换算成百分数:千分之N或N‰填 N/10(千分之五=0.5,1‰=0.1,5‰=0.5),万分之N填 N/100(日万分之五=0.05),百分之N才直读(百分之五=5),无则填 null
14. dispute_method: "arbitration"=约定仲裁 / "litigation"=约定诉讼或法院管辖 / null=未约定
15. contact_info: 把图中出现的所有联系方式原样抄录到该字段(电话/微信/QQ/身份证号,有几个抄几个),图中完全没有才填 null——该字段仅用于隐私检测,不会展示给用户`;

/**
 * PII 模式(手机号/身份证号),带边界防误伤长数字
 */
const PII_PATTERNS = [
    { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
    { name: '身份证号', re: /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])\d{3}[\dXx](?!\d)/g },
];

/**
 * 扫描并打码文本中的个人信息
 * @returns {{masked: string, found: string[]}}
 */
export function maskPII(text) {
    const found = [];
    let masked = String(text || '');
    for (const { name, re } of PII_PATTERNS) {
        if (re.test(masked)) {
            found.push(name);
            masked = masked.replace(re, (m) => m.slice(0, 3) + '****' + m.slice(-2));
        }
    }
    return { masked, found };
}

/**
 * 从模型返回文本中稳健解析 JSON(剥代码围栏/截取首尾大括号)
 */
function parseLooseJSON(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s === -1 || e === -1 || e <= s) return null;
    try {
        return JSON.parse(t.slice(s, e + 1));
    } catch {
        return null;
    }
}

/**
 * 多页条款合并: 数组字段拼接,标量字段取首个非空,布尔取或
 */
export function mergeContractPages(datas) {
    const ok = datas.filter(Boolean);
    if (ok.length === 0) return null;
    const first = (key) => ok.map(d => d[key]).find(v => v != null) || null;
    const merged = {
        is_contract: ok.some(d => d.is_contract === true),
        parties: ok.map(d => d.parties).find(p => p && (p.jiafang || p.yifang)) || null,
        total_price: first('total_price'),
        payment_terms: ok.flatMap(d => (Array.isArray(d.payment_terms) ? d.payment_terms : [])),
        addition_clause: first('addition_clause'),
        duration_days: first('duration_days'),
        duration_text: first('duration_text'),
        warranty_general: first('warranty_general'),
        warranty_waterproof: first('warranty_waterproof'),
        breach_clause: ok.some(d => d.breach_clause === true),
        delay_penalty: ok.some(d => d.delay_penalty === true),
        // 0903 法条层扩容字段
        deposit_percent: first('deposit_percent'),
        format_bad_clauses: [...new Set(ok.flatMap(d => (Array.isArray(d.format_bad_clauses) ? d.format_bad_clauses : [])))],
        material_lock_level: (['equivalent', 'brand_model', 'brand', 'none'].map(lv => ok.find(d => d.material_lock_level === lv)) .find(Boolean) || {}).material_lock_level || null,
        warranty_start_specified: ok.some(d => d.warranty_start_specified === true) ? true : (ok.some(d => d.warranty_start_specified === false) ? false : null),
        addition_percent: first('addition_percent'),
        delay_penalty_daily_percent: first('delay_penalty_daily_percent'),
        dispute_method: first('dispute_method'),
        contact_info: first('contact_info'),
    };
    if (!merged.parties) merged.parties = { jiafang: null, yifang: null };
    return merged;
}

/**
 * 合同截图(单张或多页) → 结构化条款
 *
 * @param {string[]} imageInputs - 图片列表(base64 data URI / URL / 本地路径),建议≤6张
 * @param {object} options - 透传 visionExtractText({apiKey, baseUrl, maxTokens})
 * @returns {Promise<{success, data?, raw_text?, pages_total, pages_success, pii: {found: string[]}, usage?, error?}>}
 * data 为 null 时调用方可用 raw_text 走文本启发式提取兜底
 */
export async function extractContractFromImages(imageInputs, options = {}) {
    const inputs = Array.isArray(imageInputs) ? imageInputs : [imageInputs];
    const pages = [];
    let usage = null;

    for (let i = 0; i < inputs.length; i++) {
        const r = await visionExtractText(inputs[i], CONTRACT_OCR_PROMPT, options);
        if (r.usage && !usage) usage = r.usage;
        if (!r.success) {
            pages.push({ page: i + 1, success: false, error: r.error });
            continue;
        }
        const pii = maskPII(r.text); // 先打码再解析,联系方式不会进返回值
        const data = parseLooseJSON(pii.masked);
        pages.push({ page: i + 1, success: true, data, raw_text: pii.masked, pii_found: pii.found });
    }

    const okPages = pages.filter(p => p.success);
    const piiFound = [...new Set(okPages.flatMap(p => p.pii_found || []))];

    if (okPages.length === 0) {
        return {
            success: false,
            pages_total: inputs.length,
            pages_success: 0,
            pii: { found: piiFound },
            error: `所有 ${inputs.length} 张合同图片提取失败: ${pages.find(p => p.error)?.error || '未知原因'}`,
        };
    }

    // 非合同闸门: 所有成功页都自报非合同
    if (okPages.every(p => p.data && p.data.is_contract === false)) {
        return {
            success: false,
            pages_total: inputs.length,
            pages_success: okPages.length,
            pii: { found: piiFound },
            error: '图片不是装修合同,请上传合同条款页(脱敏件)',
        };
    }

    const parsedDatas = okPages.map(p => p.data).filter(Boolean);
    return {
        success: true,
        data: parsedDatas.length ? mergeContractPages(parsedDatas) : null,
        raw_text: okPages.map(p => p.raw_text).join('\n'),
        pages_total: inputs.length,
        pages_success: okPages.length,
        pii: { found: piiFound },
        usage,
    };
}
