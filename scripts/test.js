/**
 * 核心规则单元测试 —— 不依赖网络，直接跑：npm test
 */
'use strict';

const lib = require('../lib');

let passed = 0;
let failed = 0;

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}\n     期望 ${e}\n     实际 ${a}`);
  }
}

function section(name) {
  console.log(`\n■ ${name}`);
}

/* ---------------------------------------------------------- 日期与分级 */

section('日期计算');
eq(lib.toDayNumber('2026-11-24'), Math.floor(Date.UTC(2026, 10, 24) / 86400000), '解析 YYYY-MM-DD');
eq(lib.toDayNumber('2026-02-31'), null, '拒绝非法日期 2026-02-31');
eq(lib.toDayNumber('2026/11/24'), null, '拒绝斜杠格式');
eq(lib.fromDayNumber(lib.toDayNumber('2027-01-01')), '2027-01-01', '日编号往返一致');
eq(lib.remainingDays('2026-12-15', '2026-11-24'), 21, '剩余天数 21');
eq(lib.remainingDays('2026-11-10', '2026-11-24'), -14, '过期天数 -14');
eq(lib.remainingDays('2026-11-24', '2026-11-24'), 0, '当天 = 0');
eq(lib.remainingDays('2024-03-01', '2024-02-29'), 1, '闰日跨月正确');

section('风险分级');
eq(lib.riskOf(-1).key, 'expired', 'd=-1 → 已过期');
eq(lib.riskOf(-100).key, 'expired', 'd=-100 → 已过期');
eq(lib.riskOf(0).key, 'd30', 'd=0 → 30天内');
eq(lib.riskOf(30).key, 'd30', 'd=30 → 30天内（边界含）');
eq(lib.riskOf(31).key, 'd90', 'd=31 → 90天内');
eq(lib.riskOf(90).key, 'd90', 'd=90 → 90天内（边界含）');
eq(lib.riskOf(91).key, 'normal', 'd=91 → 正常');
eq(lib.remainingLabel(0), '今天到期', 'd=0 文案');
eq(lib.remainingLabel(-3), '已过期 3 天', '负数文案');

/* -------------------------------------------------------------- 档位 */

section('档位选择 pickTier');
const T = [90, 60, 30, 7, 0];
eq(lib.pickTier(200, T), null, 'd=200 → 无档位');
eq(lib.pickTier(91, T), null, 'd=91 → 无档位');
eq(lib.pickTier(90, T), 'T-90', 'd=90 → T-90');
eq(lib.pickTier(89, T), 'T-90', 'd=89 → T-90');
eq(lib.pickTier(61, T), 'T-90', 'd=61 → T-90');
eq(lib.pickTier(60, T), 'T-60', 'd=60 → T-60');
eq(lib.pickTier(45, T), 'T-60', 'd=45 → T-60（新合同只发最紧急一档）');
eq(lib.pickTier(30, T), 'T-30', 'd=30 → T-30');
eq(lib.pickTier(8, T), 'T-30', 'd=8 → T-30');
eq(lib.pickTier(7, T), 'T-7', 'd=7 → T-7');
eq(lib.pickTier(1, T), 'T-7', 'd=1 → T-7');
eq(lib.pickTier(0, T), 'T-0', 'd=0 → T-0');
eq(lib.pickTier(-5, T), 'EXPIRED', 'd=-5 → EXPIRED');

/* ---------------------------------------------------------- 每档一次 */

function makeData(endDate, payments) {
  return lib.normalizeData({
    settings: { recipients: ['a@x.com'], renewalTiers: T, expiredRepeatDays: 7 },
    contracts: [{
      id: 'c1', title: '测试合同', counterparty: '对方', endDate,
      payments: payments || []
    }]
  });
}
const EMPTY_LOG = { entries: {} };

section('每档只提醒一次');
{
  const data = makeData('2026-12-31'); // 以 2026-11-24 为今天，d = 37
  const r1 = lib.evaluate(data, EMPTY_LOG, '2026-11-24');
  eq(r1.due.map((a) => a.tier), ['T-60'], 'd=37 → 只发最紧急的 T-60');

  // 记录已发送，再评估一次
  const log = { entries: {} };
  r1.due.forEach((a) => { log.entries[a.key] = '2026-11-24'; });
  const r2 = lib.evaluate(data, log, '2026-11-24');
  eq(r2.due.length, 0, '同一天重复评估 → 不再发');

  const r3 = lib.evaluate(data, log, '2026-11-25'); // d=36，仍是 T-60
  eq(r3.due.length, 0, '次日仍为 T-60 档 → 不再发');

  const r4 = lib.evaluate(data, log, '2026-12-01'); // d=30 → 首次进入 T-30
  eq(r4.due.map((a) => a.tier), ['T-30'], 'd=30 → 首次触发 T-30');
  r4.due.forEach((a) => { log.entries[a.key] = '2026-12-01'; });

  const r5 = lib.evaluate(data, log, '2026-12-24'); // d=7 → T-7
  eq(r5.due.map((a) => a.tier), ['T-7'], 'd=7 → 触发 T-7');

  const r6 = lib.evaluate(data, log, '2026-12-31'); // d=0 → T-0
  eq(r6.due.map((a) => a.tier), ['T-0'], 'd=0 → 触发 T-0');

  const r7 = lib.evaluate(data, log, '2027-01-01'); // d=-1 → EXPIRED
  eq(r7.due.map((a) => a.tier), ['EXPIRED'], '过期 → EXPIRED');
}

section('已过期每周追一次');
{
  const data = makeData('2026-11-10'); // 已过期 14 天
  const log = { entries: {} };
  const d0 = '2026-11-24';
  const r0 = lib.evaluate(data, log, d0);
  eq(r0.due.map((a) => a.tier), ['EXPIRED'], '首次 → EXPIRED');
  r0.due.forEach((a) => { log.entries[a.key] = d0; });

  eq(lib.evaluate(data, log, '2026-11-25').due.length, 0, '+1 天 → 不追');
  eq(lib.evaluate(data, log, '2026-11-30').due.length, 0, '+6 天 → 不追');
  const r7 = lib.evaluate(data, log, '2026-12-01'); // +7 天
  eq(r7.due.map((a) => a.tier), ['EXPIRED'], '+7 天 → 再追一次');
  r7.due.forEach((a) => { log.entries[a.key] = '2026-12-01'; });
  eq(lib.evaluate(data, log, '2026-12-07').due.length, 0, '再 +6 天 → 不追');
}

section('续签后档位自动重新武装');
{
  const data = makeData('2026-12-31');
  const log = { entries: {} };
  const r1 = lib.evaluate(data, log, '2026-11-24');
  r1.due.forEach((a) => { log.entries[a.key] = '2026-11-24'; });
  eq(Object.keys(log.entries).length, 1, '已记录 1 条');

  // 续签：改成明年
  data.contracts[0].endDate = '2027-12-31';
  const r2 = lib.evaluate(data, log, '2026-11-25');
  eq(r2.due.length, 0, '新到期日 d≈370 → 无档位（键已变但没到期）');

  // 快到期时会重新触发
  const r3 = lib.evaluate(data, log, '2027-12-01'); // d=30
  eq(r3.due.map((a) => a.tier), ['T-30'], '续签后到 T-30 → 重新提醒');
  eq(r3.due[0].key.includes('2027-12-31'), true, '键包含新到期日');
}

/* ------------------------------------------------------------ 分期付款 */

section('分期付款');
{
  const data = makeData('2027-06-30', [
    { id: 'p1', label: '一期', dueDate: '2026-12-01', amount: 100000, paid: false },
    { id: 'p2', label: '二期', dueDate: '2026-11-20', amount: 100000, paid: false }, // 已逾期
    { id: 'p3', label: '三期', dueDate: '2026-11-01', amount: 100000, paid: true  }  // 已付，忽略
  ]);
  const r = lib.evaluate(data, EMPTY_LOG, '2026-11-24');
  const tiers = r.due.map((a) => `pay:${a.paymentId}:${a.tier}`).sort();
  eq(tiers, ['pay:p1:T-7', 'pay:p2:OVERDUE'], '未付的才提醒；已付的忽略');
  const p1 = r.due.find((a) => a.paymentId === 'p1');
  eq(p1.days, 7, '一期剩 7 天');
  eq(p1.amount, 100000, '带出金额');
  const p2 = r.due.find((a) => a.paymentId === 'p2');
  eq(p2.days, -4, '二期已逾期 4 天');
}

section('分期付款逾期每周追一次');
{
  const data = makeData('2027-06-30', [
    { id: 'p1', label: '一期', dueDate: '2026-11-20', amount: 100000, paid: false }
  ]);
  const log = { entries: {} };
  const r0 = lib.evaluate(data, log, '2026-11-24');
  eq(r0.due.map((a) => a.tier), ['OVERDUE'], '逾期 → OVERDUE');
  r0.due.forEach((a) => { log.entries[a.key] = '2026-11-24'; });
  eq(lib.evaluate(data, log, '2026-11-30').due.length, 0, '+6 天不追');
  eq(lib.evaluate(data, log, '2026-12-01').due.map((a) => a.tier), ['OVERDUE'], '+7 天再追');
}

/* -------------------------------------------------------- 收件人与统计 */

section('收件人');
{
  const data = lib.normalizeData({
    settings: { recipients: ['default@x.com'] },
    contracts: [
      { id: 'a', title: 'A', endDate: '2026-12-20', payments: [] },
      { id: 'b', title: 'B', endDate: '2026-12-20', notify: ['boss@x.com'], payments: [] }
    ]
  });
  const r = lib.evaluate(data, EMPTY_LOG, '2026-11-24');
  const a = r.due.find((x) => x.contractId === 'a');
  const b = r.due.find((x) => x.contractId === 'b');
  eq(a.recipients, ['default@x.com'], '无 notify → 用默认收件人');
  eq(b.recipients, ['boss@x.com'], '有 notify → 覆盖默认');
}

section('无收件人则用 MAIL_TO 兜底');
{
  const data = lib.normalizeData({
    settings: { recipients: [] },
    contracts: [{ id: 'a', title: 'A', endDate: '2026-12-20', payments: [] }]
  });
  eq(lib.evaluate(data, EMPTY_LOG, '2026-11-24').due.length, 0, '三层都没有 → 0 条');

  const withFallback = lib.evaluate(data, EMPTY_LOG, '2026-11-24', {
    fallbackRecipients: ['backup@x.com']
  });
  eq(withFallback.due.length, 1, '给了兜底地址 → 正常发出');
  eq(withFallback.due[0].recipients, ['backup@x.com'], '兜底地址被采用');
}

section('合同自己的 notify 优先于兜底地址');
{
  const data = lib.normalizeData({
    settings: { recipients: [] },
    contracts: [{ id: 'a', title: 'A', endDate: '2026-12-20', notify: ['own@x.com'], payments: [] }]
  });
  const r = lib.evaluate(data, EMPTY_LOG, '2026-11-24', { fallbackRecipients: ['backup@x.com'] });
  eq(r.due[0].recipients, ['own@x.com'], 'notify 覆盖兜底');
}

section('数据默认 recipients 优先于兜底地址');
{
  const data = lib.normalizeData({
    settings: { recipients: ['default@x.com'] },
    contracts: [{ id: 'a', title: 'A', endDate: '2026-12-20', payments: [] }]
  });
  const r = lib.evaluate(data, EMPTY_LOG, '2026-11-24', { fallbackRecipients: ['backup@x.com'] });
  eq(r.due[0].recipients, ['default@x.com'], 'settings.recipients 优先');
}

section('看板统计');
{
  const data = makeData('2026-12-31', [
    { id: 'p1', dueDate: '2026-12-01', amount: 100000, paid: true },
    { id: 'p2', dueDate: '2026-12-15', amount: 50000, paid: false },
    { id: 'p3', dueDate: '2026-11-01', amount: 30000, paid: false }
  ]);
  const s = lib.summarize(data, '2026-11-24');
  eq(s.total, 1, '合同总数');
  eq(s.counts.d90, 1, 'd=37 → 90天内');
  eq(s.outstanding, 80000, '待付金额 50000+30000');
  eq(s.overduePayments, 1, '逾期付款 1 笔');
}

section('数据解析');
{
  const src = '// 注释\nwindow.CONTRACTS = {\n  "settings": {"recipients":["a@b.c"]},\n  "contracts": []\n};\n';
  const d = lib.parseDataFile(src);
  eq(d.settings.recipients, ['a@b.c'], '剥掉注释与外壳');
  const d2 = lib.parseDataFile('{"contracts":[{"id":"x"}]}');
  eq(d2.contracts[0].id, 'x', '纯 JSON 也能解析');
}

/* ------------------------------------------------------------------ 汇总 */

console.log('\n' + '─'.repeat(50));
console.log(`结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
console.log('全部通过 ✅');
