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
 * 0903: 接入内嵌避坑精简库(P2 Step1)——审核报告新增「避坑提示」章节(161条规则匹配,
 *       severity排序+topN硬限),单项查询附带 top1 坑项提示
 * 0903: P2 Step2 新增 hetong_shenhe 合同审核——视觉条款提取(付款/增项/工期/保修/违约)
 *       + 行业惯例与法定底线规则(保修2年/防水5年) + PII打码红档护栏 + 签约避坑tips
 * 0904: P2 幻觉拦截(真实评测0809批次根因)——报价OCR复读循环检测截断(quote_ocr.js),
 *       警示透传进报告; OCR成功但解析零条目时明示"图片无法解析"并带出原始OCR文本,
 *       不再返回误导性的"请检查输入格式"
 * 0905: v0.5.0 双路线+结构化(短板①②修复,依据0905投喂文章③⑧⑨)——
 *       视觉供应商可切换(DeepSeek/百炼千问VL, vision/providers.js, VISION_PROVIDER环境变量),
 *       报价OCR新增结构化提取路径(QUOTE_STRUCTURED_PROMPT→JSON→parseItemsFromStructured→
 *       auditQuote数组直通, 正则文本路径保留为兜底), 新参数 vision_structured(默认false,
 *       行为与v0.4.4完全一致, 切默认前提: vs_vision对拍召回不低于基线);
 *       合同OCR PII检出且供应商非百炼时附 compliance_warning(提示级, 硬路由待spec)
 * 0905: v0.5.1 批次二闲时调度标记(短板③, 依据文章④⑤)——vision/offpeak.js(北京时间
 *       9-12/14-18高峰, 与后端cost_router.py同源口径, 宿主时区无关); 三个提取入口的
 *       返回meta附offpeak标记(peak/offpeak/beijing_time/note)——只标记不阻塞,
 *       批量任务(多页/评测/回归)按标记错峰跑
 *
 * 注册工具: baojia_shenhe / baojia_image_audit / baojia_item_check / hetong_shenhe
 */

import { parseQuoteText, parseItemsFromStructured } from './quote_parser.js';
import { auditQuote, formatAuditReport, loadBenchmark } from './engines/anomaly_engine.js';
import { extractQuoteFromImage, extractQuoteFromImages, extractQuoteStructuredFromImages } from './vision/quote_ocr.js';
import { auditGotchas, formatGotchaSection, topGotchaHint } from './gotchas/gotchas_engine.js';
import { extractContractFromImages, maskPII } from './vision/contract_ocr.js';
import { extractClausesFromText, auditContract, contractGotchaTips, formatContractReport } from './engines/contract_engine.js';

/**
 * 0904 P2: 统一抽取复读警示——多图路径为 ocr_warnings 数组,单图路径为 repetition 元数据
 */
function repetitionWarningsFromOcr(ocrResult) {
  if (Array.isArray(ocrResult?.ocr_warnings)) return ocrResult.ocr_warnings;
  if (ocrResult?.repetition?.repeat_groups > 0) {
    return (ocrResult.repetition.trimmed || []).map(t => ({ page: 1, line: t.line, count: t.count }));
  }
  return [];
}

/**
 * 0904 P2: 复读警示用户可读文案(空数组返回空串)
 */
function formatRepetitionCaution(warnings) {
  if (!warnings || warnings.length === 0) return '';
  const parts = warnings.map(w => `第${w.page}页「${w.line}」×${w.count}`);
  return `【OCR警示】检测到复读循环并已自动截断(${parts.join('; ')})——提取结果可能不完整,建议人工核对原单。`;
}

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
            vision_structured: {
              type: "boolean",
              description: "v0.5.0可选: 结构化视觉提取(视觉模型直接输出JSON条目,单引擎比价更稳;失败自动回退文本路径)。默认false。",
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
            vision_structured: {
              type: "boolean",
              description: "v0.5.0可选: 结构化视觉提取(失败自动回退文本路径)。默认false。",
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
      {
        name: "hetong_shenhe",
        description: "装修合同审核:上传合同条款页截图(必须是脱敏件!)自动提取关键条款(付款比例/增项上限/工期/保修期/违约责任),按行业惯例与法定底线(保修2年/防水5年)审核,输出风险清单+签约避坑建议。红线:合同原件属红档禁止上传,只传涂掉姓名/电话/证件号的脱敏件;检出未脱敏联系方式会自动打码并红档警告。",
        parameters: {
          type: "object",
          properties: {
            contract_images: {
              type: "array",
              items: { type: "string" },
              description: "合同条款页图片列表(1-6张,多页自动合并)。支持:base64 data URI / 图片URL / 本地文件路径。必须为脱敏件(涂掉姓名/电话/证件号)。",
            },
            contract_text: {
              type: "string",
              description: "合同条款文本(与contract_images二选一),可直接粘贴付款/增项/保修/违约等关键条款原文。",
            },
          },
          required: [],
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
      const { quote_text, quote_image, city = '沈阳', tier = '中端', area = null, vision_structured = false } = params;

      // 图片输入 → 视觉提取(v0.5.0: vision_structured=true 时结构化优先,失败自动回退文本路径)
      let finalText = quote_text;
      let finalItems = null; // v0.5.0 结构化直通条目(auditQuote 数组输入)
      let ocrMeta = null;
      let ocrWarnings = [];
      let structuredFallback = null;

      if (quote_image && !quote_text && vision_structured) {
        const sr = await extractQuoteStructuredFromImages([quote_image]);
        if (sr.success) {
          const items = parseItemsFromStructured(sr.data.items);
          if (items.length > 0) {
            finalItems = items;
            // 跨页整组重复警示 → 对齐复读警示通道(page=0 标记非OCR复读)
            ocrWarnings = (sr.data.duplicate_warnings || []).map(w => ({ page: 0, line: w.line, count: w.count }));
            ocrMeta = {
              source: 'image_structured',
              provider: sr.provider,
              model: sr.model,
              usage: sr.usage,
              offpeak: sr.offpeak || null,
              pages_total: sr.pages_total,
              pages_success: sr.pages_success,
              items_from_vision: sr.data.items.length,
              json_parse_failures: sr.json_parse_failures || 0,
              duplicate_warnings: sr.data.duplicate_warnings || [],
              ocr_warnings: ocrWarnings,
            };
          }
        } else if (sr.fallback_to_text) {
          structuredFallback = '结构化JSON解析失败,已自动回退文本提取路径';
        }
      }

      if (quote_image && !quote_text && !finalItems) {
        const ocrResult = await extractQuoteFromImage(quote_image);
        if (!ocrResult.success) {
          return { status: "error", message: `图片提取失败: ${ocrResult.error}` };
        }
        finalText = ocrResult.text;
        ocrWarnings = repetitionWarningsFromOcr(ocrResult);
        ocrMeta = {
          source: 'image',
          provider: ocrResult.provider,
          model: ocrResult.model,
          usage: ocrResult.usage,
          offpeak: ocrResult.offpeak || null,
          ocr_warnings: ocrWarnings,
          ...(structuredFallback && { structured_fallback: structuredFallback }),
        };
      }

      if (!finalItems && (!finalText || finalText.trim().length < 5)) {
        return {
          status: "error",
          message: "请提供报价单内容。支持两种方式:\n1. quote_text: 直接输入文本\n2. quote_image: 上传报价单截图(自动OCR提取)",
        };
      }

      try {
        // v0.5.0: 结构化直通(数组)或文本路径(字符串), 引擎同构处理
        const report = finalItems
          ? auditQuote(finalItems, { city, tier, area })
          : auditQuote(finalText, { city, tier, area });
        // 0904 P2: 图片来源下解析零条目 → 明示图片无法解析,带出OCR原文供人工核对
        if (!report.success && ocrMeta) {
          return {
            status: "parse_empty",
            message: "OCR提取完成,但未从中解析出任何有效报价条目——图片可能不清晰、内容非报价单,或视觉模型输出异常。请人工核对或重新拍照(光线充足、单页平拍)。"
              + (ocrWarnings.length ? '\n' + formatRepetitionCaution(ocrWarnings) : ''),
            extracted_text: finalText,
            ocr: ocrMeta,
          };
        }
        if (ocrMeta) {
          report.extraction_quality = finalItems
            ? { mode: 'structured', entries_parsed: report.input_items }
            : {
                lines_extracted: finalText.split(/\n/).filter(l => l.trim()).length,
                entries_parsed: report.input_items,
              };
          if (ocrWarnings.length) report.ocr_warnings = ocrWarnings;
        }
        report.gotchas = auditGotchas(report); // P2 Step1: 内嵌避坑精简库
        const caution = ocrMeta ? formatRepetitionCaution(ocrWarnings) : '';
        const formatted = (caution ? caution + '\n\n' : '')
          + formatAuditReport(report)
          + (report.gotchas.enabled ? '\n\n' + formatGotchaSection(report.gotchas) : '');
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
      const { images, city = '沈阳', tier = '中端', area = null, vision_structured = false } = params;

      if (!images || !Array.isArray(images) || images.length === 0) {
        return { status: "error", message: "请提供至少一张报价单图片" };
      }

      // v0.5.0: vision_structured=true 时结构化优先,失败自动回退文本路径
      let finalItems = null;
      let structuredFallback = null;
      let ocrResult = null;
      if (vision_structured) {
        const sr = await extractQuoteStructuredFromImages(images);
        if (sr.success) {
          const items = parseItemsFromStructured(sr.data.items);
          if (items.length > 0) {
            finalItems = items;
            ocrResult = {
              success: true,
              provider: sr.provider,
              model: sr.model,
              usage: sr.usage,
              offpeak: sr.offpeak || null,
              pages_total: sr.pages_total,
              pages_success: sr.pages_success,
              items_from_vision: sr.data.items.length,
              json_parse_failures: sr.json_parse_failures || 0,
              ocr_warnings: (sr.data.duplicate_warnings || []).map(w => ({ page: 0, line: w.line, count: w.count })),
            };
          }
        } else if (sr.fallback_to_text) {
          structuredFallback = '结构化JSON解析失败,已自动回退文本提取路径';
        }
      }
      if (!ocrResult) {
        ocrResult = images.length === 1
          ? await extractQuoteFromImage(images[0])
          : await extractQuoteFromImages(images);
      }

      if (!ocrResult.success) {
        return {
          status: "error",
          message: `图片提取失败: ${ocrResult.error}`,
          ...(ocrResult.details && { details: ocrResult.details }),
        };
      }

      const finalText = ocrResult.text; // 结构化直通时为 undefined,审核走 finalItems
      const ocrWarnings = repetitionWarningsFromOcr(ocrResult);

      try {
        const report = finalItems
          ? auditQuote(finalItems, { city, tier, area })
          : auditQuote(finalText, { city, tier, area });
        // 0904 P2: OCR成功但解析零条目 → 明示图片无法解析(202整页幻觉批次的教训:
        // 上游"优雅降级"返回空报告,用户侧毫无感知),带出OCR原文供人工核对
        if (!report.success) {
          return {
            status: "parse_empty",
            message: "OCR提取完成,但未从中解析出任何有效报价条目——图片可能不清晰、内容非报价单,或视觉模型输出异常。请人工核对或重新拍照(光线充足、单页平拍)。"
              + (ocrWarnings.length ? '\n' + formatRepetitionCaution(ocrWarnings) : ''),
            extracted_text: finalText,
            ocr: {
              source: 'image',
              model: ocrResult.model || 'multi-page',
              pages_total: ocrResult.pages_total || 1,
              pages_success: ocrResult.pages_success || 1,
              ocr_warnings: ocrWarnings,
              usage: ocrResult.usage || null,
            },
          };
        }
        report.extraction_quality = finalItems
          ? { mode: 'structured', entries_parsed: report.input_items }
          : {
              lines_extracted: finalText.split(/\n/).filter(l => l.trim()).length,
              entries_parsed: report.input_items,
            };
        if (ocrWarnings.length) report.ocr_warnings = ocrWarnings;
        report.gotchas = auditGotchas(report); // P2 Step1: 内嵌避坑精简库
        const caution = formatRepetitionCaution(ocrWarnings);
        const formatted = (caution ? caution + '\n\n' : '')
          + formatAuditReport(report)
          + (report.gotchas.enabled ? '\n\n' + formatGotchaSection(report.gotchas) : '');
        return {
          status: "success",
          report,
          formatted,
          ocr: {
            source: finalItems ? 'image_structured' : 'image',
            provider: ocrResult.provider,
            model: ocrResult.model || 'multi-page',
            offpeak: ocrResult.offpeak || null,
            pages_total: ocrResult.pages_total || 1,
            pages_success: ocrResult.pages_success || 1,
            ...(finalItems
              ? { items_from_vision: ocrResult.items_from_vision, json_parse_failures: ocrResult.json_parse_failures || 0 }
              : { extracted_text: finalText }),
            ocr_warnings: ocrWarnings,
            usage: ocrResult.usage || null,
            ...(structuredFallback && { structured_fallback: structuredFallback }),
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
        const pitfall_hint = topGotchaHint(found.name); // P2 Step1: 附带 top1 坑项提示(可能为 null)

        return {
          status: "success",
          item: found.name,
          category: found.category,
          unit: found.spec.unit,
          price_range: { min, max, median },
          city, tier,
          pitfall_hint,
          message: `「${found.name}」在${city}${tier}档次的合理价格区间: ${min}-${max} ${found.spec.unit}(中位数 ${median})`,
        };
      } catch (err) {
        return { status: "error", message: `查询出错: ${err.message}` };
      }
    },

    /**
     * 合同审核 - 图片(视觉条款提取)或文本(启发式提取) (P2 Step2)
     */
    hetong_shenhe: async (params) => {
      const { contract_images, contract_text } = params;
      let clauses = null;
      let meta = null;
      let rawText = null;

      try {
        if (contract_images && Array.isArray(contract_images) && contract_images.length > 0) {
          const ocr = await extractContractFromImages(contract_images.slice(0, 6));
          meta = {
            source: 'image',
            pages_total: ocr.pages_total,
            pages_success: ocr.pages_success,
            pii: ocr.pii,
            usage: ocr.usage || null,
          };
          if (!ocr.success) {
            return { status: 'error', message: `合同图片提取失败: ${ocr.error}`, pii: ocr.pii };
          }
          clauses = ocr.data;
          rawText = ocr.raw_text || null;
          if (!clauses && rawText) clauses = extractClausesFromText(rawText); // JSON解析失败兜底启发式
          if (clauses && clauses.contact_info) delete clauses.contact_info; // 0904 补强:联系方式仅用于PII旗标(raw_text层已打码),不进报告
        } else if (contract_text && contract_text.trim().length >= 10) {
          const masked = maskPII(contract_text);
          clauses = extractClausesFromText(masked.masked);
          meta = { source: 'text', pii: { found: masked.found } };
        } else {
          return {
            status: 'error',
            message: '请提供合同内容: contract_images(脱敏截图1-6张,推荐)或 contract_text(粘贴条款文本)。\n红线: 合同原件属红档,只传涂掉姓名/电话/证件号的脱敏件。',
          };
        }

        if (!clauses || clauses.is_contract === false) {
          return { status: 'error', message: '未识别到装修合同条款,请确认上传的是合同条款页(脱敏件)或粘贴关键条款文本。' };
        }

        const piiFound = !!(meta && meta.pii && meta.pii.found && meta.pii.found.length);
        const audit = auditContract(clauses, { pii_found: piiFound });
        const tips = contractGotchaTips(clauses, audit);
        const formatted = formatContractReport(clauses, audit, tips, meta);
        return { status: 'success', clauses, audit, tips, formatted, ...(meta && { ocr: meta }) };
      } catch (err) {
        return { status: 'error', message: `合同审核出错: ${err.message}` };
      }
    },
  };
}
