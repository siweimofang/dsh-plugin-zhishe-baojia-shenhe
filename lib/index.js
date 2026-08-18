/**
 * 知设装修报价审核插件 v0.3.0
 *
 * 装修报价单智能审核与风险识别
 *
 * v0.3.0: 核心逻辑拆分至独立模块
 * - 共享基础设施: zhishe-common (benchmark/risk)
 * - 领域引擎: engines/anomaly_engine.js
 *
 * 注册工具: baojia_shenhe / baojia_item_check
 */

import { parseQuoteText } from './quote_parser.js';
import { auditQuote, formatAuditReport, loadBenchmark } from './engines/anomaly_engine.js';

export const name = "zhishe-baojia-shenhe";

export function inject() {
  return {
    tools: [
      {
        name: "baojia_shenhe",
        description: "装修报价审核:输入报价单文本,智能识别异常单价、漏项、价格偏差,生成审核报告",
        parameters: {
          type: "object",
          properties: {
            quote_text: {
              type: "string",
              description: "报价单文本内容,每行一个项目。格式如:\n水电改造 55元/㎡ 90㎡ 4950元\n防水工程 75元/㎡ 30㎡ 2250元\n管理费 8%",
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
          required: ["quote_text"],
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
    baojia_shenhe: async (params) => {
      const { quote_text, city = '沈阳', tier = '中端', area = null } = params;

      if (!quote_text || quote_text.trim().length < 5) {
        return {
          status: "error",
          message: "请提供报价单内容。格式示例:\n水电改造 55元/㎡ 90㎡ 4950元\n防水工程 75元/㎡ 30㎡ 2250元",
        };
      }

      try {
        const report = auditQuote(quote_text, { city, tier, area });
        const formatted = formatAuditReport(report);
        return { status: "success", report, formatted };
      } catch (err) {
        return { status: "error", message: `审核过程出错: ${err.message}` };
      }
    },

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
