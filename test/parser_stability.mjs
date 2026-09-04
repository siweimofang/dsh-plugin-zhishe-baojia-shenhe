// parser_stability.mjs — 解析稳定性与单位错配守卫回归测试 (0904 P7)
// 背景实景: 视觉OCR对同一行的转写存在变体(如 元/m 4.8m vs 元/延米 4.8延米),
// 旧词表缺「延米/片」导致整行丢弃 → "每轮条目数漂移"的提取不稳定假象。
// 本测试用合成变体用例锁定: ①变体行全部可解析 ②解析恒等 ③汇总行正确丢弃
// ④单位错配守卫(不同纲→unknown, 同纲不同写法→正常比价, 费率%不受影响)。
// 运行: node test/parser_stability.mjs  (退出码非0=失败)
import assert from 'node:assert/strict';
import { parseQuoteText } from '../lib/quote_parser.js';
import { auditItem } from '../lib/engines/anomaly_engine.js';
import { loadBenchmark, buildKeywordIndex } from '../../zhishe-common/lib/benchmark.js';

let passed = 0;
function ok(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); process.exitCode = 1; }
}

// ---------- 1. 转写变体全部可解析 ----------
console.log('[1] 转写变体可解析');
const VARIANTS = [
  ['橱柜地柜 980.00元/m 4.8m', 'm'],
  ['橱柜地柜 980.00元/延米 4.8延米', '延米'],
  ['厨房墙砖 11.80元/片 130片', '片'],
  ['乳胶漆 520.00元/桶 2桶', '桶'],
  ['开关插座 800.00元/项 5项', '项'],
  ['入户门套口 165.00元/米', '米'],
  ['主材运输及管理费 10%', '%'],
];
for (const [line, unit] of VARIANTS) {
  ok(`「${line}」→1条 unit=${unit}`, () => {
    const items = parseQuoteText(line);
    assert.equal(items.length, 1, `解析出${items.length}条`);
    assert.equal(items[0].unit, unit);
  });
}

// ---------- 2. 变体解析恒等(稳定性核心断言) ----------
console.log('[2] 同一行两个转写变体 → 恒等解析(价/量一致, 单位同纲)');
ok('m变体 vs 延米变体恒等', () => {
  const a = parseQuoteText('橱柜地柜 980.00元/m 4.8m')[0];
  const b = parseQuoteText('橱柜地柜 980.00元/延米 4.8延米')[0];
  assert.equal(a.unit_price, b.unit_price);
  assert.equal(a.quantity, b.quantity);
  assert.equal(a.total, b.total);
  assert.equal(a.name, b.name);
});
ok('㎡变体 vs 平米变体恒等', () => {
  const a = parseQuoteText('防水工程 75元/㎡ 30㎡ 2250元')[0];
  const b = parseQuoteText('防水工程 75元/平米 30平米 2250元')[0];
  assert.equal(a.unit_price, b.unit_price);
  assert.equal(a.quantity, b.quantity);
});

// ---------- 3. 汇总行必须丢弃(不是报价条目) ----------
console.log('[3] 汇总行丢弃');
ok('小计/合计/总价 全部不产条目', () => {
  const agg = '小计 5896.00元\n小计 = 675.00元\n主材合计 35835.50元\n主材价格总计 39419.05元\n工程总价（基础+主材） 0.00元';
  assert.equal(parseQuoteText(agg).length, 0);
});

// ---------- 4. 单位错配守卫(auditItem) ----------
console.log('[4] 单位错配守卫');
const benchmark = loadBenchmark();
const idx = buildKeywordIndex(benchmark);
const audit = (name, unitPrice, unit) =>
  auditItem({ name, unit_price: unitPrice, unit, quantity: null, total: null }, '沈阳', '中档', idx, benchmark);

ok('不同纲: 瓷砖 元/片 vs 基准㎡ → unknown(单位不一致), 不数值比价', () => {
  const r = audit('厨房墙砖', 11.8, '片');
  assert.equal(r.status, 'unknown');
  assert.match(r.message, /单位不一致/);
});
ok('同纲异写: 橱柜 元/延米 vs 基准元/延米 → 正常比价(不unknown)', () => {
  const r = audit('橱柜地柜', 980, '元/延米');
  assert.notEqual(r.status, 'unknown');
  assert.equal(r.status, 'pass');
});
ok('同纲裸单位: 橱柜 延米 vs 基准元/延米 → 正常比价', () => {
  const r = audit('橱柜地柜', 980, '延米');
  assert.equal(r.status, 'pass');
});
ok('费率%不受守卫影响: 管理费10% → warning_high(费率型费用)', () => {
  const r = audit('主材运输及管理费', 10, '%');
  assert.equal(r.status, 'warning_high');
  assert.match(r.message, /费率型费用/);
});

console.log(process.exitCode ? `\n${passed} 项通过, 存在失败` : `\n全部 ${passed} 项断言通过`);
