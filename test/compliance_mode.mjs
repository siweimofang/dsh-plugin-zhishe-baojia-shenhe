/**
 * 合规硬路由模式测试 (spec v1.0 §6-4) — 全离线, 不发起任何网络请求
 *
 * 覆盖:
 *   [1] advisory(默认/未配置) 零行为变化 — v0.5.0 warning 文案逐字一致(spec 断言③)
 *   [2] strict + 非百炼 + 百炼未配置 → 预检拒收 + 集成 compliance_refused, 不发起视觉调用
 *   [3] strict + 非百炼 + 百炼已配置 → 自动改道(路由优先)
 *   [4] strict + 百炼 → 放行
 *   [5] strict 后检分流(封存口径B) / 百炼路线不旗标
 *
 * 环境隔离: 测试进程内显式设定/删除相关 env, 不依赖用户级 setx 现状, 断言确定性成立。
 */
import assert from 'node:assert/strict';
import {
  complianceMode,
  resolveCompliancePreflight,
  buildComplianceFlags,
  extractContractFromImages,
} from '../lib/vision/contract_ocr.js';

let passed = 0;
async function ok(label, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); process.exitCode = 1; }
}

// ---- 环境隔离: baseline 全删(模拟干净机), 各节按需设定 ----
const ENV_KEYS = ['COMPLIANCE_MODE', 'VISION_PROVIDER', 'BAILIAN_API_KEY', 'BAILIAN_VL_MODEL', 'DEEPSEEK_API_KEY'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };
const baseline = () => { for (const k of ENV_KEYS) setEnv(k, null); };

const V050 = (found, providerUsed) =>
  `检出个人信息(${found.join('/')})且当前视觉供应商为「${providerUsed || 'unknown'}」非百炼——按红档红线建议敏感件改走百炼路线或先彻底脱敏(spec定稿后升级为硬拒收)`;

console.log('[1] advisory(默认): 预检放行 + v0.5.0 文案逐字 + 无PII/百炼路线不旗标');
baseline();
await ok('COMPLIANCE_MODE 未配置 → advisory, deepseek 预检放行且不重写选项', () => {
  assert.equal(complianceMode(), 'advisory');
  const pre = resolveCompliancePreflight({ provider: 'deepseek' });
  assert.equal(pre.action, 'proceed');
  assert.equal(pre.callOptions, undefined);
});
await ok('advisory 检出PII+非百炼 → compliance_warning 与 v0.5.0 逐字一致(spec 断言③)', () => {
  const f = buildComplianceFlags(['手机号'], 'deepseek', 'advisory');
  assert.equal(f.compliance_warning, V050(['手机号'], 'deepseek'));
  assert.equal(f.compliance_blocked, undefined);
});
await ok('advisory 无PII / 供应商=百炼 → 空旗标', () => {
  assert.deepEqual(buildComplianceFlags([], 'deepseek', 'advisory'), {});
  assert.deepEqual(buildComplianceFlags(['手机号'], 'bailian', 'advisory'), {});
});

console.log('[2] strict + deepseek + 百炼未配置 → 拒收且不发起视觉调用');
baseline();
setEnv('COMPLIANCE_MODE', 'strict');
await ok('预检 → refuse, 文案含红档定性与两选一引导', () => {
  const pre = resolveCompliancePreflight({ provider: 'deepseek' });
  assert.equal(pre.action, 'refuse');
  assert.match(pre.error, /红档/);
  assert.match(pre.error, /BAILIAN_API_KEY/);
  assert.match(pre.error, /contract_text/);
});
await ok('集成: extractContractFromImages → compliance_refused:true, 0页成功(不发网络)', async () => {
  const r = await extractContractFromImages(['data:image/png;base64,AAAA'], { provider: 'deepseek' });
  assert.equal(r.success, false);
  assert.equal(r.compliance_refused, true);
  assert.equal(r.pages_success, 0);
  assert.match(r.error, /红档/);
});

console.log('[3] strict + deepseek + 百炼已配置 → 自动改道(路由优先, 不打扰调用方)');
baseline();
setEnv('COMPLIANCE_MODE', 'strict');
setEnv('BAILIAN_API_KEY', 'offline-test-key'); // 假 key: 仅验解析路径, 不发请求
setEnv('BAILIAN_VL_MODEL', 'qwen3-vl-plus');
await ok('预检 → reroute, callOptions 注入 provider=bailian', () => {
  const pre = resolveCompliancePreflight({ provider: 'deepseek' });
  assert.equal(pre.action, 'reroute');
  assert.equal(pre.callOptions.provider, 'bailian');
});

console.log('[4] strict + 百炼 → 放行');
await ok('预检 → proceed(不重路由不拒收)', () => {
  const pre = resolveCompliancePreflight({ provider: 'bailian' });
  assert.equal(pre.action, 'proceed');
});

console.log('[5] strict 后检分流(封存口径B)');
await ok('strict 检出PII+非百炼 → compliance_blocked 含封存/禁止进入对外交付物/PII类型, 无 warning', () => {
  const f = buildComplianceFlags(['手机号', '身份证号'], 'deepseek', 'strict');
  assert.match(f.compliance_blocked, /封存/);
  assert.match(f.compliance_blocked, /禁止进入对外交付物/);
  assert.match(f.compliance_blocked, /手机号/);
  assert.match(f.compliance_blocked, /身份证号/);
  assert.equal(f.compliance_warning, undefined);
});
await ok('strict 供应商=百炼 → 不旗标(合规路线不封存)', () => {
  assert.deepEqual(buildComplianceFlags(['手机号'], 'bailian', 'strict'), {});
});

// 还原进程内 env(进程即将退出, 保险起见)
for (const [k, v] of Object.entries(saved)) setEnv(k, v);

console.log(`\n合规模式测试: ${passed} 项断言通过${process.exitCode ? ' (存在失败)' : ''}`);
