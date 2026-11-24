/* ═══════════════════════════════════════════════════════════
   合同管理 · 前端逻辑
   数据源：私有仓库 contract-manager-data 的 contracts.js / sent-log.json
   读写方式：GitHub Contents API，凭据存在浏览器 localStorage
   本页面仓库只放代码，可安全公开。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const L = window.ContractLib;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // 数据存放在独立的【私有】仓库里，本页面仓库只放代码，可安全公开。
  // 凭据只存在浏览器 localStorage，永不写进任何仓库。
  const LS = {
    token: 'cm_gh_token',
    owner: 'cm_data_owner',
    repo: 'cm_data_repo',
    branch: 'cm_data_branch',
    contractsPath: 'cm_data_contracts_path',
    logPath: 'cm_data_log_path'
  };

  const DEFAULT_DATA_REPO = {
    owner: 'yongshenglu',
    repo: 'contract-manager-data',
    branch: 'main',
    contractsPath: 'contracts.js',
    logPath: 'sent-log.json'
  };

  const FILE_HEADER = `// ============================================================================
// 合同数据源（私有仓库）
//
// 编辑方式：
//   1. 打开看板 → 设置 → 填入有本仓库写权限的 Token → 网页上直接改
//   2. 在 GitHub 上直接编辑本文件（需该私有仓库访问权限）
//
// 注意：保持 \`window.CONTRACTS = { ... };\` 外壳不动，只改花括号里的内容。
//       日期一律用 YYYY-MM-DD。字段说明见页面仓库 README。
// ============================================================================

window.CONTRACTS = `;

  /* ───────────────────────────────────────────── 状态 */
  const state = {
    data: null,
    sentLog: null,
    sentLogOk: false,
    today: L.localToday(),
    filters: { q: '', risk: '', category: '', sort: 'days-asc' },
    editingId: null,
    paymentsDraft: [],
    loaded: null,           // 已成功读取的数据仓库标识 owner/repo@branch，保存前必查
    mode: 'none',           // none | ok | warn | err
    modeText: '未连接数据仓库'
  };

  /* ───────────────────────────────────────────── 存储 */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } }
  };

  /** 数据仓库配置（凭据来自浏览器 localStorage，指向私有数据仓库） */
  function dataConfig() {
    return {
      token: store.get(LS.token, ''),
      owner: store.get(LS.owner, DEFAULT_DATA_REPO.owner),
      repo: store.get(LS.repo, DEFAULT_DATA_REPO.repo),
      branch: store.get(LS.branch, DEFAULT_DATA_REPO.branch) || 'main',
      contractsPath: store.get(LS.contractsPath, DEFAULT_DATA_REPO.contractsPath),
      logPath: store.get(LS.logPath, DEFAULT_DATA_REPO.logPath)
    };
  }
  function dataReady() {
    const c = dataConfig();
    return !!(c.token && c.owner && c.repo);
  }
  /** 当前数据来自哪个仓库，用于防止「换仓库后没重新加载就保存」覆盖掉远端数据 */
  function dataKey(c) {
    c = c || dataConfig();
    return c.owner + '/' + c.repo + '@' + c.branch;
  }

  /* ───────────────────────────────────────────── Toast */
  let toastTimer = null;
  function toast(msg, type) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' ' + type : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, type === 'err' ? 4600 : 2800);
  }

  /* ───────────────────────────────────────────── 弹窗 */
  // 可编辑弹窗的「未保存修改」保护：打开时记一份快照，关闭前比对。
  // 防止误点遮罩层 / 按 Esc 把填了一半的内容整个丢掉。
  let modalGuard = null; // { id, snapshotFn, snapshot }

  function openModal(id) {
    modalGuard = null; // 换弹窗时清掉上一个的保护
    $('#' + id).hidden = false;
    document.body.style.overflow = 'hidden';
    const first = $('#' + id + ' input:not([type=hidden]):not([readonly])');
    if (first) setTimeout(() => first.focus(), 60);
  }

  function closeModal(id) {
    modalGuard = null;
    $('#' + id).hidden = true;
    if (!$$('.backdrop:not([hidden])').length) document.body.style.overflow = '';
  }

  /** 给可编辑弹窗挂保护；snapshotFn 返回当前表单内容的序列化结果 */
  function guardModal(id, snapshotFn) {
    modalGuard = { id, snapshotFn, snapshot: snapshotFn() };
  }

  function isDirty() {
    return !!modalGuard && modalGuard.snapshotFn() !== modalGuard.snapshot;
  }

  /** 显式关闭（✕ / 取消 / Esc）：有未保存修改时先问一句 */
  function requestClose(id) {
    if (modalGuard && modalGuard.id === id && isDirty()) {
      if (!confirm('有未保存的修改，确定放弃吗？')) return false;
    }
    closeModal(id);
    return true;
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-close]');
    if (t) { requestClose(t.dataset.close); return; }

    if (e.target.classList.contains('backdrop')) {
      const id = e.target.id;
      // 点外面：表单没动过就直接关（正常交互）；
      // 动过则不关，只提示 —— 这是丢内容的主要来源。
      if (modalGuard && modalGuard.id === id && isDirty()) {
        toast('有未保存的修改，请点「保存」或「取消」');
        return;
      }
      closeModal(id);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = $$('.backdrop:not([hidden])');
      if (open.length) requestClose(open[open.length - 1].id);
    }
  });

  /* ───────────────────────────────────────────── GitHub API */
  function headers() {
    return {
      'Authorization': 'Bearer ' + dataConfig().token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
  }

  function b64ToUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function ghFetch(pathname) {
    const c = dataConfig();
    const url = `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/${pathname}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.message) msg = j.message; } catch (e) { /* 忽略 */ }
      if (res.status === 401) msg = 'Token 无效或已过期';
      if (res.status === 403) msg = 'Token 权限不足（需要数据仓库的 Contents: Read and write）';
      if (res.status === 404) msg = '数据仓库或分支不存在，检查所有者/仓库名/分支';
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function ghReadFile(path, opts) {
    const c = dataConfig();
    const q = new URLSearchParams({ ref: c.branch });
    // 注意：Contents API 的路径是 /repos/{o}/{r}/contents/{path}，不能漏掉 contents/
    let j;
    try {
      j = await ghFetch(`contents/${encodeURIComponent(path)}?${q}`);
    } catch (e) {
      // 可选文件（如还没生成的 sent-log）404 时不该拖垮整个加载
      if (opts && opts.optional && (e.status === 404 || e.status === 409)) return null;
      throw e;
    }
    if (j.content) return b64ToUtf8(j.content);
    if (opts && opts.optional) return null;
    throw new Error('文件内容为空或为子目录：' + path);
  }

  async function ghWriteFile(path, content, message) {
    const c = dataConfig();
    const url = `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${encodeURIComponent(path)}`;
    let sha;
    try {
      const q = new URLSearchParams({ ref: c.branch });
      const cur = await fetch(`${url}?${q}`, { headers: headers() }).then((r) => (r.ok ? r.json() : null));
      if (cur && cur.sha) sha = cur.sha;
    } catch (e) { /* 新文件无 sha */ }

    const body = { message, content: utf8ToB64(content), branch: c.branch };
    if (sha) body.sha = sha;

    let res = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) {
      // sha 冲突：重取一次再试
      const q = new URLSearchParams({ ref: c.branch });
      const cur = await fetch(`${url}?${q}`, { headers: headers() }).then((r) => (r.ok ? r.json() : null));
      if (cur && cur.sha) body.sha = cur.sha;
      res = await fetch(url, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.message) msg = j.message; } catch (e) { /* 忽略 */ }
      throw new Error('提交失败：' + msg);
    }
    return res.json();
  }

  async function ghTest() {
    const j = await ghFetch('');
    return j.full_name;
  }

  /* ───────────────────────────────────────────── 序列化 */
  function serialize(data) {
    return FILE_HEADER + JSON.stringify(data, null, 2) + ';\n';
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ───────────────────────────────────────────── 加载 */
  async function loadAll() {
    // 公开页面本身不携带任何合同数据，全部来自私有数据仓库
    state.data = L.normalizeData({ settings: L.defaultSettings(), contracts: [] });
    state.sentLog = null;
    state.sentLogOk = false;
    state.loaded = null;

    if (!dataReady()) {
      setMode('none', '未连接数据仓库');
      renderAll();
      return;
    }

    setMode('warn', '连接中…');
    try {
      const cfg = dataConfig();
      const [contractsText, logText] = await Promise.all([
        ghReadFile(cfg.contractsPath),
        ghReadFile(cfg.logPath, { optional: true })   // 日志文件可能还不存在
      ]);
      state.data = L.normalizeData(L.parseDataFile(contractsText));
      if (logText) {
        try { state.sentLog = JSON.parse(logText); state.sentLogOk = true; } catch (e) { /* 忽略 */ }
      }
      state.loaded = dataKey(cfg);
      setMode('ok', '已连接数据仓库');
      $('#connState').textContent = '';
      $('#connState').className = 'conn-state';
    } catch (e) {
      state.loaded = null;
      setMode('err', '连接失败');
      $('#connState').textContent = '读取失败：' + e.message;
      $('#connState').className = 'conn-state err';
    }
    renderAll();
  }

  function setMode(mode, text) {
    state.mode = mode;
    state.modeText = text;
    const badge = $('#modeBadge');
    badge.className = 'mode-badge ' + mode;
    $('#modeText').textContent = text;
    const c = dataConfig();
    badge.title = mode === 'ok'
      ? '数据读写私有仓库 ' + c.owner + '/' + c.repo
      : mode === 'none'
        ? '未配置 Token：页面无法读取私有数据仓库'
        : '数据仓库已配置但连接异常';
  }

  /* ───────────────────────────────────────────── 保存 */
  async function saveData(message) {
    const cfg = dataConfig();
    if (!dataReady()) {
      toast('未连接数据仓库，请先在「设置」里填入 Token', 'err');
      return { ok: false };
    }
    // 安全闸：只有确实从当前这个仓库读过数据才允许写，
    // 否则会用内存里的空数据把远端覆盖掉。
    if (state.loaded !== dataKey(cfg)) {
      toast('尚未成功读取 ' + dataKey(cfg) + '，为避免覆盖远端数据已阻止保存', 'err');
      return { ok: false };
    }
    try {
      await ghWriteFile(cfg.contractsPath, serialize(state.data), message || 'chore: 更新合同数据');
      toast('已提交到数据仓库', 'ok');
      return { ok: true, where: 'github' };
    } catch (e) {
      toast('提交失败：' + e.message, 'err');
      return { ok: false, error: e.message };
    }
  }

  /* ───────────────────────────────────────────── 渲染：统计 */
  function renderStats() {
    const s = L.summarize(state.data, state.today);
    const cards = [
      { key: 'expired', label: '已过期', v: s.counts.expired, c: 'var(--r-expired)', sub: '需要立即处理' },
      { key: 'd30', label: '30 天内', v: s.counts.d30, c: 'var(--r-d30)', sub: '启动续签谈判' },
      { key: 'd90', label: '90 天内', v: s.counts.d90, c: 'var(--r-d90)', sub: '提前评估' },
      { key: 'normal', label: '正常', v: s.counts.normal, c: 'var(--r-normal)', sub: '暂无风险' },
      {
        key: 'pay', label: '待付款', v: L.formatMoney(s.outstanding), c: 'var(--accent)',
        sub: s.overduePayments ? `${s.overduePayments} 笔已逾期` : (s.nextExpiry ? `最近到期 ${s.nextExpiry.days} 天后` : '暂无排期'),
        small: true
      }
    ];
    $('#stats').innerHTML = cards.map((c) => `
      <div class="stat" style="--sc:${c.c}">
        <div class="stat-top">
          <span class="stat-label">${c.label}</span>
          <span class="stat-dot"></span>
        </div>
        <div class="stat-value${c.small ? ' sm' : ''}">${c.v}</div>
        <div class="stat-sub">${c.sub}</div>
      </div>`).join('');
  }

  /* ───────────────────────────────────────────── 渲染：类别下拉 */
  function renderCategories() {
    const sel = $('#categoryFilter');
    const cur = state.filters.category;
    const cats = [...new Set(state.data.contracts.map((c) => c.category).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">全部类别</option>' +
      cats.map((c) => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
    if (cur && !cats.includes(cur)) state.filters.category = '';
  }

  /* ───────────────────────────────────────────── 渲染：表格 */
  function filtered() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    let list = state.data.contracts.map((c) => ({ c, s: L.contractSummary(c, state.today) }));

    if (q) {
      list = list.filter(({ c }) =>
        [c.title, c.counterparty, c.owner, c.category, c.notes]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
    }
    if (f.risk) list = list.filter(({ s }) => s.risk.key === f.risk);
    if (f.category) list = list.filter(({ c }) => c.category === f.category);

    const dir = { 'days-asc': 1, 'days-desc': -1 }[f.sort];
    list.sort((a, b) => {
      if (f.sort === 'amount-desc') return (b.s.totalAmount || b.c.amount || 0) - (a.s.totalAmount || a.c.amount || 0);
      if (f.sort === 'title') return String(a.c.title || '').localeCompare(String(b.c.title || ''), 'zh-Hans-CN');
      if (f.sort === 'updated') return String(b.c.updatedAt || '').localeCompare(String(a.c.updatedAt || ''));
      const da = a.s.days === null ? Infinity : a.s.days;
      const db = b.s.days === null ? Infinity : b.s.days;
      return (da - db) * dir;
    });
    return list;
  }

  function payCell(c, s) {
    if (!s.paymentCount) return '<span style="color:var(--muted);font-size:12px">—</span>';
    const pct = s.paymentCount ? Math.round((s.paidCount / s.paymentCount) * 100) : 0;
    const overdue = s.overduePaymentCount > 0;
    return `
      <div class="pay-cell">
        <div class="pay-bar${pct === 100 ? ' full' : ''}"><i style="width:${pct}%"></i></div>
        <div class="pay-text">
          <span>${s.paidCount}/${s.paymentCount} 期</span>
          <span class="${overdue ? 'pay-overdue' : ''}">
            ${overdue ? `逾期 ${s.overduePaymentCount} 笔` : (s.outstanding ? '余 ' + L.formatMoney(s.outstanding) : '已付清')}
          </span>
        </div>
      </div>`;
  }

  function renderTable() {
    const list = filtered();
    const body = $('#tableBody');
    $('#resultCount').textContent = `共 ${list.length} / ${state.data.contracts.length} 份合同`;

    // 空状态分三种，文案各不相同
    const empty = $('#emptyState');
    const goSetup = $('#btnGoSetup');
    if (list.length > 0) {
      empty.hidden = true;
    } else {
      empty.hidden = false;
      goSetup.hidden = true;
      if (!dataReady()) {
        $('#emptyIcon').textContent = '🔐';
        $('#emptyTitle').textContent = '尚未连接数据仓库';
        $('#emptySub').textContent = '这是公开页面，合同数据存在私有仓库里——填入 GitHub Token 才能加载。';
        goSetup.hidden = false;
      } else if (state.mode === 'err') {
        $('#emptyIcon').textContent = '⚠️';
        $('#emptyTitle').textContent = '数据仓库连接失败';
        $('#emptySub').textContent = '请到设置里检查 Token 权限与仓库地址。';
        goSetup.hidden = false;
      } else if (state.data.contracts.length === 0) {
        $('#emptyIcon').textContent = '📄';
        $('#emptyTitle').textContent = '还没有合同';
        $('#emptySub').textContent = '点击右上角「＋ 新增合同」开始录入。';
      } else {
        $('#emptyIcon').textContent = '🔍';
        $('#emptyTitle').textContent = '没有符合条件的合同';
        $('#emptySub').textContent = '换个筛选条件试试。';
      }
    }

    body.innerHTML = list.map(({ c, s }) => {
      const risk = s.risk;
      const daysTxt = s.days === null ? '—' : (s.days < 0 ? String(-s.days) : String(s.days));
      const daysUnit = s.days === null ? '' : (s.days < 0 ? '天前' : (s.days === 0 ? '今天' : '天'));
      const daysSub = s.days === null ? '未设到期日' : (s.days < 0 ? '已过期' : (s.days === 0 ? '到期' : '剩余'));
      return `
      <tr data-id="${esc(c.id)}" title="点击编辑">
        <td class="c-title" data-label="合同">
          <div class="ct-title">${esc(c.title || '(未命名)')}</div>
          <div class="ct-sub">
            ${c.category ? `<span class="ct-tag">${esc(c.category)}</span>` : ''}
            ${esc(c.counterparty || '')}
          </div>
          ${c.notes ? `<div class="ct-note">📝 ${esc(c.notes.length > 42 ? c.notes.slice(0, 42) + '…' : c.notes)}</div>` : ''}
        </td>
        <td data-label="到期日">
          <div class="date-cell">${esc(c.endDate || '—')}${c.endDate ? `<span class="wd">${L.weekdayCN(c.endDate)}</span>` : ''}</div>
          ${c.autoRenew ? '<div class="ct-note">自动续签</div>' : ''}
        </td>
        <td class="c-days" data-label="剩余">
          <div class="days-cell">
            <span class="days-num" style="color:${risk.text}">${daysTxt}<span style="font-size:11.5px;font-weight:500"> ${daysUnit}</span></span>
            <span class="days-sub">${daysSub}</span>
          </div>
        </td>
        <td data-label="风险"><span class="risk ${risk.key}">${risk.label}</span></td>
        <td class="c-num" data-label="金额"><span class="amount">${c.amount ? L.formatMoney(c.amount, c.currency) : '—'}</span></td>
        <td class="c-pay" data-label="分期">${payCell(c, s)}</td>
        <td data-label="负责人">${esc(c.owner || '—')}</td>
        <td class="c-act" data-label="">
          <button class="icon-btn row-menu" data-edit="${esc(c.id)}" title="编辑" aria-label="编辑">✎</button>
        </td>
      </tr>`;
    }).join('');
  }

  /* ───────────────────────────────────────────── 渲染：提醒预览 */
  function renderAlerts() {
    const res = L.evaluate(state.data, state.sentLog || { entries: {} }, state.today,
      { ignoreLog: !state.sentLogOk });
    const due = res.due;

    const chip = $('#alertsCount');
    chip.textContent = due.length;
    chip.className = 'chip' + (due.length ? '' : ' chip-zero');
    $('#alertsMode').textContent = state.sentLogOk ? '已按发送记录去重' : '未去重（读不到 sent-log）';

    $('#alertsHint').innerHTML = state.sentLogOk
      ? `以下 <b>${due.length}</b> 条是下次 GitHub Actions 运行时会真正发出的提醒（${state.today}）。`
      : `本地模式读不到 <code>data/sent-log.json</code>，以下是<b>全量</b>预览（${due.length} 条），实际发送会再按已发送记录去重。`;

    $('#alertsList').innerHTML = due.length ? due.map(alertRow).join('')
      : '<div class="empty" style="padding:26px 10px"><p class="empty-title">暂无待发送的提醒</p><p class="empty-sub">所有档位都已提醒过，或尚未到达提醒阈值</p></div>';

    $('#alertsFullList').innerHTML = due.length ? due.map(alertRow).join('')
      : '<div class="empty"><p class="empty-title">暂无待发送的提醒</p></div>';
  }

  function alertRow(a) {
    const daysTxt = a.days === null ? '—'
      : a.days < 0 ? (a.kind === 'renewal' ? `已过期 ${-a.days} 天` : `已逾期 ${-a.days} 天`)
      : a.days === 0 ? '今天到期' : `剩 ${a.days} 天`;
    const money = a.amount ? L.formatMoney(a.amount) : '';
    return `
      <div class="alert-row">
        <span class="tier ${esc(a.tier)}">${esc(L.tierLabel(a.tier))}</span>
        <div class="grow">
          <div class="alert-main">${a.kind === 'renewal' ? '续签' : '付款'} · ${esc(a.title)}${a.paymentLabel ? ' · ' + esc(a.paymentLabel) : ''}</div>
          <div class="alert-sub">${esc(a.counterparty || '')}${a.owner ? ' · 负责人 ' + esc(a.owner) : ''}</div>
        </div>
        <div class="alert-meta">${esc(a.targetDate)}<br>${esc(daysTxt)}${money ? ' · ' + money : ''}</div>
        <div class="alert-to">→ ${esc(a.recipients.join(', '))}</div>
      </div>`;
  }

  function renderAll() {
    $('#todayLine').textContent = `${state.today} · ${L.weekdayCN(state.today)} · 共 ${state.data.contracts.length} 份合同`;
    renderStats();
    renderCategories();
    renderTable();
    renderAlerts();
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 表单控件取值 —— 不用 form.xxx 命名属性访问（form.id 会撞上内建 id 属性，
     且各实现支持程度不一），统一用 querySelector，浏览器与 jsdom 行为一致。 */
  function fld(form, name) {
    return form.querySelector('[name="' + name + '"]');
  }
  function fields(form) {
    const names = ['id', 'title', 'counterparty', 'category', 'startDate',
      'endDate', 'amount', 'owner', 'notify', 'notes', 'autoRenew'];
    const o = {};
    names.forEach((n) => { o[n] = fld(form, n); });
    return o;
  }

  /* ───────────────────────────────────────────── 合同表单 */
  function blankContract() {
    return {
      id: '', title: '', counterparty: '', category: '', startDate: '', endDate: '',
      amount: '', currency: 'CNY', autoRenew: false, owner: '', notify: [], notes: '', payments: []
    };
  }

  function openContract(id) {
    state.editingId = id || null;
    const c = id ? state.data.contracts.find((x) => x.id === id) : null;
    const src = c ? JSON.parse(JSON.stringify(c)) : blankContract();
    state.paymentsDraft = (src.payments || []).map((p) => Object.assign({}, p));

    const f = $('#contractForm');
    const F = fields(f);
    f.reset();
    F.id.value = src.id || '';
    F.title.value = src.title || '';
    F.counterparty.value = src.counterparty || '';
    F.category.value = src.category || '';
    F.startDate.value = src.startDate || '';
    F.endDate.value = src.endDate || '';
    F.amount.value = src.amount === '' || src.amount === null || src.amount === undefined ? '' : src.amount;
    F.owner.value = src.owner || '';
    F.notify.value = (src.notify || []).join(', ');
    F.notes.value = src.notes || '';
    F.autoRenew.checked = !!src.autoRenew;
    $$('.field input', f).forEach((i) => i.classList.remove('invalid'));

    $('#contractModalTitle').textContent = c ? '编辑合同' : '新增合同';
    $('#btnDeleteContract').hidden = !c;
    renderPayments();
    updateEndDateHint();
    openModal('contractBackdrop');
    guardModal('contractBackdrop', snapshotContractForm);
  }

  /** 合同表单当前内容的序列化 —— 用来判断「有没有被改过」 */
  function snapshotContractForm() {
    const F = fields($('#contractForm'));
    syncPaymentsFromDom(); // 把付款行的最新值收进 draft，保证快照不落后于界面
    return JSON.stringify({
      id: F.id.value,
      title: F.title.value,
      counterparty: F.counterparty.value,
      category: F.category.value,
      startDate: F.startDate.value,
      endDate: F.endDate.value,
      amount: F.amount.value,
      owner: F.owner.value,
      notify: F.notify.value,
      notes: F.notes.value,
      autoRenew: F.autoRenew.checked,
      payments: state.paymentsDraft
    });
  }

  function renderPayments() {
    const wrap = $('#payList');
    $('#payEmpty').hidden = state.paymentsDraft.length > 0;
    wrap.innerHTML = state.paymentsDraft.map((p, i) => `
      <div class="pay-row" data-i="${i}">
        <input type="text" data-k="label" value="${esc(p.label || '')}" placeholder="如：第一期">
        <input type="date" data-k="dueDate" value="${esc(p.dueDate || '')}">
        <input type="number" data-k="amount" min="0" step="0.01" value="${p.amount === undefined || p.amount === null || p.amount === '' ? '' : esc(p.amount)}" placeholder="金额">
        <label class="pay-state"><input type="checkbox" data-k="paid" ${p.paid ? 'checked' : ''}> 已付</label>
        <button type="button" class="pay-del" data-del="${i}" title="删除这一期">✕</button>
      </div>`).join('');
  }

  function syncPaymentsFromDom() {
    $$('#payList .pay-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const p = state.paymentsDraft[i];
      if (!p) return;
      p.label = $('[data-k=label]', row).value.trim();
      p.dueDate = $('[data-k=dueDate]', row).value;
      const amt = $('[data-k=amount]', row).value;
      p.amount = amt === '' ? 0 : Number(amt);
      p.paid = $('[data-k=paid]', row).checked;
      if (p.paid && !p.paidDate) p.paidDate = state.today;
      if (!p.paid) p.paidDate = null;
      if (!p.id) p.id = 'p' + (i + 1);
    });
  }

  function updateEndDateHint() {
    const el = fld($('#contractForm'), 'endDate');
    const v = el ? el.value : '';
    const hint = $('#endDateHint');
    if (!v) { hint.textContent = ''; hint.className = 'hint'; return; }
    const d = L.remainingDays(v, state.today);
    if (d === null) { hint.textContent = '日期无效'; hint.className = 'hint warn'; return; }
    const risk = L.riskOf(d);
    hint.textContent = `${L.remainingLabel(d)} · ${risk.label}`;
    hint.className = 'hint ' + (risk.key === 'expired' || risk.key === 'd30' ? 'warn' : 'ok');
  }

  function nextId() {
    let max = 0;
    state.data.contracts.forEach((c) => {
      const m = /^c-(\d+)$/.exec(c.id || '');
      if (m) max = Math.max(max, Number(m[1]));
    });
    return 'c-' + String(max + 1).padStart(3, '0');
  }

  async function saveContract() {
    const f = $('#contractForm');
    const F = fields(f);
    const title = F.title.value.trim();
    const endDate = F.endDate.value;
    let bad = false;
    [['title', title], ['endDate', endDate]].forEach(([name, v]) => {
      F[name].classList.toggle('invalid', !v);
      if (!v) bad = true;
    });
    if (bad) { toast('请填写合同名称和到期日期', 'err'); return; }

    syncPaymentsFromDom();
    const notify = F.notify.value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const prev = state.editingId ? state.data.contracts.find((c) => c.id === state.editingId) : null;

    const rec = {
      id: state.editingId || nextId(),
      title,
      counterparty: F.counterparty.value.trim(),
      category: F.category.value.trim(),
      startDate: F.startDate.value,
      endDate,
      amount: F.amount.value === '' ? 0 : Number(F.amount.value),
      currency: (prev && prev.currency) || 'CNY',
      autoRenew: F.autoRenew.checked,
      owner: F.owner.value.trim(),
      notify,
      notes: F.notes.value.trim(),
      updatedAt: state.today,
      payments: state.paymentsDraft.map((p, i) => ({
        id: p.id || ('p' + (i + 1)),
        label: p.label || ('第 ' + (i + 1) + ' 期'),
        dueDate: p.dueDate || '',
        amount: Number(p.amount) || 0,
        paid: !!p.paid,
        paidDate: p.paidDate || null
      }))
    };

    const backup = JSON.stringify(state.data);   // 提交失败时回滚，避免内存与仓库不一致
    const idx = state.data.contracts.findIndex((c) => c.id === rec.id);
    if (idx >= 0) state.data.contracts[idx] = rec;
    else state.data.contracts.push(rec);

    const r = await saveData(`${idx >= 0 ? '更新' : '新增'}合同：${title}`);
    if (!r.ok) {
      state.data = JSON.parse(backup);           // 保留表单内容，让用户可以重试
      renderAll();
      return;
    }
    closeModal('contractBackdrop');
    renderAll();
    toast(`已保存并提交：${title}`, 'ok');
  }

  async function deleteContract() {
    const id = state.editingId;
    const c = state.data.contracts.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`确定删除「${c.title}」？\n\n删除后其提醒档位也会一并失效，此操作不可撤销。`)) return;

    const backup = JSON.stringify(state.data);
    state.data.contracts = state.data.contracts.filter((x) => x.id !== id);
    const r = await saveData(`删除合同：${c.title}`);
    if (!r.ok) {
      state.data = JSON.parse(backup);
      renderAll();
      return;
    }
    closeModal('contractBackdrop');
    renderAll();
  }

  /* ───────────────────────────────────────────── 设置 */
  function openSettings() {
    const c = dataConfig();
    $('#setToken').value = c.token;
    $('#setOwner').value = c.owner;
    $('#setRepo').value = c.repo;
    $('#setBranch').value = c.branch;
    $('#setContractsPath').value = c.contractsPath;
    $('#setLogPath').value = c.logPath;

    const s = state.data.settings;
    $('#setRecipients').value = (s.recipients || []).join(', ');
    $('#setTiers').value = (s.renewalTiers || L.DEFAULT_TIERS).join(',');
    $('#setRepeat').value = s.expiredRepeatDays || L.DEFAULT_REPEAT_DAYS;
    $('#connState').textContent = '';
    $('#connState').className = 'conn-state';
    openModal('settingsBackdrop');
    guardModal('settingsBackdrop', snapshotSettingsForm);
  }

  /** 设置表单当前内容的序列化 */
  function snapshotSettingsForm() {
    return JSON.stringify({
      token: $('#setToken').value,
      owner: $('#setOwner').value,
      repo: $('#setRepo').value,
      branch: $('#setBranch').value,
      contractsPath: $('#setContractsPath').value,
      logPath: $('#setLogPath').value,
      recipients: $('#setRecipients').value,
      tiers: $('#setTiers').value,
      repeat: $('#setRepeat').value
    });
  }

  async function saveSettings() {
    // 1) 凭据 → 只进浏览器 localStorage，永不写入任何仓库
    store.set(LS.token, $('#setToken').value.trim());
    store.set(LS.owner, $('#setOwner').value.trim() || DEFAULT_DATA_REPO.owner);
    store.set(LS.repo, $('#setRepo').value.trim() || DEFAULT_DATA_REPO.repo);
    store.set(LS.branch, $('#setBranch').value.trim() || 'main');
    store.set(LS.contractsPath, $('#setContractsPath').value.trim() || DEFAULT_DATA_REPO.contractsPath);
    store.set(LS.logPath, $('#setLogPath').value.trim() || DEFAULT_DATA_REPO.logPath);

    // 2) 提醒规则先暂存 —— 它们要写进数据仓库，不能写进 localStorage
    const pending = {
      recipients: $('#setRecipients').value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
      tiers: $('#setTiers').value.split(',').map((x) => Number(x.trim())).filter((x) => isFinite(x) && x >= 0),
      repeat: Number($('#setRepeat').value)
    };

    closeModal('settingsBackdrop');

    if (!dataReady()) {
      toast('凭据已保存到浏览器，但仓库信息不完整，无法连接', 'err');
      renderAll();
      return;
    }

    // 3) 凭据刚变过、或还没连上 → 先把远端数据读进来，规则才有地方放
    if (state.loaded !== dataKey()) {
      await loadAll();
      if (state.loaded !== dataKey()) {
        toast('连接数据仓库失败，提醒规则未保存', 'err');
        return;
      }
    }

    // 4) 应用规则并写回数据仓库的 contracts.js
    state.data.settings.recipients = pending.recipients;
    if (pending.tiers.length) state.data.settings.renewalTiers = pending.tiers.sort((a, b) => b - a);
    if (isFinite(pending.repeat) && pending.repeat > 0) state.data.settings.expiredRepeatDays = Math.floor(pending.repeat);

    const r = await saveData('chore: 更新提醒设置');
    if (r.ok) {
      renderAll();
      toast('设置已保存到数据仓库', 'ok');
    }
  }

  async function testGitHub() {
    // 测试前先把表单里的凭据写进存储（不写规则，测试连接不该产生提交）
    store.set(LS.token, $('#setToken').value.trim());
    store.set(LS.owner, $('#setOwner').value.trim() || DEFAULT_DATA_REPO.owner);
    store.set(LS.repo, $('#setRepo').value.trim() || DEFAULT_DATA_REPO.repo);
    store.set(LS.branch, $('#setBranch').value.trim() || 'main');
    store.set(LS.contractsPath, $('#setContractsPath').value.trim() || DEFAULT_DATA_REPO.contractsPath);
    store.set(LS.logPath, $('#setLogPath').value.trim() || DEFAULT_DATA_REPO.logPath);

    const st = $('#connState');
    st.textContent = '测试中…';
    st.className = 'conn-state';
    if (!dataReady()) {
      st.textContent = '请先填写 Token / 仓库所有者 / 仓库名';
      st.className = 'conn-state err';
      return;
    }
    try {
      const name = await ghTest();
      await loadAll();
      if (state.loaded === dataKey()) {
        st.textContent = `✅ 已连接 ${name}`;
        st.className = 'conn-state ok';
        toast('数据仓库连接成功', 'ok');
      } else {
        st.textContent = `⚠ 仓库 ${name} 可达，但读取数据文件失败`;
        st.className = 'conn-state err';
      }
    } catch (e) {
      st.textContent = '❌ ' + e.message;
      st.className = 'conn-state err';
    }
  }

  /* ───────────────────────────────────────────── 事件绑定 */
  function bind() {
    $('#btnNew').addEventListener('click', () => openContract(null));
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnGoSetup').addEventListener('click', openSettings);
    $('#btnRefresh').addEventListener('click', async () => {
      await loadAll();
      toast('已重新加载', 'ok');
    });

    $('#searchInput').addEventListener('input', (e) => { state.filters.q = e.target.value; renderTable(); });
    $('#riskFilter').addEventListener('change', (e) => { state.filters.risk = e.target.value; renderTable(); });
    $('#categoryFilter').addEventListener('change', (e) => { state.filters.category = e.target.value; renderTable(); });
    $('#sortSelect').addEventListener('change', (e) => { state.filters.sort = e.target.value; renderTable(); });

    $('#tableBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-edit]');
      const tr = e.target.closest('tr[data-id]');
      if (btn) { e.stopPropagation(); openContract(btn.dataset.edit); return; }
      if (tr) openContract(tr.dataset.id);
    });

    $('#btnSaveContract').addEventListener('click', saveContract);
    $('#btnDeleteContract').addEventListener('click', deleteContract);
    fld($('#contractForm'), 'endDate').addEventListener('change', updateEndDateHint);
    $('#contractForm').addEventListener('submit', (e) => { e.preventDefault(); saveContract(); });

    $('#btnAddPayment').addEventListener('click', () => {
      syncPaymentsFromDom();
      state.paymentsDraft.push({ id: 'p' + (state.paymentsDraft.length + 1), label: '', dueDate: '', amount: 0, paid: false, paidDate: null });
      renderPayments();
      const rows = $$('#payList .pay-row');
      const last = rows[rows.length - 1];
      if (last) $('[data-k=label]', last).focus();
    });

    $('#payList').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      syncPaymentsFromDom();
      state.paymentsDraft.splice(Number(del.dataset.del), 1);
      renderPayments();
    });

    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $('#btnTestGitHub').addEventListener('click', testGitHub);
    $('#btnClearGitHub').addEventListener('click', () => {
      store.del(LS.token); store.del(LS.owner); store.del(LS.repo); store.del(LS.branch);
      $('#setToken').value = ''; $('#setOwner').value = ''; $('#setRepo').value = '';
      $('#connState').textContent = '已断开';
      $('#connState').className = 'conn-state';
      setMode('local', '本地模式');
      toast('已断开 GitHub', 'ok');
    });
    $('#btnToggleToken').addEventListener('click', () => {
      const i = $('#setToken');
      const show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      $('#btnToggleToken').textContent = show ? '隐藏' : '显示';
    });

    $('#btnExportJson').addEventListener('click', () => {
      download('contracts-backup.json', JSON.stringify(state.data, null, 2), 'application/json');
      toast('已导出 JSON 备份', 'ok');
    });
    $('#btnDownloadJs').addEventListener('click', () => {
      download('contracts.js', serialize(state.data), 'application/javascript');
      toast('已下载 contracts.js', 'ok');
    });
    $('#btnImportJson').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = L.normalizeData(JSON.parse(text));
        if (!confirm(`导入将覆盖当前全部 ${state.data.contracts.length} 份合同，确定继续？`)) return;
        state.data = parsed;
        await saveData('导入合同数据');
        renderAll();
        toast('导入成功', 'ok');
      } catch (err) {
        toast('导入失败：' + err.message, 'err');
      }
    });

    $('#alertsToggle').addEventListener('click', () => {
      const body = $('#alertsBody');
      const open = body.hidden;
      body.hidden = !open;
      $('#alertsToggle').setAttribute('aria-expanded', String(open));
    });
    $('#alertsCount').addEventListener('click', (e) => {
      e.stopPropagation();
      openModal('alertsBackdrop');
    });
  }

  /* ───────────────────────────────────────────── 启动 */
  function init() {
    bind();
    loadAll().catch((e) => {
      console.error(e);
      toast('加载失败：' + e.message, 'err');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
