/**
 * gotchas_engine.js - 避坑匹配引擎（P2 Step1 内嵌精简库）
 *
 * 数据: 同目录 compact_v1.json（161 条精简坑库,全库 598 条的报价审核相关子集）
 * 策略: 立项书已拍板 = A 插件内嵌精简库——规则匹配(trigger_keywords 双向子串)
 *       + severity 排序 + topN 硬限;全库语义检索(gotchas_api)留作后续增强
 * 铁律: 本模块自足——只依赖 node:fs/path/url,不复制 engines/ 对 zhishe-common
 *       的外部相对路径耦合;数据文件随包发布(files:["lib"] 自动打包)
 *
 * 输入口径: auditQuote 产出的 report（results[].item / missing_items / stats）
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let libCache = null;

/**
 * 加载内嵌精简坑库(带缓存)
 */
export function loadGotchaLib() {
  if (!libCache) {
    const raw = JSON.parse(readFileSync(join(__dirname, 'compact_v1.json'), 'utf-8'));
    libCache = Array.isArray(raw) ? raw : (raw.entries || []);
  }
  return libCache;
}

const SEV_RANK = { SEV_CRITICAL: 3, SEV_HIGH: 2, SEV_MEDIUM: 1, SEV_LOW: 0 };
const SEV_LABEL = { SEV_CRITICAL: '致命', SEV_HIGH: '高危', SEV_MEDIUM: '中危', SEV_LOW: '低危' };
// 与报价审核场景最贴的阶段加权: STAGE_03 报价签约 / STAGE_01 量房
const STAGE_BONUS = { STAGE_01: 1, STAGE_03: 2 };

/**
 * 单条目关键词命中计分: trigger_keywords 与条目名双向子串
 * 标题共现加权(0903 冒烟修正): 关键词同时出现在标题=该坑主题即此词,权重4;
 * 仅在 trigger_keywords=顺带沾边,权重2。再加 severity 与阶段权重。
 */
function scoreGotcha(name, g) {
  let s = 0;
  const title = g.title || '';
  for (const kw of g.trigger_keywords || []) {
    if (!kw) continue;
    if (name.includes(kw) || kw.includes(name)) {
      s += title.includes(kw) ? 4 : 2;
    }
  }
  if (s === 0) return 0;
  return s + (SEV_RANK[g.severity] || 0) + (STAGE_BONUS[g.stage] || 0);
}

/**
 * 按条目名匹配避坑条目,返回排序后 topN(附 hit_score)
 */
export function matchGotchasForItem(name, topN = 2) {
  if (!name || typeof name !== 'string') return [];
  const scored = [];
  for (const g of loadGotchaLib()) {
    const s = scoreGotcha(name, g);
    if (s > 0) scored.push({ s, g });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, topN).map(({ s, g }) => ({ ...g, hit_score: s }));
}

/**
 * 单项查询用的 top1 坑项提示(baojia_item_check 附带)
 */
export function topGotchaHint(name) {
  const m = matchGotchasForItem(name, 1)[0];
  if (!m) return null;
  return {
    ku_id: m.ku_id,
    title: m.title,
    severity: m.severity,
    severity_label: SEV_LABEL[m.severity] || m.severity,
    how_to_avoid: firstStep(m.how_to_avoid),
  };
}

/**
 * 报告级避坑提示——只在触发条件成立时给,防"每单报一堆坑=狼来了"
 * ① 存在疑似漏项 → 报价漏项/增项类套路(TYPE_OMISSION)
 * ② 存在严重偏低项(>30%) → 低价钓鱼/后期增项类套路(TYPE_FRAUD/TYPE_COST)
 */
function globalTips(report, topN = 2, excludeIds = new Set()) {
  const lib = loadGotchaLib();
  const rank = g => (SEV_RANK[g.severity] || 0) + (STAGE_BONUS[g.stage] || 0);
  const byRank = (a, b) => rank(b) - rank(a);
  const fresh = list => list.filter(g => !excludeIds.has(g.ku_id));
  const tips = [];

  if (Array.isArray(report.missing_items) && report.missing_items.length > 0) {
    const hits = fresh(lib.filter(g => (g.problem_type || []).includes('TYPE_OMISSION')))
      .sort(byRank)
      .slice(0, topN);
    if (hits.length) tips.push({ trigger: 'missing_items', label: '疑似漏项相关套路', gotchas: hits });
  }

  const severeLow = (report.results || []).some(
    r => r.status === 'warning_low' && typeof r.deviation === 'number' && r.deviation > 30
  );
  if (severeLow) {
    const hits = fresh(lib.filter(g => (g.problem_type || []).some(pt => pt === 'TYPE_FRAUD' || pt === 'TYPE_COST')
        && (g.trigger_keywords || []).some(kw => /低价|增项|套餐|按米|实报实销|公摊/.test(kw))))
      .sort(byRank)
      .slice(0, topN);
    if (hits.length) tips.push({ trigger: 'low_price_trap', label: '低价钓鱼/后期增项相关套路', gotchas: hits });
  }

  return tips;
}

/**
 * 完整避坑审核: 消费 auditQuote 的 report,产出条目级命中 + 报告级提示
 */
export function auditGotchas(report, options = {}) {
  const { perItem = 1, globalTopN = 2 } = options;
  if (!report || report.success !== true) {
    return { enabled: false, reason: 'report_not_ready' };
  }
  const lib = loadGotchaLib();
  const item_pitfalls = [];
  const excludeIds = new Set();
  let total_matched = 0;

  for (const r of report.results || []) {
    const matches = matchGotchasForItem(r.item, perItem);
    if (matches.length) {
      item_pitfalls.push({ item: r.item, matches });
      total_matched += matches.length;
      for (const m of matches) excludeIds.add(m.ku_id);
    }
  }

  const global_tips = globalTips(report, globalTopN, excludeIds);
  for (const t of global_tips) total_matched += t.gotchas.length;

  return {
    enabled: true,
    lib_size: lib.length,
    item_pitfalls,
    global_tips,
    total_matched,
  };
}

/**
 * how_to_avoid 取第一步("1. …"),超长截断——报告里只给可执行的第一步
 */
function firstStep(text, max = 90) {
  if (!text) return '';
  const first = String(text).split(/(?=[2-9]\s*[.、])/)[0].trim();
  return first.length > max ? first.slice(0, max) + '…' : first;
}

/**
 * 格式化避坑章节(追加在 formatAuditReport 输出之后)
 * 同一条坑在条目命中与报告级提示间去重;展示硬限 cap 条
 */
export function formatGotchaSection(g, cap = 6) {
  if (!g || !g.enabled) return '';
  const lines = [];
  lines.push('--- 避坑提示 (内嵌精简坑库·规则匹配) ---');
  const seen = new Set();
  let shown = 0;
  const push = (tag, m) => {
    if (shown >= cap || seen.has(m.ku_id)) return;
    seen.add(m.ku_id);
    lines.push(`  [避坑·${SEV_LABEL[m.severity] || m.severity}] ${tag}: ${m.title}`);
    lines.push(`      应对: ${firstStep(m.how_to_avoid)}`);
    shown++;
  };

  for (const ip of g.item_pitfalls || []) {
    for (const m of ip.matches) push(`${ip.item}`, m);
    if (shown >= cap) break;
  }
  if (shown < cap) {
    for (const t of g.global_tips || []) {
      for (const m of t.gotchas) push(t.label, m);
      if (shown >= cap) break;
    }
  }

  if (shown === 0) lines.push('  (本单条目在精简库中无高相关坑项)');
  lines.push(`  数据: 知设避坑库精简版 ${g.lib_size} 条(全库598条语义检索版为后续增强)`);
  return lines.join('\n');
}
