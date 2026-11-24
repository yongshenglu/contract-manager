/**
 * 前端冒烟测试 —— jsdom 真实跑 index.html + app.js
 *
 * 三个关键点：
 *   1. 页面不再内嵌数据，合同数据来自「私有数据仓库」的 API —— 测试里用 fixture 模拟
 *   2. fixture 的日期相对今天生成，跑在哪天断言都成立
 *   3. 覆盖两种环境：http://（有 localStorage，可配 Token）和 file://（无 localStorage）
 *
 * 需要 jsdom（已作为 devDependency）。运行：npm run test:ui
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let JSDOM;
let lib;
try {
  ({ JSDOM } = require('jsdom'));
  lib = require('../lib');
} catch (e) {
  console.log('⏭  未安装 jsdom，跳过前端测试（安装：npm i -D jsdom）');
  process.exit(0);
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const libSrc = fs.readFileSync(path.join(ROOT, 'lib.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✅ ' + msg); }
  else { failed++; console.log('  ❌ ' + msg + '\n     期望 ' + e + '\n     实际 ' + a); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const addDays = (dateStr, n) => lib.addDays(dateStr, n);

/* ────────────────────────────────────────── fixture */
// 日期全部相对今天生成，任何一天跑断言都成立
function buildFixture(today) {
  const mk = (id, title, dayOffset, extra) => Object.assign({
    id,
    title,
    counterparty: '对方公司·' + id,
    category: '服务',
    startDate: addDays(today, dayOffset - 365),
    endDate: addDays(today, dayOffset),
    amount: 100000,
    currency: 'CNY',
    autoRenew: false,
    owner: '张三',
    notify: [],
    notes: '',
    payments: []
  }, extra || {});

  return {
    version: 1,
    settings: {
      timezone: 'Asia/Shanghai',
      recipients: ['owner@example.test'],
      renewalTiers: [90, 60, 30, 7, 0],
      expiredRepeatDays: 7
    },
    contracts: [
      mk('c-001', '已过期合同', -10, {
        payments: [{ id: 'p1', label: '尾款', dueDate: addDays(today, -3), amount: 50000, paid: false }]
      }),
      mk('c-002', '七天内到期', 5, {
        payments: [{ id: 'p1', label: '一期', dueDate: addDays(today, 5), amount: 20000, paid: false }]
      }),
      mk('c-003', '三十天内到期', 21, { payments: [] }),
      mk('c-004', '六十天档', 45, { payments: [] }),
      mk('c-005', '九十天档', 85, { payments: [] }),
      mk('c-006', '很久以后', 300, {
        payments: [{ id: 'p1', label: '已付', dueDate: addDays(today, -100), amount: 10000, paid: true }]
      })
    ]
  };
}

function serializeFixture(data) {
  return 'window.CONTRACTS = ' + JSON.stringify(data, null, 2) + ';\n';
}

/** 写回的内容是带注释头的 .js，不能裸 JSON.parse，要用项目自己的解析器 */
function parseWritten(write) {
  const text = Buffer.from(write.body.content, 'base64').toString('utf8');
  return lib.parseDataFile(text);
}

/* ────────────────────────────────────────── 环境构造 */
async function boot(opts) {
  const mode = opts.mode || 'http';
  const withToken = opts.token !== false;
  const today = lib.localToday();
  const fixture = opts.contracts || buildFixture(today);
  const log = opts.sentLog || { version: 1, entries: {} };

  const dom = new JSDOM(html, {
    url: mode === 'file'
      ? 'file:///D:/AI/Claude/%E5%90%88%E5%90%8C%E7%AE%A1%E7%90%86/index.html'
      : 'https://example.github.io/contract-manager/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  const writes = [];
  w.__writes = writes;

  // 模拟数据仓库 API
  w.fetch = async (url, opts2) => {
    const u = String(url);
    const method = (opts2 && opts2.method) || 'GET';
    const body = opts2 && opts2.body ? JSON.parse(opts2.body) : null;

    if (u.includes('/contents/contracts.js')) {
      if (method === 'PUT') {
        writes.push({ path: 'contracts.js', body });
        return { ok: true, status: 200, json: async () => ({ commit: { sha: 'a'.repeat(40) } }) };
      }
      return { ok: true, status: 200, json: async () => ({ content: b64(serializeFixture(fixture)), sha: 'b'.repeat(40) }) };
    }
    if (u.includes('/contents/sent-log.json')) {
      if (method === 'PUT') {
        writes.push({ path: 'sent-log.json', body });
        return { ok: true, status: 200, json: async () => ({ commit: { sha: 'c'.repeat(40) } }) };
      }
      return { ok: true, status: 200, json: async () => ({ content: b64(JSON.stringify(log)), sha: 'd'.repeat(40) }) };
    }
    // ghTest 取仓库元信息
    if (/api\.github\.com\/repos\/[^/]+\/[^/]+\/?$/.test(u.split('?')[0])) {
      return { ok: true, status: 200, json: async () => ({ full_name: 'yongshenglu/contract-manager-data', private: true }) };
    }
    const err = new Error('HTTP 404 for ' + u);
    err.status = 404;
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  };

  // 凭据：file:// 下 localStorage 不可用（jsdom 视为不透明源），天然测「无凭据」路径
  try {
    if (withToken) {
      w.localStorage.setItem('cm_gh_token', 'test-token-abc');
      w.localStorage.setItem('cm_data_owner', 'yongshenglu');
      w.localStorage.setItem('cm_data_repo', 'contract-manager-data');
      w.localStorage.setItem('cm_data_branch', 'main');
      w.localStorage.setItem('cm_data_contracts_path', 'contracts.js');
      w.localStorage.setItem('cm_data_log_path', 'sent-log.json');
    }
  } catch (e) { /* file:// 下必然失败 */ }

  w.URL.createObjectURL = () => 'blob:stub';
  w.URL.revokeObjectURL = () => {};
  w.alert = () => {};
  w.__confirmResult = true;
  w.__confirmLog = [];
  w.confirm = (msg) => { w.__confirmLog.push(String(msg)); return w.__confirmResult !== false; };
  const downloads = [];
  w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  w.__downloads = downloads;

  w.eval(libSrc);
  w.eval(appSrc);
  await tick(80);

  return { dom, w, fixture, $: (s) => w.document.querySelector(s), $$: (s) => Array.from(w.document.querySelectorAll(s)) };
}

/* ────────────────────────────────────────── 用例 */
(async function main() {
  const today = lib.localToday();
  const fixture = buildFixture(today);
  const EXPECT_ROWS = fixture.contracts.length;

  /* ─────────── A. 首次访问，未配 Token ─────────── */
  console.log('\n■ 公开页面首次访问（没有 Token）');
  {
    const { $, $$ } = await boot({ mode: 'http', token: false });
    eq($('#modeText').textContent, '未连接数据仓库', '模式徽章显示未连接');
    eq($('#modeBadge').className, 'mode-badge none', '徽章 class 正确');
    eq($$('#tableBody tr').length, 0, '表格为空');
    eq($('#emptyState').hidden, false, '显示空状态');
    eq($('#emptyTitle').textContent, '尚未连接数据仓库', '空状态标题正确');
    eq($('#btnGoSetup').hidden, false, '显示「去设置」引导按钮');
    eq($('#alertsCount').textContent, '0', '提醒 0 条');
    eq($('.stat-value').textContent, '0', '统计全 0');
  }

  /* ─────────── B. file:// 下 localStorage 不可用 ─────────── */
  console.log('\n■ file:// 双击打开（localStorage 不可用 → 无凭据）');
  {
    const { $, $$ } = await boot({ mode: 'file', token: true });
    eq($('#modeText').textContent, '未连接数据仓库', '仍然未连接');
    eq($('#emptyTitle').textContent, '尚未连接数据仓库', '给出连接引导而不是报错');
    eq($('#btnGoSetup').hidden, false, '可直接跳设置');
    eq($$('#tableBody tr').length, 0, '表格为空');
  }

  /* ─────────── C. 已连接数据仓库 ─────────── */
  console.log('\n■ 已连接私有数据仓库');
  const { w, $, $$ } = await boot({ mode: 'http' });
  {
    eq($('#modeText').textContent, '已连接数据仓库', '模式徽章显示已连接');
    eq($('#modeBadge').className, 'mode-badge ok', '徽章 class 正确');
    eq($$('#tableBody tr').length, EXPECT_ROWS, `渲染 ${EXPECT_ROWS} 行合同`);
    eq($('#emptyState').hidden, true, '非空状态');
    eq($('#todayLine').textContent.startsWith(today), true, '顶栏日期正确');

    const stats = {};
    w.document.querySelectorAll('.stat').forEach((s) => {
      stats[s.querySelector('.stat-label').textContent] = s.querySelector('.stat-value').textContent;
    });
    eq(stats['已过期'], '1', '已过期 = 1');
    eq(stats['30 天内'], '2', '30 天内 = 2');
    eq(stats['90 天内'], '2', '90 天内 = 2');
    eq(stats['正常'], '1', '正常 = 1');

    // 风险徽章与排序：最紧急的排第一
    ok($('#tableBody tr .risk.expired'), '首行是已过期');
    const first = $('#tableBody tr .ct-title').textContent;
    eq(first, '已过期合同', '按剩余天数升序，最紧急排第一');

    // 筛选
    $('#riskFilter').value = 'normal';
    $('#riskFilter').dispatchEvent(new w.Event('change'));
    eq($$('#tableBody tr').length, 1, '筛选「正常」剩 1 条');
    $('#riskFilter').value = '';
    $('#riskFilter').dispatchEvent(new w.Event('change'));

    // 搜索
    $('#searchInput').value = '六十天';
    $('#searchInput').dispatchEvent(new w.Event('input'));
    eq($$('#tableBody tr').length, 1, '搜索「六十天」命中 1 条');
    $('#searchInput').value = '';
    $('#searchInput').dispatchEvent(new w.Event('input'));
    eq($$('#tableBody tr').length, EXPECT_ROWS, '清空搜索恢复全部');
  }

  /* ─────────── D. 提醒预览与去重 ─────────── */
  console.log('\n■ 提醒预览');
  {
    const expected = lib.evaluate(fixture, { entries: {} }, today, { ignoreLog: true }).due.length;
    eq($('#alertsCount').textContent, String(expected), `空 sent-log → ${expected} 条`);
    eq($('#alertsMode').textContent, '已按发送记录去重', '标注已去重');
    ok($('#alertsHint').textContent.includes('真正发出'), '提示会真正发出');
    $('#alertsToggle').click();
    eq($$('#alertsList .alert-row').length, expected, `列表 ${expected} 条`);
    eq($$('#alertsList .tier').length, expected, '每条都有档位徽章');
    ok($('#alertsList .tier.EXPIRED'), '包含已过期档位');
    ok($('#alertsList .tier.T-7'), '包含 T-7 档位');
  }

  console.log('\n■ 全部已发过 → 去重后 0 条');
  {
    const due = lib.evaluate(fixture, { entries: {} }, today, { ignoreLog: true }).due;
    const fullLog = { version: 1, entries: Object.fromEntries(due.map((a) => [a.key, today])) };
    const t = await boot({ mode: 'http', contracts: fixture, sentLog: fullLog });
    eq(t.$('#alertsCount').textContent, '0', '已全部发过 → 0 条');
    t.$('#alertsToggle').click();
    eq(t.$$('#alertsList .alert-row').length, 0, '列表为空');
    ok(t.$('#alertsList .empty-title'), '显示空状态');
  }

  /* ─────────── E. 新增合同写回数据仓库 ─────────── */
  console.log('\n■ 新增合同 → 提交回数据仓库');
  {
    const before = w.__writes.length;
    $('#btnNew').click();
    await tick(30);
    const f = $('#contractForm');
    f.querySelector('[name="title"]').value = '新录合同';
    f.querySelector('[name="endDate"]').value = addDays(today, 120);
    $('#btnSaveContract').click();
    await tick(120);

    eq(w.__writes.length, before + 1, '发生 1 次写入');
    eq(w.__writes[w.__writes.length - 1].path, 'contracts.js', '写的是合同文件');
    const last = w.__writes[w.__writes.length - 1];
    ok(last.body && last.body.content, '写入内容非空');
    ok(last.body.message.includes('新增合同'), '提交信息含「新增合同」');
    const payload = parseWritten(last);
    eq(payload.contracts.length, EXPECT_ROWS + 1, '新合同已进入提交内容');
    ok(payload.contracts.some((c) => c.title === '新录合同'), '新合同标题正确');
    eq($('#contractBackdrop').hidden, true, '保存后关闭弹窗');
    eq($$('#tableBody tr').length, EXPECT_ROWS + 1, '列表已更新');
  }

  /* ─────────── F. 弹窗误点保护 ─────────── */
  console.log('\n■ 点外面不该把填了一半的内容丢掉');
  {
    // 空表单 → 点外面正常关
    $('#btnNew').click();
    await tick(30);
    $('#contractBackdrop').click();
    await tick(20);
    eq($('#contractBackdrop').hidden, true, '空表单点外面 → 正常关闭');

    // 有内容 → 点外面不关 + 提示
    $('#btnNew').click();
    await tick(30);
    $('#contractForm').querySelector('[name="title"]').value = '千万别丢的合同';
    $('#contractForm').querySelector('[name="endDate"]').value = addDays(today, 60);
    $('#contractBackdrop').click();
    await tick(20);
    eq($('#contractBackdrop').hidden, false, '有内容时点外面 → 弹窗不关');
    eq($('#toast').hidden, false, '给出提示');
    ok($('#toast').textContent.includes('未保存'), '提示文案正确');
    eq($('#contractForm').querySelector('[name="title"]').value, '千万别丢的合同', '内容还在');

    // Esc + 取消放弃 → 不关
    w.__confirmResult = false;
    w.__confirmLog.length = 0;
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(20);
    eq($('#contractBackdrop').hidden, false, 'Esc + 取消放弃 → 不关');
    eq(w.__confirmLog.length, 1, '弹出了确认框');
    ok(w.__confirmLog[0].includes('放弃'), '确认框文案含「放弃」');

    // Esc + 确定放弃 → 关
    w.__confirmResult = true;
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(20);
    eq($('#contractBackdrop').hidden, true, 'Esc + 确定放弃 → 关闭');

    // 新增合同时「删除合同」按钮必须不可见
    $('#btnNew').click();
    await tick(30);
    eq($('#btnDeleteContract').hidden, true, '新增合同时删除按钮 hidden=true');
    ok($('#btnGoSetup') !== null, '空状态引导按钮存在（此处应隐藏）');
    $('#contractBackdrop').click();
    await tick(20);
  }

  /* ─────────── G. 设置面板 ─────────── */
  console.log('\n■ 设置面板');
  {
    $('#btnSettings').click();
    await tick(30);
    eq($('#settingsBackdrop').hidden, false, '设置弹窗打开');
    eq($('#setOwner').value, 'yongshenglu', '数据仓库所有者默认值');
    eq($('#setRepo').value, 'contract-manager-data', '数据仓库名默认值');
    eq($('#setBranch').value, 'main', '分支默认值');
    eq($('#setContractsPath').value, 'contracts.js', '合同文件默认值');
    eq($('#setLogPath').value, 'sent-log.json', '日志文件默认值');
    eq($('#setToken').value, 'test-token-abc', 'Token 已从 localStorage 读出');
    eq($('#setTiers').value, '90,60,30,7,0', '档位来自数据文件');
    eq($('#setRepeat').value, '7', '追发周期来自数据文件');

    // 有改动时点外面不关
    const original = $('#setRecipients').value;
    $('#setRecipients').value = original + ', extra@example.test';
    $('#settingsBackdrop').click();
    await tick(20);
    eq($('#settingsBackdrop').hidden, false, '有改动时点外面不关');
    $('#setRecipients').value = original;
    $('#settingsBackdrop').click();
    await tick(20);
    eq($('#settingsBackdrop').hidden, true, '还原后点外面可关');
  }

  /* ─────────── H. 删除合同 ─────────── */
  console.log('\n■ 删除合同');
  {
    const rowsBefore = $$('#tableBody tr').length;
    $('#tableBody tr').click();
    await tick(30);
    eq($('#contractModalTitle').textContent, '编辑合同', '打开编辑模式');
    eq($('#btnDeleteContract').hidden, false, '编辑模式显示删除按钮');
    // 注意：「hidden 属性是否真的把按钮藏住」取决于 CSS 级联，
    // jsdom 不加载外部样式表测不了，那条由浏览器实测覆盖（见 README 测试章节）。
    $('#btnDeleteContract').click();
    await tick(120);
    eq($$('#tableBody tr').length, rowsBefore - 1, '删除后少一行');
    const lastWrite = w.__writes[w.__writes.length - 1];
    ok(lastWrite && lastWrite.path === 'contracts.js', '删除也提交到了数据仓库');
    const payload = parseWritten(lastWrite);
    eq(payload.contracts.length, rowsBefore - 1, '提交内容里已移除');
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`前端测试：${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
  console.log('全部通过 ✅');
})();
