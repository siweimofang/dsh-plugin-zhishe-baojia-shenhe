/**
 * 视觉模块共享工具 - v0.5.0
 */

/**
 * 从模型返回文本中稳健解析 JSON(剥代码围栏/截取首尾大括号)
 * (自 contract_ocr.js 上移共享; v0.5.0 报价结构化OCR复用同一容错)
 */
export function parseLooseJSON(text) {
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
