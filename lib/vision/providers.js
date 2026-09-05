/**
 * 视觉供应商注册表 - v0.5.0 短板①修复(多路线,不绑定单一视觉模型)
 *
 * 文章依据(0905投喂): ③「不绑定单一视觉模型(千问VL+V4-Vision双备选),模型是可替换组件」
 * ⑧「每个入口都是出口」——DSH插件栈不能绑定DeepSeek。
 *
 * 用法:
 *   环境变量 VISION_PROVIDER=deepseek|bailian (缺省deepseek,与v0.4.x行为完全一致)
 *   options.provider / options.model / options.apiKey / options.baseUrl 可逐次覆盖
 *
 * bailian: 阿里云百炼 OpenAI兼容模式(dashscope compatible-mode)。
 *          VL型号不硬编码——以百炼控制台当前主力VL为准,经 BAILIAN_VL_MODEL 注入;
 *          合同红线「敏感件走百炼」(contract_ocr.js)依赖此路线存在。
 *
 * 铁律: thinking:disabled 仅对 DeepSeek 注入(0903实踩: vision-exp默认开思考,
 *       2048预算被思考烧光返回空正文); 千问VL不识别该参数,禁止透传。
 */

const PROVIDERS = {
    deepseek: {
        id: 'deepseek',
        label: 'DeepSeek V4-Flash-Vision-Exp',
        model: 'deepseek-v4-flash-vision-exp',
        baseUrl: 'https://api.deepseek.com/chat/completions',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        extraBody: { thinking: { type: 'disabled' } },
    },
    bailian: {
        id: 'bailian',
        label: '阿里云百炼 千问VL(合规路线)',
        model: null, // 不硬编码型号,经 BAILIAN_VL_MODEL 注入
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', // 以百炼文档为准
        apiKeyEnv: 'BAILIAN_API_KEY',
        extraBody: null,
    },
};

/**
 * 解析供应商ID(仅判路由, 不校验可用性)——供合规预检门判断生效路线
 * @param {object} options - {provider?}
 * @returns {string} 'deepseek' | 'bailian' | ...
 */
export function resolveProviderId(options = {}) {
    return String(options.provider || process.env.VISION_PROVIDER || 'deepseek');
}

/**
 * 解析一次视觉调用的生效配置
 * @param {object} options - {provider?, model?, apiKey?, baseUrl?}
 * @returns {{ok: true, cfg, model, apiKey} | {ok: false, error}}
 */
export function resolveVisionProvider(options = {}) {
    const pid = resolveProviderId(options);
    const cfg = PROVIDERS[pid];
    if (!cfg) {
        return { ok: false, error: `未知视觉供应商「${pid}」,可选: ${Object.keys(PROVIDERS).join(' / ')}` };
    }
    const model = options.model
        || (pid === 'bailian' ? (process.env.BAILIAN_VL_MODEL || '') : '')
        || cfg.model;
    if (!model) {
        return { ok: false, error: `视觉供应商「${pid}」未配置模型——请设置环境变量 BAILIAN_VL_MODEL(百炼控制台当前主力VL型号)` };
    }
    const apiKey = options.apiKey || process.env[cfg.apiKeyEnv] || '';
    if (!apiKey) {
        return { ok: false, error: `未配置 ${cfg.apiKeyEnv} 环境变量,视觉OCR(供应商:${pid})无法调用。也可直接使用文本参数传入报价内容` };
    }
    return { ok: true, cfg, model, apiKey };
}
