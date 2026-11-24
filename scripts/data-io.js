/**
 * 数据仓库读写 —— 通过 GitHub Contents API，与页面走同一条路径
 *
 * 用法：
 *   node scripts/data-io.js fetch       下载 contracts.js + sent-log.json 到 data/
 *   node scripts/data-io.js push-log    把 data/sent-log.json 传回数据仓库
 *   node scripts/data-io.js check       只打印当前数据仓库配置，不读写
 *
 * 环境变量（页面仓库的 Actions Secrets）：
 *   DATA_TOKEN            数据仓库的 PAT，需要 Contents: Read and write   （必填）
 *   DATA_OWNER            默认 yongshenglu
 *   DATA_REPO             默认 contract-manager-data
 *   DATA_BRANCH           默认 main
 *   DATA_CONTRACTS_PATH   默认 contracts.js
 *   DATA_LOG_PATH         默认 sent-log.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('../lib');

const ROOT = path.join(__dirname, '..');
const LOCAL_DIR = path.join(ROOT, 'data');
const LOCAL_CONTRACTS = path.join(LOCAL_DIR, 'contracts.js');
const LOCAL_LOG = path.join(LOCAL_DIR, 'sent-log.json');

const API = 'https://api.github.com';

function cfg() {
  return {
    token: process.env.DATA_TOKEN || '',
    owner: process.env.DATA_OWNER || 'yongshenglu',
    repo: process.env.DATA_REPO || 'contract-manager-data',
    branch: process.env.DATA_BRANCH || 'main',
    contractsPath: process.env.DATA_CONTRACTS_PATH || 'contracts.js',
    logPath: process.env.DATA_LOG_PATH || 'sent-log.json'
  };
}

function requireToken() {
  const c = cfg();
  if (!c.token) {
    throw new Error(
      '缺少 DATA_TOKEN。\n' +
      '  在页面仓库 Settings → Secrets and variables → Actions 里配置，\n' +
      '  值为一个对数据仓库 ' + c.owner + '/' + c.repo + ' 有 Contents: Read and write 权限的 Token。'
    );
  }
  return c;
}

async function api(c, method, pathname, body) {
  const url = `${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + c.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'contract-manager-data-io'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → HTTP ${res.status}\n${text}`);
  return text ? JSON.parse(text) : null;
}

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Buffer.from(bytes).toString('utf8');
}

async function readFile(c, remotePath) {
  const j = await api(c, 'GET',
    `contents/${encodeURIComponent(remotePath)}?${new URLSearchParams({ ref: c.branch })}`);
  if (!j.content) throw new Error('文件为空或为目录：' + remotePath);
  return b64ToUtf8(j.content);
}

async function doFetch() {
  const c = requireToken();
  fs.mkdirSync(LOCAL_DIR, { recursive: true });

  const contracts = await readFile(c, c.contractsPath);
  fs.writeFileSync(LOCAL_CONTRACTS, contracts, 'utf8');
  // 格式错误立刻报错，别等到发信那步才发现
  const parsed = lib.normalizeData(lib.parseDataFile(contracts));
  console.log(`  ✓ ${c.contractsPath} → data/contracts.js  （${parsed.contracts.length} 份合同）`);

  let logOk = false;
  try {
    const log = await readFile(c, c.logPath);
    fs.writeFileSync(LOCAL_LOG, log, 'utf8');
    const j = JSON.parse(log);
    console.log(`  ✓ ${c.logPath} → data/sent-log.json  （${Object.keys(j.entries || {}).length} 条记录）`);
    logOk = true;
  } catch (e) {
    fs.writeFileSync(LOCAL_LOG, JSON.stringify({ version: 1, entries: {} }, null, 2) + '\n', 'utf8');
    console.log(`  · ${c.logPath} 暂不存在或读不到，已用空记录代替`);
  }
  console.log(`\n数据仓库：${c.owner}/${c.repo}@${c.branch}  日志可用：${logOk}`);
}

async function doPushLog() {
  const c = requireToken();
  if (!fs.existsSync(LOCAL_LOG)) throw new Error('找不到 ' + LOCAL_LOG + '，请先 fetch');
  const content = fs.readFileSync(LOCAL_LOG, 'utf8');
  JSON.parse(content);   // 格式坏了就别往上推

  let sha;
  try {
    const cur = await api(c, 'GET',
      `contents/${encodeURIComponent(c.logPath)}?${new URLSearchParams({ ref: c.branch })}`);
    if (cur && cur.sha) sha = cur.sha;
  } catch (e) { /* 文件还不存在，无 sha */ }

  const body = {
    message: 'chore: 记录本次提醒发送结果',
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: c.branch
  };
  if (sha) body.sha = sha;

  const j = await api(c, 'PUT', `contents/${encodeURIComponent(c.logPath)}`, body);
  const entries = Object.keys(JSON.parse(content).entries || {}).length;
  console.log(`  ✓ 已回写 ${c.logPath}（${entries} 条）→ commit ${j.commit.sha.slice(0, 7)}`);
}

function doCheck() {
  const c = cfg();
  console.log('数据仓库配置：');
  console.log(`  owner/repo : ${c.owner}/${c.repo}`);
  console.log(`  branch     : ${c.branch}`);
  console.log(`  合同文件   : ${c.contractsPath}`);
  console.log(`  日志文件   : ${c.logPath}`);
  console.log(`  DATA_TOKEN : ${c.token ? '已设置（' + c.token.slice(0, 4) + '…）' : '❌ 未设置'}`);
}

(async function main() {
  const cmd = process.argv[2];
  if (cmd === 'fetch') await doFetch();
  else if (cmd === 'push-log') await doPushLog();
  else if (cmd === 'check') doCheck();
  else {
    console.error('用法: node scripts/data-io.js <fetch|push-log|check>');
    process.exit(2);
  }
})().catch((e) => {
  console.error('\n❌ ' + e.message);
  process.exit(1);
});
