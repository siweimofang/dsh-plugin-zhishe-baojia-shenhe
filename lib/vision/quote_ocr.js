/**
 * 报价单图片OCR模块 - 基于 DeepSeek V4-Flash-Vision-Exp
 *
 * 将报价单截图/照片转为结构化文本,供 quote_parser.js 消费
 *
 * 支持三种图片传入:
 *   1. base64 内联 (data:image/png;base64,...)
 *   2. 外部 URL
 *   3. 本地文件路径 (自动转 base64)
 *
 * 成本: 一张图最多 384 tokens, 按 Flash 价格, 单次 < 0.01 元
 * 铁律: thinking:disabled 已强制(0903)——DS 默认开思考会烧光 max_tokens 返回空正文
 * 0903 Step2: 抽出通用 visionExtractText(prompt 参数化),合同提取(contract_ocr.js)复用同一底层
 */

import { readFileSync } from 'fs';
import { extname } from 'path';

const VISION_MODEL = 'deepseek-v4-flash-vision-exp';
const VISION_API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * 报价单图片专用提取 prompt
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
 * 通用视觉提取: 给定 prompt 从单图提取文本(报价/合同共用底层)
 *
 * @param {string} imageInput - base64 data URI / URL / 本地文件路径
 * @param {string} prompt - 提取用 prompt
 * @param {object} options - {apiKey, baseUrl, maxTokens=2048}
 * @returns {Promise<{success: boolean, text?: string, error?: string}>}
 * 返回文本以 "ERROR:" 开头时视为图片类型不符闸门,转 success:false
 */
export async function visionExtractText(imageInput, prompt, options = {}) {
    const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        return {
            success: false,
            error: '未配置 DEEPSEEK_API_KEY 环境变量。视觉OCR需要DeepSeek API Key。可通过以下方式获取文本:\n1. 设置环境变量: set DEEPSEEK_API_KEY=sk-xxx\n2. 直接使用文本参数传入内容',
        };
    }

    const baseUrl = options.baseUrl || VISION_API_URL;
    const maxTokens = options.maxTokens || 2048;

    let imageContent;
    try {
        imageContent = buildImageContent(imageInput);
    } catch (err) {
        return { success: false, error: err.message };
    }

    const body = JSON.stringify({
        model: VISION_MODEL,
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
        thinking: { type: 'disabled' }, // DS铁律(0903): vision-exp默认开思考, 2048预算会被思考烧光返回空正文, 生产必须禁用
    });

    try {
        const resp = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body,
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
            model: VISION_MODEL,
            usage: data.usage || null,
        };
    } catch (err) {
        return { success: false, error: `视觉API调用异常: ${err.message}` };
    }
}

/**
 * 报价单图片提取(薄壳,兼容原签名)
 */
export async function extractQuoteFromImage(imageInput, options = {}) {
    return visionExtractText(imageInput, QUOTE_OCR_PROMPT, options);
}

/**
 * 批量提取: 支持多张图片(如报价单有多页)
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

    // 合并所有页面的文本
    const combinedText = successResults.map(r => r.text).join('\n');
    return {
        success: true,
        text: combinedText,
        pages_total: imageInputs.length,
        pages_success: successResults.length,
        details: results,
    };
}
