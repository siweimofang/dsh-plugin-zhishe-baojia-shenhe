/**
 * 知设装修报价审核插件 v0.3.0
 *
 * 装修报价单智能审核与风险识别
 *
 * v0.3.0: 接入 rc.8 视觉能力
 * - 新增 quote_image 参数: 报价单截图/照片 → V4-Flash-Vision-Exp OCR → 审核
 * - 新增 baojia_image_audit 工具: 纯图片审核(无需手动提取文本)
 * - 支持多页报价单(多张图片合并审核)
 * - 双轨视觉: DSH Harness端截图 + DeepSeek API云端推理
 *
 * v0.2.0: 基准价格库 + 异常引擎
 * v0.1.0: 核心逻辑拆分至独立模块
 *
 * 注册工具: baojia_shenhe / baojia_image_audit / baojia_item_check
 */

import { parseQuoteText } from './quote_parser.js';
import { auditQuote, formatAuditReport, loadBenchmark } from './engines/anomaly_engine.js';
import { extractQuoteFromImage, extractQuoteFromImages } from './vision/quote_ocr.js';

export const name = "zhishe-baojia-shenhe";

export function inject() {
  return {
    tools: [
      {
        name: "baojia_shenhe",
        description: "装修报价审核:支持文本或图片输入,智能识别异常单价、漏项、价格偏差,生成审核报告。图片输入会调用视觉模型自动提取报价文本后审核。",
        parameters: {
          type: "object",
          properties: {
            quote_text: {
              type: "string",
              description: "报价单文本内容(与quote_image二选一)。每行一个项目。格式如:\n水电改造 55元/㎡ 90㎡ 4950元\n防水工程 75元/㎡ 30㎡ 2250元\n管理费 8%",
            },
            quote_image: {
              type: "string",
              description: "报价单图片(与quote_text二选一)。支持:base64 data URI / 图片URL / 本地文件路径。会调用视觉模型自动提取文本后审核。",
            },
            city: {
              type: "string",
              description: "所在城市,默认沈阳。支持:沈阳/大连/长春/哈尔滨/北京/上海/广州/深圳/杭州/成都/南京/武汉/西安",
            },
            tier: {
              type: "string",
              description: "装修档次:经济/中端/高端/豪华,默认中端",
            },
            area: {
              type: "number",
              description: "房屋建筑面积(平方米),可选",
            },
          },
          required: [],
        },
      },
      {
        name: "baojia_image_audit",
        description: "报价单图片审核(专用):上传一张或多张报价单截图/照片,自动OCR提取+审核。适合用户直接拍照上传的场景。",
        parameters: {
          type: "object",
          properties: {
            images: {
              type: "array",
              items: { type: "string" },
              description: "报价单图片列表,每项支持:base64 data URI / 图片URL / 本地文件路径。多张图片会合并审核(适合多页报价单)。",
            },
            city: {
              type: "string",
              description: "所在城市,默认沈阳",
            },
            tier: {
              type: "string",
              description: "装修档次:经济/中端/高端/豪华,默认中端",
            },
            area: {
              type: "number",
              description: "房屋建筑面积(平方米),可选",
            },
          },
          required: ["images"],
        },
      },
      {
        name: "baojia_item_check",
        description: "单项价格查询:查询某个装修项目的合理价格区间",
        parameters: {
          type: "object",
          properties: {
            item_name: {
              type: "string",
              description: "装修项目名称,如'防水工程'、'地砖铺贴'、'吊顶'",
            },
            city: { type: "string", description: "城市,默认沈阳" },
            tier: { type: "string", description: "档次,默认中端" },
          },
          required: ["item_name"],
        },
      },
    ],
  };
}

export const Config = {
  knowledgePath: "data/knowledge.json",
};

export function apply() {
  return {
    /**
     * 报价审核 - 支持文本或图片输入
     */
    baojia_shenhe: async (params) => {
      const { quote_text, quote_image, city = '沈阳', tier = '中端', area = null } = params;

      // 图片输入 → 视觉OCR提取文本
      let finalText = quote_text;
      let ocrMeta = null;

      if (quote_image && !quote_text) {
        const ocrResult = await extractQuoteFromImage(quote_image);
        if (!ocrResult.success) {
          return { status: "error", message: `图片提取失败: ${ocrResult.error}` };
        }
        finalText = ocrResult.text;
        ocrMeta = {
          source: 'image',
          model: ocrResult.model,
          usage: ocrResult.usage,
        };
      }

      if (!finalText || finalText.trim().length < 5) {
        return {
          status: "error",
          message: "请提供报价单内容。支持两种方式:\n1. quote_text: 直接输入文本\n2. quote_image: 上传报价单截图(自动OCR提取)",
        };
      }

      try {
        const report = auditQuote(finalText, { city, tier, area });
        const formatted = formatAuditReport(report);
        return {
          status: "success",
          report,
          formatted,
          ...(ocrMeta && { ocr: ocrMeta }),
        };
      } catch (err) {
        return { status: "error", message: `审核过程出错: ${err.message}` };
      }
    },

    /**
     * 报价单图片审核(专用) - 多张图片合并审核
     */
    baojia_image_audit: async (params) => {
      const { images, city = '沈阳', tier = '中端', area = null } = params;

      if (!images || !Array.isArray(images) || images.length === 0) {
        return { status: "error", message: "请提供至少一张报价单图片" };
      }

      // 视觉OCR提取
      const ocrResult = images.length === 1
        ? await extractQuoteFromImage(images[0])
        : await extractQuoteFromImages(images);

      if (!ocrResult.success) {
        return {
          status: "error",
          message: `图片提取失败: ${ocrResult.error}`,
          ...(ocrResult.details && { details: ocrResult.details }),
        };
      }

      const finalText = ocrResult.text;

      try {
        const report = auditQuote(finalText, { city, tier, area });
        const formatted = formatAuditReport(report);
        return {
          status: "success",
          report,
          formatted,
          ocr: {
            source: 'image',
            model: ocrResult.model || 'multi-page',
            pages_total: ocrResult.pages_total || 1,
            pages_success: ocrResult.pages_success || 1,
            extracted_text: finalText,
            usage: ocrResult.usage || null,
          },
        };
      } catch (err) {
        return { status: "error", message: `审核过程出错: ${err.message}` };
      }
    },

    /**
     * 单项价格查询
     */
    baojia_item_check: async (params) => {
      const { item_name, city = '沈阳', tier = '中端' } = params;

      if (!item_name) {
        return { status: "error", message: "请提供项目名称" };
      }

      try {
        const benchmark = loadBenchmark();
        const cityCoeff = benchmark.city_coefficients[city] || 1.0;
        const tierMult = benchmark.tier_multipliers[tier] || 1.0;

        let found = null;
        for (const [cat, items] of Object.entries(benchmark.items)) {
          for (const [iname, spec] of Object.entries(items)) {
            if (iname.includes(item_name) || item_name.includes(iname) ||
                spec.keywords.some(kw => item_name.includes(kw) || kw.includes(item_name))) {
              found = { category: cat, name: iname, spec };
              break;
            }
          }
          if (found) break;
        }

        if (!found) {
          return {
            status: "not_found",
            message: `未找到「${item_name}」的基准价格。已收录项目: ${Object.values(benchmark.items).flatMap(i => Object.keys(i)).join('、')}`,
          };
        }

        const min = Math.round(found.spec.min * cityCoeff * tierMult * 100) / 100;
        const max = Math.round(found.spec.max * cityCoeff * tierMult * 100) / 100;
        const median = Math.round(found.spec.median * cityCoeff * tierMult * 100) / 100;

        return {
          status: "success",
          item: found.name,
          category: found.category,
          unit: found.spec.unit,
          price_range: { min, max, median },
          city, tier,
          message: `「${found.name}」在${city}${tier}档次的合理价格区间: ${min}-${max} ${found.spec.unit}(中位数 ${median})`,
        };
      } catch (err) {
        return { status: "error", message: `查询出错: ${err.message}` };
      }
    },
  };
}
