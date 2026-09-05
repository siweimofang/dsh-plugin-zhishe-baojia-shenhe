/**
 * 合同条款OCR模块 - v0.6.0: 合规硬路由落地(COMPLIANCE_MODE, spec v1.0 §6, 0905拍板)
 *
 * 合同截图 → 关键条款结构化 JSON(付款比例/增项条款/工期/保修期/违约责任)
 * 复用 quote_ocr.js 的通用底层 visionExtractText
 * (v0.5.0 起 thinking:disabled 由 providers.js 按供应商注入, 仅 DeepSeek)
 *
 * 红线(项目书 §5): 合同原件属红档,永不上云——工具描述强制只收脱敏件;
 * 本模块对提取文本做 PII 扫描,检出手机号/身份证号自动打码并旗标。
 * v0.6.0 合规硬路由(spec v1.0 定稿, COMPLIANCE_MODE):
 *   advisory(默认) = v0.5.0 现状零行为变化——检出PII且供应商非百炼仅附 compliance_warning 提示;
 *   strict = 事前预检门(路由优先: 尽量自动改道百炼, 不可路由才拒收且不发起任何视觉调用)
 *          + 事后分流(绕行检出PII → compliance_blocked, 封存口径B: 结果保留本机核对+事件进日志+报告顶部红横幅)。
 */

import { visionExtractText } from './quote_ocr.js';
import { resolveVisionProvider, resolveProviderId } from './providers.js';
import { parseLooseJSON } from './utils.js';

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
 * 合规模式: 仅 COMPLIANCE_MODE=strict 启用硬路由, 其余(含未配置)一律 advisory
 * @returns {'advisory'|'strict'}
 */
export function complianceMode() {
    return String(process.env.COMPLIANCE_MODE || '').trim().toLowerCase() === 'strict' ? 'strict' : 'advisory';
}

/**
 * 事前预检门(spec v1.0 §6-1): strict + 解析供应商≠bailian → 先试自动改道, 不可路由才拒收
 * (PII 扫描只能发生在 OCR 之后, 事后改道=违规已成事实, 故必须事前按工具类型判档: 合同图片=红档)
 *
 * @param {object} options - 透传的 vision 选项(含 provider 覆盖)
 * @returns {{action:'proceed'|'reroute'|'refuse', mode:'advisory'|'strict', callOptions?:object, error?:string}}
 */
export function resolveCompliancePreflight(options = {}) {
    const mode = complianceMode();
    if (mode !== 'strict') return { action: 'proceed', mode };
    const pid = resolveProviderId(options);
    if (pid === 'bailian') return { action: 'proceed', mode };
    // strict + 非百炼: 路由优先——百炼可解析就自动改道, 不打扰调用方
    const bailian = resolveVisionProvider({ ...options, provider: 'bailian' });
    if (bailian.ok) {
        return { action: 'reroute', mode, callOptions: { ...options, provider: 'bailian' } };
    }
    return {
        action: 'refuse',
        mode,
        error: `合同图片属红档: strict模式下必须走百炼合规路线, 但百炼未配置(${bailian.error})。两选一: ①配置 BAILIAN_API_KEY + BAILIAN_VL_MODEL 后重试; ②改传彻底脱敏件或直接粘贴条款文本(contract_text, 不经视觉云)`,
    };
}

/**
 * 后检分流(spec v1.0 §6-2 / 拍板③=B): 检出PII 且实际供应商非百炼时生成合规旗标
 * - strict   → compliance_blocked(封存: 仅限本机核对, 禁止进入对外交付物)
 * - advisory → compliance_warning(v0.5.0 原文案逐字保留, 零行为变化)
 * @returns {{compliance_blocked?: string, compliance_warning?: string}} 空对象=无旗标
 */
export function buildComplianceFlags(piiFound, providerUsed, mode) {
    const found = Array.isArray(piiFound) ? piiFound : [];
    if (found.length === 0 || providerUsed === 'bailian') return {};
    if (mode === 'strict') {
        return {
            compliance_blocked: `红档警告(strict): 检出个人信息(${found.join('/')})且实际供应商为「${providerUsed || 'unknown'}」非百炼——本次结果已标记封存: 仅限本机核对, 禁止进入对外交付物; 请改走百炼合规路线或彻底脱敏后重试`,
        };
    }
    return {
        compliance_warning: `检出个人信息(${found.join('/')})且当前视觉供应商为「${providerUsed || 'unknown'}」非百炼——按红档红线建议敏感件改走百炼路线或先彻底脱敏(spec定稿后升级为硬拒收)`,
    };
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
 * @param {object} options - 透传 visionExtractText({apiKey, baseUrl, maxTokens, provider})
 * @returns {Promise<{success, data?, raw_text?, pages_total, pages_success, pii: {found: string[]},
 *   compliance_refused?, compliance_rerouted?, compliance_blocked?, compliance_warning?, usage?, error?}>}
 * data 为 null 时调用方可用 raw_text 走文本启发式提取兜底;
 * strict 模式下不可路由时拒收: compliance_refused:true, 不发起任何视觉调用。
 */
export async function extractContractFromImages(imageInputs, options = {}) {
    const inputs = Array.isArray(imageInputs) ? imageInputs : [imageInputs];

    // v0.6.0 预检门: strict 下路由优先(能改道百炼就自动改道), 不可路由才拒收且不发起调用
    const pre = resolveCompliancePreflight(options);
    if (pre.action === 'refuse') {
        return {
            success: false,
            compliance_refused: true,
            pages_total: inputs.length,
            pages_success: 0,
            pii: { found: [] },
            error: pre.error,
        };
    }
    const callOptions = pre.callOptions || options; // reroute 时已注入 provider:'bailian'

    const pages = [];
    let usage = null;
    let providerUsed = null; // 记录实际供应商,供PII合规分流

    // v0.6.0 §4-2: strict 走百炼路线全败时重试1次, 仍败明示失败, 不静默回落 DeepSeek
    const maxAttempts = pre.mode === 'strict' ? 2 : 1;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        pages.length = 0; usage = null; providerUsed = null; // 每轮整体重置, 不混轮
        for (let i = 0; i < inputs.length; i++) {
            const r = await visionExtractText(inputs[i], CONTRACT_OCR_PROMPT, callOptions);
            if (r.usage && !usage) usage = r.usage;
            if (r.provider && !providerUsed) providerUsed = r.provider;
            if (!r.success) {
                pages.push({ page: i + 1, success: false, error: r.error });
                continue;
            }
            const pii = maskPII(r.text); // 先打码再解析,联系方式不会进返回值
            const data = parseLooseJSON(pii.masked);
            pages.push({ page: i + 1, success: true, data, raw_text: pii.masked, pii_found: pii.found });
        }
        if (pages.some(p => p.success)) break; // 任一页成功即收(仅全败才重试)
        lastError = pages.find(p => p.error)?.error || '未知原因';
    }

    const okPages = pages.filter(p => p.success);
    const piiFound = [...new Set(okPages.flatMap(p => p.pii_found || []))];

    if (okPages.length === 0) {
        const retryNote = maxAttempts > 1 ? ' (strict模式: 已重试1次, 按spec不回落DeepSeek路线)' : '';
        return {
            success: false,
            pages_total: inputs.length,
            pages_success: 0,
            pii: { found: piiFound },
            error: `所有 ${inputs.length} 张合同图片提取失败: ${lastError || '未知原因'}${retryNote}`,
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
    // v0.6.0 后检分流: 改道调用即使底层未上报 provider 也按百炼计(改道即合规路线)
    const effProvider = providerUsed || (pre.action === 'reroute' ? 'bailian' : null);
    const flags = buildComplianceFlags(piiFound, effProvider, pre.mode);
    if (flags.compliance_blocked) {
        // 拍板③=B: 事件进日志(stderr), 结果不丢弃、保留本机核对
        console.error(`[compliance] RED-ARCHIVE event: strict绕行检出PII(${piiFound.join('/')}) provider=${effProvider || 'unknown'} pages=${okPages.length}/${inputs.length}`);
    }
    return {
        success: true,
        data: parsedDatas.length ? mergeContractPages(parsedDatas) : null,
        raw_text: okPages.map(p => p.raw_text).join('\n'),
        pages_total: inputs.length,
        pages_success: okPages.length,
        pii: { found: piiFound },
        ...(pre.action === 'reroute' && { compliance_rerouted: '合同图片属红档: strict模式已自动改走百炼合规路线' }),
        ...flags,
        usage,
    };
}
