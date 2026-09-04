/**
 * 报价单图片OCR模块 - v0.5.0 双路线+结构化
 *
 * v0.4.x: 图片 → 自由文本转写 → quote_parser.js 正则解析(两段式)
 * v0.5.0: ① 供应商可切换(DeepSeek V4-Flash-Vision-Exp / 百炼千问VL, 见 providers.js)
 *         ② 新增结构化提取路径(QUOTE_STRUCTURED_PROMPT → JSON条目 → parseItemsFromStructured
 *            → auditQuote 数组直通), 合同侧同款模式; 正则路径保留为兜底, 默认仍走文本
 *            (切换默认值的前提: vs_vision 对拍证明召回不低于基线)
 *
 * 支持三种图片传入:
 *   1. base64 内联 (data:image/png;base64,...)
 *   2. 外部 URL
 *   3. 本地文件路径 (自动转 base64)
 *
 * 成本: 一张图最多 384 tokens, 按 Flash 价格, 单次 < 0.01 元
 * 铁律: thinking:disabled 已强制(0903)——DS 默认开思考会烧光 max_tokens 返回空正文
 *       (v0.5.0 起由 providers.js 按 vendor 注入, 仅 DeepSeek)
 */

import { readFileSync } from 'fs';
import { extname } from 'path';
import { resolveVisionProvider } from './providers.js';
import { parseLooseJSON } from './utils.js';

/**
 * 报价单图片专用提取 prompt(文本路径, v0.4.x 起沿用)
 */
const QUOTE_OCR_PROMPT = `你是一个装修报价单OCR专家。请从图片中提取所有装修报价条目,输出为结构化文本。

输出规则:
1. 每行一个条目,格式: "项目名称 单价元/单位 数量 总价元"
2. 项目名称保持原文,不要翻译或改写
3. 单价必须带上单位(元/㎡、元/m、元/项、元/樘 等)
4. 如有数量,用 × 连接; 如有总价,用 = 连接
5. 百分比费用(如管理费)直接写 "项目名 X%"
6. 忽略表头、页码、公司信息等非报价内容
7. 如果图片不是装修报价单,返回 "ERROR:非报价单图片"

示例输出:
水电改造 55元/㎡ 90㎡ = 4950元
防水工程 75元/㎡ 30㎡ = 2250元
地砖铺贴 60元/㎡ 85㎡ = 5100元
管理费 8%
垃圾清运 800元/项`;

/**
 * v0.5.0 报价单结构化提取 prompt(JSON路径, 对齐 contract_ocr 模式)
 * 原则: 视觉只产出图面事实, 类目判断/比价/缺项检查全部留给规则引擎——缩小幻觉面
 */
const QUOTE_STRUCTURED_PROMPT = `你是一个装修报价单结构化提取专家。请从图片中提取所有装修报价条目,只输出一个JSON对象,不要输出任何其他文字或代码块标记。

输出格式:
{"is_quote": true, "items": [{"name": "项目名称", "unit": "计价单位", "unit_price": 数字或null, "quantity": 数字或null, "total": 数字或null, "is_fee_percent": false, "raw": "图面原文"}], "aggregates": [{"name": "汇总行名称", "amount": 数字或null, "raw": "图面原文"}]}

字段规则:
1. is_quote: 不是装修报价单图片时为 false,且 items/aggregates 均为空数组
2. items: 逐条提取报价明细行,不漏项;项目名称保持原文,不要翻译或改写
3. unit: 图面计价单位原样输出(如 ㎡/平/米/延米/项/个/樘/片/桶/块);百分比费用 unit 填 "%"
4. unit_price: 单价数字(不带"元"字);quantity: 数量数字;total: 总价数字(不带"元"字);图面没有的填 null,禁止编造或推算
5. is_fee_percent: 管理费/税金等按百分比计的费率型费用为 true,其余 false;百分比费用将百分比数字填入 unit_price(如"管理费 10%" → unit_price:10, unit:"%", quantity:null, total:null)
6. 表头、页码、公司信息等非报价内容不进 items;"小计/合计/总计/优惠/抹零"等汇总行进 aggregates,不进 items
7. raw: 该行图面原文,原样抄录`;

/**
 * 将本地图片文件转为 base64 data URI
 */
function localFileToDataUri(filePath) {
    const ext = extname(filePath).toLowerCase();
    const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
    };
    const mime = mimeMap[ext] || 'image/png';
    const buf = readFileSync(filePath);
    const b64 = buf.toString('base64');
    return `data:${mime};base64,${b64}`;
}

/**
 * 构建图片消息内容
 */
function buildImageContent(imageInput) {
    // 已经是 data URI
    if (imageInput.startsWith('data:')) {
        return { type: 'image_url', image_url: { url: imageInput } };
    }
    // URL
    if (imageInput.startsWith('http://') || imageInput.startsWith('https://')) {
        return { type: 'image_url', image_url: { url: imageInput } };
    }
    // 本地文件路径 -> 转 base64
    try {
        const dataUri = localFileToDataUri(imageInput);
        return { type: 'image_url', image_url: { url: dataUri } };
    } catch (err) {
        throw new Error(`无法读取图片文件: ${imageInput} (${err.message})`);
    }
}

/**
 * OCR复读循环检测与截断(0904 P2 幻觉拦截)
 *
 * 真实评测发现的幻觉形态: 视觉模型对密排长图输出复读循环——
 * 同一行(名称+价格)连续重复几十次(如"墙面基层处理 120"×50、"门(双开)定制3900"×N),
 * 下游解析器照单全收,条目数虚增+误报爆炸(0904_0809批次 quote_201#r2 条目80/误报68)。
 *
 * 处理: 归一化(空白折叠+小写)后逐行扫描,同一行连续出现 ≥3 次判定为复读,
 * 折叠为 1 行并记录明细。正常报价单同名同价行连续紧邻出现属极小概率(同名行价格必不同),
 * 阈值 3 保证不误伤真实数据。
 *
 * 仅用于报价 OCR 文本路径; 不用于合同 OCR/结构化路径(输出 JSON,行级截断会破坏结构)。
 */
const REPEAT_LINE_THRESHOLD = 3;

export function trimRepetitionLines(text) {
    if (!text) return { text: '', trimmed: [], repeat_groups: 0, repeat_lines_removed: 0 };
    const lines = String(text).split('\n');
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
    const out = [];
    const trimmed = [];
    let i = 0;
    while (i < lines.length) {
        const cur = norm(lines[i]);
        if (!cur) { out.push(lines[i]); i++; continue; }
        // 向前统计连续重复: 空白行不中断计数; 未达阈值则一行不动(保真)
        let matched = 1;
        let k = i + 1;
        const trailingBlanks = [];
        while (k < lines.length) {
            const nk = norm(lines[k]);
            if (!nk) { trailingBlanks.push(lines[k]); k++; continue; }
            if (nk === cur) { matched++; trailingBlanks.length = 0; k++; }
            else break;
        }
        if (matched >= REPEAT_LINE_THRESHOLD) {
            out.push(lines[i], ...trailingBlanks); // 折叠为1行,尾部空白原样保留
            trimmed.push({ line: lines[i].trim().slice(0, 60), count: matched });
            i = k;
        } else {
            out.push(lines[i]);
            i++;
        }
    }
    return {
        text: out.join('\n'),
        trimmed,
        repeat_groups: trimmed.length,
        repeat_lines_removed: trimmed.reduce((s, t) => s + t.count - 1, 0),
    };
}

/**
 * 通用视觉提取: 给定 prompt 从单图提取文本(报价/合同共用底层)
 *
 * v0.5.0: provider 解析下沉到 providers.js——model/baseUrl/apiKey/thinking 均随供应商生效;
 *         options.apiKey/baseUrl/model 仍可逐次覆盖(向后兼容 v0.4.x 调用方)
 *
 * @param {string} imageInput - base64 data URI / URL / 本地文件路径
 * @param {string} prompt - 提取用 prompt
 * @param {object} options - {provider?, model?, apiKey?, baseUrl?, maxTokens=2048}
 * @returns {Promise<{success: boolean, text?: string, provider?: string, model?: string, error?: string}>}
 * 返回文本以 "ERROR:" 开头时视为图片类型不符闸门,转 success:false
 */
export async function visionExtractText(imageInput, prompt, options = {}) {
    const resolved = resolveVisionProvider(options);
    if (!resolved.ok) {
        return { success: false, error: resolved.error };
    }
    const { cfg, model, apiKey } = resolved;
    const baseUrl = options.baseUrl || cfg.baseUrl;
    const maxTokens = options.maxTokens || 2048;

    let imageContent;
    try {
        imageContent = buildImageContent(imageInput);
    } catch (err) {
        return { success: false, error: err.message };
    }

    const body = {
        model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    imageContent,
                ],
            },
        ],
        max_tokens: maxTokens,
        temperature: 0.1, // 低温度, OCR提取要确定性
    };
    if (cfg.extraBody) Object.assign(body, cfg.extraBody); // thinking:disabled 仅 DeepSeek(0903铁律)

    try {
        const resp = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const errText = await resp.text();
            return {
                success: false,
                error: `视觉API请求失败 (HTTP ${resp.status}): ${errText.substring(0, 300)}`,
            };
        }

        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content;

        if (!text) {
            return { success: false, error: '视觉API返回为空,请检查图片是否清晰' };
        }

        // 图片类型不符闸门(quote/contract prompt 共用约定)
        if (text.startsWith('ERROR:')) {
            return { success: false, error: text.substring(6).trim() };
        }

        return {
            success: true,
            text: text.trim(),
            provider: cfg.id,
            model,
            usage: data.usage || null,
        };
    } catch (err) {
        return { success: false, error: `视觉API调用异常: ${err.message}` };
    }
}

/**
 * 报价单图片提取(薄壳,兼容原签名) - 文本路径
 * 0904 P2: 提取后逐页做复读循环截断,发生截断时附 repetition 元数据(不静默)
 */
export async function extractQuoteFromImage(imageInput, options = {}) {
    const result = await visionExtractText(imageInput, QUOTE_OCR_PROMPT, options);
    if (result.success && result.text) {
        const t = trimRepetitionLines(result.text);
        if (t.repeat_groups > 0) {
            result.text = t.text;
            result.repetition = t;
        }
    }
    return result;
}

/**
 * 批量提取: 支持多张图片(如报价单有多页) - 文本路径
 * 0904 P2: 各页复读截断明细聚合为 ocr_warnings: [{page, line, count}]
 */
export async function extractQuoteFromImages(imageInputs, options = {}) {
    const results = [];
    for (let i = 0; i < imageInputs.length; i++) {
        const result = await extractQuoteFromImage(imageInputs[i], options);
        results.push({ page: i + 1, ...result });
    }

    const successResults = results.filter(r => r.success);
    if (successResults.length === 0) {
        return {
            success: false,
            error: `所有 ${imageInputs.length} 张图片均提取失败`,
            details: results.map(r => ({ page: r.page, error: r.error })),
        };
    }

    const ocr_warnings = successResults.flatMap(r =>
        (r.repetition?.trimmed || []).map(t => ({ page: r.page, line: t.line, count: t.count }))
    );

    // 合并所有页面的文本
    const combinedText = successResults.map(r => r.text).join('\n');
    return {
        success: true,
        text: combinedText,
        provider: successResults[0].provider,
        model: successResults[0].model,
        pages_total: imageInputs.length,
        pages_success: successResults.length,
        ocr_warnings,
        details: results,
    };
}

/**
 * v0.5.0 多页结构化合并(对齐 contract_ocr.mergeContractPages 模式)
 * - items 逐页拼接; aggregates 逐页拼接
 * - 跨页整组重复(名称+单位+单价+数量+总价完全一致)只警示不删——同名同价行在真实
 *   报价单中可合法出现(两个房间同项), 删除会丢数据; 由调用方透传 duplicate_warnings
 */
export function mergeQuotePages(datas) {
    const ok = datas.filter(Boolean);
    if (ok.length === 0) return null;
    const items = ok.flatMap(d => (Array.isArray(d.items) ? d.items : []));
    const aggregates = ok.flatMap(d => (Array.isArray(d.aggregates) ? d.aggregates : []));

    const seen = new Map();
    for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const key = [it.name, it.unit, it.unit_price, it.quantity, it.total]
            .map(v => String(v ?? '').trim().toLowerCase()).join('|');
        seen.set(key, (seen.get(key) || 0) + 1);
    }
    const duplicate_warnings = [];
    for (const [key, count] of seen) {
        if (count > 1) {
            duplicate_warnings.push({ line: key.split('|')[0].slice(0, 60), count });
        }
    }

    return {
        is_quote: ok.some(d => d.is_quote === true),
        items,
        aggregates,
        duplicate_warnings,
        pages_merged: ok.length,
    };
}

/**
 * v0.5.0 结构化提取: 单张/多页报价单图片 → JSON条目(对齐合同侧模式)
 *
 * @param {string[]|string} imageInputs - 图片列表(base64 data URI / URL / 本地路径)
 * @param {object} options - 透传 visionExtractText({provider?, model?, apiKey?, baseUrl?, maxTokens})
 * @returns {Promise<{success, mode?: 'structured', data?: {is_quote,items,aggregates,duplicate_warnings,pages_merged},
 *            raw_text?, pages_total, pages_success, json_parse_failures?, provider?, model?, usage?,
 *            fallback_to_text?, error?}>}
 * 失败时: 所有页 JSON 解析失败 → fallback_to_text=true 且带出 raw_text, 调用方应回退文本路径;
 *        网络层全败 → 普通 success:false; 非报价单 → success:false(不回退)
 */
export async function extractQuoteStructuredFromImages(imageInputs, options = {}) {
    const inputs = Array.isArray(imageInputs) ? imageInputs : [imageInputs];
    const pages = [];
    let usage = null;
    let provider = null;
    let model = null;

    for (let i = 0; i < inputs.length; i++) {
        const r = await visionExtractText(inputs[i], QUOTE_STRUCTURED_PROMPT, options);
        if (r.usage && !usage) usage = r.usage;
        if (r.provider && !provider) { provider = r.provider; model = r.model; }
        if (!r.success) {
            pages.push({ page: i + 1, success: false, error: r.error });
            continue;
        }
        const data = parseLooseJSON(r.text);
        pages.push({ page: i + 1, success: true, data, raw_text: r.text });
    }

    const okPages = pages.filter(p => p.success);
    const rawText = okPages.map(p => p.raw_text).join('\n');

    if (okPages.length === 0) {
        return {
            success: false,
            pages_total: inputs.length,
            pages_success: 0,
            error: pages.find(p => p.error)?.error || `所有 ${inputs.length} 张图片结构化提取失败`,
            details: pages.map(p => ({ page: p.page, error: p.error })),
        };
    }

    const parsedDatas = okPages.map(p => p.data).filter(Boolean);

    // 所有成功页 JSON 解析失败 → 结构化不可用,交回调用方走文本路径(带出原文避免二次调用)
    if (parsedDatas.length === 0) {
        return {
            success: false,
            fallback_to_text: true,
            raw_text: rawText,
            pages_total: inputs.length,
            pages_success: okPages.length,
            error: '结构化输出JSON解析失败——建议回退文本提取路径',
            usage, provider, model,
        };
    }

    // 非报价单闸门: 所有成功解析页都自报非报价单(不回退,直接明确报错)
    if (parsedDatas.every(d => d.is_quote === false)) {
        return {
            success: false,
            pages_total: inputs.length,
            pages_success: okPages.length,
            error: '图片不是装修报价单,请上传报价明细页',
            usage, provider, model,
        };
    }

    const merged = mergeQuotePages(parsedDatas);
    return {
        success: true,
        mode: 'structured',
        data: merged,
        raw_text: rawText,
        pages_total: inputs.length,
        pages_success: okPages.length,
        json_parse_failures: okPages.length - parsedDatas.length,
        usage, provider, model,
    };
}
