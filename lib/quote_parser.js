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
  // 模式1: "项目名 单价 单位 数量 总价"
  // 例: "水电改造 55元/㎡ 90㎡ 4950元"
  let m = line.match(
    /^(.+?)\s+(\d+(?:\.\d+)?)\s*元?\s*[/\/每]\s*(㎡|平米|平方米|m|项|个|根|樘|套|%)\s*(?:×?\s*(\d+(?:\.\d+)?)\s*(?:㎡|平米|平方米|m|项|个|根|樘|套))?\s*(?:[=＝]\s*(\d+(?:\.\d+)?))?\s*元?/
  );
  if (m) {
    return normalizeItem(m[1].trim(), parseFloat(m[2]), m[3], m[4] ? parseFloat(m[4]) : null, m[5] ? parseFloat(m[5]) : null, line);
  }

  // 模式2: "项目名: 单价×数量=总价"
  m = line.match(
    /^(.+?)[:：]\s*(\d+(?:\.\d+)?)\s*元?\s*[/\/每]?\s*(㎡|平米|平方米|m|项|个|根|樘|套|%)?\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*[=＝]\s*(\d+(?:\.\d+)?)\s*元?/
  );
  if (m) {
    return normalizeItem(m[1].trim(), parseFloat(m[2]), m[3] || '项', parseFloat(m[4]), parseFloat(m[5]), line);
  }

  // 模式3: "项目名 单价元/单位" (无数量和总价)
  m = line.match(
    /^(.+?)\s+(\d+(?:\.\d+)?)\s*元?\s*[/\/每]\s*(㎡|平米|平方米|m|项|个|根|樘|套|%)/
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
