/**
 * 提醒检查与邮件发送
 *
 * 用法：
 *   node scripts/check.js                     真实运行（读 sent-log，发邮件，回写 sent-log）
 *   node scripts/check.js --dry-run           只打印本次会发什么，不发信、不改文件
 *   node scripts/check.js --dry-run --all     忽略已发送记录，预览所有档位
 *   node scripts/check.js --date 2026-03-01   模拟指定日期
 *   node scripts/check.js --test              发一封测试邮件
 *   node scripts/check.js --reset-log         清空已发送记录（重新武装所有档位）
 *
 * 环境变量（GitHub Actions Secrets）：
 *   SMTP_HOST  SMTP_PORT  SMTP_USER  SMTP_PASS  MAIL_FROM  MAIL_TO
 */
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('../lib');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'contracts.js');
const LOG_FILE = path.join(ROOT, 'data', 'sent-log.json');

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const args = { dryRun: false, all: false, test: false, resetLog: false, date: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--all') args.all = true;
    else if (a === '--test') args.test = true;
    else if (a === '--reset-log') args.resetLog = true;
    else if (a === '--date' || a === '-d') args.date = argv[++i];
    else if (a.startsWith('--date=')) args.date = a.slice(7);
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  if (args.date && lib.toDayNumber(args.date) === null) {
    console.error(`--date 格式应为 YYYY-MM-DD，收到：${args.date}`);
    process.exit(2);
  }
  return args;
}

const HELP = `
合同提醒脚本

  node scripts/check.js [选项]

选项：
  --dry-run, -n     只打印，不发邮件、不写文件
  --all             配合 --dry-run，忽略已发送记录，预览全部档位
  --date, -d <日期>  模拟日期 YYYY-MM-DD（默认今天）
  --out, -o <文件>   把邮件 HTML 写到指定文件，可在浏览器里先看效果
  --test            发一封测试邮件（验证 SMTP 配置）
  --reset-log       清空 data/sent-log.json，重新武装所有提醒档位
  --help, -h        显示本帮助

示例：
  node scripts/check.js --dry-run --all --out preview.html
  node scripts/check.js --date 2026-12-24 --dry-run

环境变量：SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS MAIL_FROM MAIL_TO
`.trim();

/* --------------------------------------------------------------- 文件读写 */

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(
      '找不到数据文件：' + DATA_FILE + '\n' +
      '  合同数据存放在独立的私有仓库里，跑之前先拉一次：\n' +
      '    node scripts/data-io.js fetch\n' +
      '  （需要环境变量 DATA_TOKEN）'
    );
  }
  const raw = lib.parseDataFile(fs.readFileSync(DATA_FILE, 'utf8'));
  return lib.normalizeData(raw);
}

function writeLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2) + '\n', 'utf8');
}

/* ------------------------------------------------------------------ 邮件 */

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(
      '缺少环境变量：' + missing.join(', ') +
      '\n请在仓库 Settings → Secrets and variables → Actions 中配置。'
    );
  }
}

function buildSubject(alerts, today) {
  const renew = alerts.filter((a) => a.kind === 'renewal').length;
  const pay = alerts.length - renew;
  const parts = [];
  if (renew) parts.push(`续签 ${renew} 项`);
  if (pay) parts.push(`付款 ${pay} 项`);
  return `【合同提醒】${today} · ${parts.join(' / ') || alerts.length + ' 项待处理'}`;
}

function tierBadge(tier) {
  const cls = tier === 'EXPIRED' || tier === 'OVERDUE' ? 'bad'
    : tier === 'T-0' || tier === 'T-7' ? 'urgent'
    : tier === 'T-30' ? 'warn' : 'info';
  return `<span class="badge ${cls}">${esc(lib.tierLabel(tier))}</span>`;
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 日志里的邮箱打码。
 * 页面仓库是公开的，Actions 日志所有人可见 —— 不能把收件人地址原样打出去。
 * 本地调试想看完整地址时设 DEBUG_EMAIL=1。
 */
function maskEmail(e) {
  if (process.env.DEBUG_EMAIL === '1') return e;
  const m = /^([^@]+)@(.+)$/.exec(String(e).trim());
  if (!m) return '***';
  return (m[1].slice(0, 1) || '*') + '***@' + m[2];
}

function dayText(days) {
  if (days === null) return '—';
  if (days < 0) return `已过期 ${-days} 天`;
  if (days === 0) return '今天到期';
  return `剩 ${days} 天`;
}

function buildHTML(alerts, today, baseUrl, repeat) {
  const renewals = alerts.filter((a) => a.kind === 'renewal');
  const payments = alerts.filter((a) => a.kind === 'payment');

  const row = (a) => `
    <tr>
      <td>${tierBadge(a.tier)}</td>
      <td>
        <div class="t">${esc(a.title)}</div>
        <div class="s">${esc(a.counterparty)}${a.owner ? ' · 负责人 ' + esc(a.owner) : ''}</div>
      </td>
      <td class="c">${esc(a.paymentLabel || '—')}</td>
      <td class="c num">${a.amount ? lib.formatMoney(a.amount) : '—'}</td>
      <td class="c">${esc(a.targetDate)}</td>
      <td class="c strong">${esc(dayText(a.days))}</td>
    </tr>`;

  const block = (title, list) => list.length ? `
    <h2>${title}<span class="cnt">${list.length}</span></h2>
    <table>
      <thead><tr>
        <th>级别</th><th>合同</th><th>款项</th><th>金额</th><th>日期</th><th>剩余</th>
      </tr></thead>
      <tbody>${list.map(row).join('')}</tbody>
    </table>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(buildSubject(alerts, today))}</title>
<style>
  body{margin:0;padding:24px;background:#f5f6f8;color:#1a1a1a;
       font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:760px;margin:0 auto;background:#fff;border-radius:12px;
        border:1px solid #e5e7eb;overflow:hidden}
  .hd{padding:20px 24px;background:#111827;color:#fff}
  .hd h1{margin:0 0 4px;font-size:18px;font-weight:600}
  .hd .d{font-size:13px;color:#9ca3af}
  .bd{padding:20px 24px}
  h2{font-size:14px;margin:20px 0 10px;display:flex;align-items:center;gap:8px}
  h2:first-child{margin-top:0}
  .cnt{background:#eef2ff;color:#3730a3;border-radius:999px;padding:0 8px;font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-weight:500;color:#6b7280;padding:8px 6px;
     border-bottom:1px solid #e5e7eb;font-size:12px}
  td{padding:10px 6px;border-bottom:1px solid #f3f4f6;vertical-align:top}
  td.c{text-align:center;white-space:nowrap}
  td.num{font-variant-numeric:tabular-nums}
  td.strong{font-weight:600;white-space:nowrap}
  .t{font-weight:600}
  .s{color:#6b7280;font-size:12px;margin-top:2px}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;
         font-weight:600;white-space:nowrap}
  .badge.bad{background:#fdecea;color:#b3261e}
  .badge.urgent{background:#fff4e5;color:#c2410c}
  .badge.warn{background:#fef9c3;color:#9a6700}
  .badge.info{background:#eff6ff;color:#1d4ed8}
  .ft{padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;
      color:#6b7280;font-size:12px}
  .ft a{color:#2563eb}
</style></head>
<body><div class="wrap">
  <div class="hd">
    <h1>合同到期与付款提醒</h1>
    <div class="d">${esc(today)} 生成 · 共 ${alerts.length} 项待处理</div>
  </div>
  <div class="bd">
    ${block('续签提醒', renewals)}
    ${block('付款提醒', payments)}
  </div>
  <div class="ft">
    本邮件由 GitHub Actions 自动发送，每档提醒只发一次；已过期 / 已逾期每 ${repeat} 天追一次。
    ${baseUrl ? ` · <a href="${esc(baseUrl)}">打开管理看板</a>` : ''}
  </div>
</div></body></html>`;
}

async function sendMail({ subject, html, to }) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    throw new Error('未安装 nodemailer，请先运行：npm install');
  }
  requireEnv(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']);
  const port = Number(process.env.SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 20000,
    greetingTimeout: 10000
  });
  await transport.verify();
  const info = await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: to.join(', '),
    subject,
    html
  });
  return info;
}

/* ------------------------------------------------------- 按收件人分组 */

function groupByRecipient(alerts) {
  const map = new Map();
  alerts.forEach((a) => {
    a.recipients.forEach((r) => {
      const k = String(r).toLowerCase();
      if (!map.has(k)) map.set(k, { email: r, alerts: [] });
      map.get(k).alerts.push(a);
    });
  });
  return [...map.values()];
}

/* ------------------------------------------------------------------ 主流程 */

function parseList(s) {
  return String(s || '').split(/[,;\s]+/).filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const data = loadData();
  const today = args.date || lib.localToday();
  let log = readJSON(LOG_FILE, { version: 1, entries: {} });
  if (!log.entries) log.entries = {};

  if (args.resetLog) {
    if (args.dryRun) {
      console.log('[dry-run] --reset-log 在 dry-run 模式下不生效');
    } else {
      log = { version: 1, entries: {} };
      writeLog(log);
      console.log('已清空 data/sent-log.json，所有提醒档位重新武装。');
      return;
    }
  }

  if (args.test) {
    const to = (process.env.MAIL_TO || process.env.SMTP_USER || '').split(/[,;\s]+/).filter(Boolean);
    if (!to.length) throw new Error('未配置 MAIL_TO');
    if (args.dryRun) {
      console.log(`[dry-run] 测试邮件收件人：${to.join(', ')}`);
      return;
    }
    const info = await sendMail({
      subject: `【合同提醒】测试邮件 ${today}`,
      html: buildHTML([{
        kind: 'renewal', tier: 'T-30', title: '这是一封测试邮件', counterparty: 'SMTP 连通性验证',
        owner: '', paymentLabel: '', amount: 0, targetDate: today, days: 30, recipients: to
      }], today, process.env.PAGE_URL || '', lib.repeatDays(data)),
      to
    });
    console.log(`测试邮件已发送 → ${to.join(', ')}（${info.messageId}）`);
    return;
  }

  // MAIL_TO 是兜底收件人：合同没配 notify、settings.recipients 也为空时用它
  const result = lib.evaluate(data, log, today, {
    ignoreLog: args.all,
    fallbackRecipients: parseList(process.env.MAIL_TO)
  });
  const due = result.due;

  console.log('─'.repeat(64));
  console.log(`日期：${today}${args.date ? '（模拟）' : ''}   数据：${data.contracts.length} 份合同   档位：${result.tiers.join(' / ')}`);
  console.log('─'.repeat(64));

  if (!due.length) {
    console.log('✅ 本次没有需要发送的提醒。');
    if (args.all) console.log('   （--all 已忽略已发送记录，说明连最早档位都没到期）');
    return;
  }

  // 打印
  const byTier = new Map();
  due.forEach((a) => {
    if (!byTier.has(a.tier)) byTier.set(a.tier, []);
    byTier.get(a.tier).push(a);
  });
  [...byTier.entries()].forEach(([tier, list]) => {
    console.log(`\n${lib.tierLabel(tier)}（${list.length}）`);
    list.forEach((a) => {
      const what = a.kind === 'renewal'
        ? `续签  ${a.title} · ${a.counterparty}`
        : `付款  ${a.title} · ${a.paymentLabel}`;
      console.log(`  - ${what}`);
      console.log(`    日期 ${a.targetDate}  ${dayText(a.days)}  金额 ${a.amount ? lib.formatMoney(a.amount) : '—'}  → ${a.recipients.map(maskEmail).join(', ')}`);
    });
  });

  if (args.dryRun) {
    console.log(`\n[dry-run] 共 ${due.length} 条，未发送、未写入 sent-log。`);
  }

  // 导出邮件 HTML（dry-run 与真实发送都可用）
  if (args.out) {
    const groups = groupByRecipient(due);
    const baseUrl = process.env.PAGE_URL || '';
    const repeat = lib.repeatDays(data);
    const parts = groups.map((g) =>
      `<!-- ══════ 收件人 ${esc(g.email)} ══════ -->\n` +
      buildHTML(g.alerts, today, baseUrl, repeat));
    const doc = parts.length
      ? parts.join('\n\n<hr style="border:none;border-top:2px dashed #d1d5db;margin:32px 0">\n\n')
      : buildHTML([], today, baseUrl, repeat);
    fs.writeFileSync(args.out, doc, 'utf8');
    console.log(`\n已导出邮件 HTML → ${args.out}（${groups.length} 位收件人）`);
    if (args.dryRun) return;
  }

  if (args.dryRun) return;

  // 真实发送：按收件人分组，每人一封
  requireEnv(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO']);
  const groups = groupByRecipient(due);
  const baseUrl = process.env.PAGE_URL || '';
  console.log(`\n发送中…（${groups.length} 位收件人）`);

  const sentKeys = [];
  for (const g of groups) {
    const subject = buildSubject(g.alerts, today);
    const html = buildHTML(g.alerts, today, baseUrl, lib.repeatDays(data));
    const info = await sendMail({ subject, html, to: [g.email] });
    console.log(`  ✉ ${maskEmail(g.email)}  ← ${g.alerts.length} 条  (${info.messageId})`);
    g.alerts.forEach((a) => sentKeys.push(a.key));
  }

  // 全部发送成功后才回写 —— 宁可偶尔重发，绝不漏发
  sentKeys.forEach((k) => { log.entries[k] = today; });
  log.updatedAt = new Date().toISOString();
  writeLog(log);

  console.log(`\n✅ 完成：发送 ${groups.length} 封邮件，记录 ${sentKeys.length} 条 → data/sent-log.json`);
}

main().catch((err) => {
  console.error('\n❌ 失败：' + (err && err.message ? err.message : err));
  if (err && err.response && err.responseCode) console.error('   SMTP 响应：' + err.response);
  process.exit(1);
});
