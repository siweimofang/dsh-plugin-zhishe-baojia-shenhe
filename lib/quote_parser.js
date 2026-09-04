// quote_parser.js - 装修报价单文本解析器
// 从非结构化文本中提取分项报价条目

/**
 * 解析报价单文本,提取分项条目
 * 支持格式:
 *   "水电改造 55元/㎡ 90㎡ 4950元"
 *   "防水工程: 75元/平 × 30平 = 2250元"
 *   "地砖铺贴 60元/㎡"
 *   "管理费 8%"
 *
 * @param {string} text - 报价单文本
 * @returns {Array<{name, unit_price, unit, quantity, total, raw}>}
 */
export function parseQuoteText(text) {
  const items = [];
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const item = parseLine(line);
    if (item) items.push(item);
  }

  return items;
}

function parseLine(line) {
  // 单位词表: 长词在前(延米>米, 平米/平方米>平); 0904修复——橱柜行转写为
  // "980.00元/延米 4.8延米"时因词表无"延米"整行丢失(每轮-2条,提取不稳定假象);
  const U = '㎡|m²|平米|平方米|延米|米|m|项|个|根|樘|套|片|平|块|台|扇|卷|张|桶|次|位|架|吨|kg|%';

  // 模式1: "项目名 单价 单位 数量 总价"
  // 例: "水电改造 55元/㎡ 90㎡ 4950元"
  let m = line.match(
    new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*元?\\s*[/\\/每]\\s*(${U})\\s*(?:×?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:${U}))?\\s*(?:[=＝]\\s*(\\d+(?:\\.\\d+)?))?\\s*元?`)
  );
  if (m) {
    return normalizeItem(m[1].trim(), parseFloat(m[2]), m[3], m[4] ? parseFloat(m[4]) : null, m[5] ? parseFloat(m[5]) : null, line);
  }

  // 模式2: "项目名: 单价×数量=总价"
  m = line.match(
    new RegExp(`^(.+?)[:：]\\s*(\\d+(?:\\.\\d+)?)\\s*元?\\s*[/\\/每]?\\s*(${U})?\\s*[×xX*]\\s*(\\d+(?:\\.\\d+)?)\\s*[=＝]\\s*(\\d+(?:\\.\\d+)?)\\s*元?`)
  );
  if (m) {
    return normalizeItem(m[1].trim(), parseFloat(m[2]), m[3] || '项', parseFloat(m[4]), parseFloat(m[5]), line);
  }

  // 模式3: "项目名 单价元/单位" (无数量和总价)
  m = line.match(
    new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*元?\\s*[/\\/每]\\s*(${U})`)
  );
  if (m) {
    return normalizeItem(m[1].trim(), parseFloat(m[2]), m[3], null, null, line);
  }

  // 模式4: 百分比费用 "管理费 8%"
  m = line.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*%/);
  if (m) {
    return normalizeItem(m[1].trim(), parseFloat(m[2]), '%', null, null, line);
  }

  return null;
}

function normalizeItem(name, unitPrice, unit, quantity, total, raw) {
  // 清理项目名
  name = name.replace(/^[\d\d+\-、.．]+\s*/, '').trim();
  if (!name || name.length < 2) return null;

  // 自动计算总价
  if (total === null && quantity !== null) {
    total = Math.round(unitPrice * quantity * 100) / 100;
  }

  return { name, unit_price: unitPrice, unit, quantity, total, raw };
}

/**
 * 从结构化JSON报价单中提取条目
 * @param {Array|Object} data - 报价单JSON
 * @returns {Array}
 */
export function parseQuoteJSON(data) {
  if (Array.isArray(data)) return data;
  if (data && data.items && Array.isArray(data.items)) return data.items;
  if (data && data.entries && Array.isArray(data.entries)) return data.entries;
  return [];
}

/**
 * v0.5.0 短板②: 结构化OCR条目直通归一器
 * 视觉模型结构化输出(quote_ocr.QUOTE_STRUCTURED_PROMPT 的 items) → 与 parseQuoteText
 * 完全同构的条目 → auditQuote 数组直通(engines/anomaly_engine.js 原生支持数组),下游零改动。
 * 原则: 视觉只产出图面事实; 类目匹配/比价/缺项检查全部留给规则引擎。
 *
 * 与 parseQuoteText 同规则: 名称去掉行首序号、过短名丢弃、quantity存在且total缺失时自动补算。
 * unit 缺失时保留 null(引擎守卫判「单位缺失」unknown,不猜单位——猜错纲比不比更危险)。
 *
 * @param {Array<{name, spec, unit, quantity, unit_price, total, is_fee_percent, raw}>} items
 * @returns {Array<{name, unit_price, unit, quantity, total, raw}>}
 */
export function parseItemsFromStructured(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    let name = String(it.name ?? '').replace(/^[\d\d+\-、.．]+\s*/, '').trim();
    if (!name || name.length < 2) continue; // 与文本路径同规则

    const isFee = it.is_fee_percent === true;
    const unit = isFee ? '%' : (it.unit == null ? null : (String(it.unit).trim() || null));
    const toNum = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    const unitPrice = toNum(it.unit_price);
    const quantity = toNum(it.quantity);
    let total = toNum(it.total);

    if (unitPrice === null && total === null) continue; // 无价可比(纯文字行)
    if (total === null && unitPrice !== null && quantity !== null) {
      total = Math.round(unitPrice * quantity * 100) / 100;
    }
    out.push({ name, unit_price: unitPrice, unit, quantity, total, raw: it.raw ?? null });
  }
  return out;
}
