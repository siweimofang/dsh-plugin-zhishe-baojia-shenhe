/**
 * structured_vision.mjs - v0.5.0 离线单测(不联网,零API成本)
 *
 * 覆盖:
 *   [A] providers.js 供应商解析(默认/覆盖/百炼缺模型/未知供应商)
 *   [B] utils.js parseLooseJSON 容错
 *   [C] quote_parser.parseItemsFromStructured 结构化归一器
 *   [D] quote_ocr.mergeQuotePages 多页合并+跨页重复警示
 *   [E] auditQuote 数组直通端到端(单位不一致/单位缺失/单价缺失/费率/同纲归一)
 *
 * 运行: node test/structured_vision.mjs (package.json scripts.test 已串联)
 */
import { resolveVisionProvider } from '../lib/vision/providers.js';
import { parseLooseJSON } from '../lib/vision/utils.js';
import { mergeQuotePages } from '../lib/vision/quote_ocr.js';
import { parseItemsFromStructured } from '../lib/quote_parser.js';
import { auditQuote } from '../lib/engines/anomaly_engine.js';

let passCount = 0;
let failCount = 0;
function check(name, cond) {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}`); }
}

// 环境隔离: 保存→篡改→恢复
const ENV_BACKUP = { ...process.env };

// ============ [A] providers ============
console.log('[A] vision/providers.js');
{
  delete process.env.VISION_PROVIDER;
  delete process.env.BAILIAN_VL_MODEL;

  const r1 = resolveVisionProvider({ apiKey: 'test-key' });
  check('A1 缺省deepseek: model正确', r1.ok && r1.model === 'deepseek-v4-flash-vision-exp');
  check('A2 缺省deepseek: thinking:disabled 仅DS注入', r1.ok && r1.cfg.extraBody?.thinking?.type === 'disabled');
  check('A3 缺省deepseek: baseUrl=DS官方', r1.ok && r1.cfg.baseUrl === 'https://api.deepseek.com/chat/completions');

  const r2 = resolveVisionProvider({ apiKey: 'k', model: 'my-vl-model' });
  check('A4 options.model 逐次覆盖生效', r2.ok && r2.model === 'my-vl-model');

  process.env.VISION_PROVIDER = 'bailian';
  const r3 = resolveVisionProvider({ apiKey: 'k' });
  check('A5 bailian缺VL型号 → 报错并提示BAILIAN_VL_MODEL', !r3.ok && r3.error.includes('BAILIAN_VL_MODEL'));

  process.env.BAILIAN_VL_MODEL = 'test-vl-x';
  const r4 = resolveVisionProvider({ apiKey: 'k' });
  check('A6 bailian+VL型号: 解析通过', r4.ok && r4.model === 'test-vl-x');
  check('A7 bailian: baseUrl走dashscope兼容模式', r4.ok && r4.cfg.baseUrl.includes('dashscope'));
  check('A8 bailian: 不注入thinking(DS专属)', r4.ok && r4.cfg.extraBody == null);

  process.env.VISION_PROVIDER = 'nonexistent';
  const r5 = resolveVisionProvider({ apiKey: 'k' });
  check('A9 未知供应商 → 明确报错', !r5.ok && r5.error.includes('可选'));
}

// ============ [B] parseLooseJSON ============
console.log('[B] vision/utils.js');
{
  const j1 = parseLooseJSON('```json\n{"a":1}\n```');
  check('B1 剥```json围栏', j1 && j1.a === 1);
  const j2 = parseLooseJSON('提取结果如下：{"a":{"b":2}} 以上。');
  check('B2 前后杂语截取大括号', j2 && j2.a.b === 2);
  check('B3 纯文本 → null', parseLooseJSON('这不是JSON') === null);
}

// ============ [C] parseItemsFromStructured ============
console.log('[C] quote_parser.parseItemsFromStructured');
{
  const c1 = parseItemsFromStructured([
    { name: '1、厨房墙砖铺贴', unit: '片', unit_price: '11.8', quantity: 30, total: 354, raw: '厨房墙砖 11.8元/片' },
  ]);
  check('C1 全字段条目: 剥序号+数字归一', c1.length === 1 && c1[0].name === '厨房墙砖铺贴'
    && c1[0].unit_price === 11.8 && c1[0].quantity === 30 && c1[0].total === 354 && c1[0].unit === '片');

  const c2 = parseItemsFromStructured([{ name: '水电改造', unit: '㎡', unit_price: 55, quantity: 90, total: null }]);
  check('C2 total缺失自动补算(55×90=4950)', c2[0].total === 4950);

  const c3 = parseItemsFromStructured([{ name: '管理费', is_fee_percent: true, unit_price: 10, unit: '%', quantity: null, total: null }]);
  check('C3 费率条目: unit=%, 数量总价空', c3[0].unit === '%' && c3[0].unit_price === 10 && c3[0].quantity === null);

  const c4 = parseItemsFromStructured([{ name: '某项工程', unit: null, unit_price: 520, quantity: null, total: null }]);
  check('C4 单位缺失保留null(不猜单位)', c4[0].unit === null && c4[0].unit_price === 520);

  const c5 = parseItemsFromStructured([{ name: '说明文字行', unit: '项', unit_price: null, total: null }]);
  check('C5 无单价无总价 → 丢弃', c5.length === 0);

  check('C6 非数组输入 → 空数组', parseItemsFromStructured('bad').length === 0
    && parseItemsFromStructured(null).length === 0);
}

// ============ [D] mergeQuotePages ============
console.log('[D] vision/quote_ocr.mergeQuotePages');
{
  const d1 = mergeQuotePages([
    { is_quote: true, items: [{ name: '水电改造', unit: '㎡', unit_price: 55, quantity: 90, total: 4950 }], aggregates: [{ name: '小计', amount: 4950 }] },
    { is_quote: true, items: [{ name: '防水工程', unit: '㎡', unit_price: 75, quantity: 30, total: 2250 }], aggregates: [{ name: '总计', amount: 7200 }] },
  ]);
  check('D1 两页items/aggregates拼接+is_quote取或', d1.items.length === 2 && d1.aggregates.length === 2 && d1.is_quote === true);

  const dup = { name: '墙面基层处理', unit: '㎡', unit_price: 120, quantity: 50, total: 6000 };
  const d2 = mergeQuotePages([
    { is_quote: true, items: [dup], aggregates: [] },
    { is_quote: true, items: [{ ...dup }], aggregates: [] },
  ]);
  check('D2 跨页整组重复 → 警示不删', d2.items.length === 2 && d2.duplicate_warnings.length === 1);

  check('D3 空输入 → null', mergeQuotePages([]) === null && mergeQuotePages([null, null]) === null);
}

// ============ [E] auditQuote 数组直通(端到端) ============
console.log('[E] anomaly_engine.auditQuote 数组直通');
{
  const e1 = auditQuote([{ name: '厨房墙砖铺贴', unit_price: 11.8, unit: '片', quantity: 30, total: 354 }], { city: '沈阳', tier: '中档' });
  const r1 = e1.results[0];
  check('E1 异纲条目 → unknown+单位不一致(与文本路径同守卫)', r1.status === 'unknown' && r1.risk.label === '单位不一致');

  const e2 = auditQuote([{ name: '墙面基层处理', unit_price: 520, unit: null, quantity: null, total: null }], { city: '沈阳', tier: '中档' });
  const r2 = e2.results[0];
  check('E2 单位缺失 → unknown+单位缺失(不猜纲不假pass)', r2.status === 'unknown' && r2.risk.label === '单位缺失');

  const e3 = auditQuote([{ name: '垃圾清运', unit_price: null, unit: '项', quantity: null, total: 800 }], { city: '沈阳', tier: '中档' });
  const r3 = e3.results[0];
  check('E3 单价缺失 → unknown+单价缺失(拦截假pass)', r3.status === 'unknown' && r3.risk.label === '单价缺失');

  const e4 = auditQuote([{ name: '主材运输及管理费', unit_price: 10, unit: '%', quantity: null, total: null }], { city: '沈阳', tier: '中档' });
  const r4 = e4.results[0];
  check('E4 费率10% → warning_high(费率型费用, 坑0904回归)', r4.status === 'warning_high');

  const e5 = auditQuote([{ name: '橱柜地柜', unit_price: 980, unit: '延米', quantity: 4.8, total: 4704 }], { city: '沈阳', tier: '中档' });
  check('E5 同纲裸单位(延米) → 正常比价pass', e5.results[0].status === 'pass');

  const e6 = auditQuote([{ name: '水电改造', unit_price: 55, unit: '平米', quantity: 90, total: 4950 }], { city: '沈阳', tier: '中档' });
  check('E6 平米→㎡同纲归一 → 不判单位不一致', e6.results[0].risk.label !== '单位不一致');

  const e7 = auditQuote([], { city: '沈阳', tier: '中档' });
  check('E7 空数组 → success:false(原行为)', e7.success === false);
}

// 恢复环境
process.env = ENV_BACKUP;

console.log(`\n${failCount === 0 ? '✅' : '❌'} 结构化视觉链路: ${passCount + failCount} 项断言, 通过 ${passCount}, 失败 ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
