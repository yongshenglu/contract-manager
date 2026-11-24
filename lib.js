/**
 * 合同管理核心逻辑 —— 浏览器与 Node 共用，无任何依赖。
 *
 * 规则：
 *   风险分级  d<0 已过期 | 0<=d<=30 30天内 | 30<d<=90 90天内 | d>90 正常
 *   提醒档位  T-90 / T-60 / T-30 / T-7 / T-0（到期当天），每档只提醒一次
 *   已过期    每 expiredRepeatDays 天追一次（默认 7）
 *   分期付款  与续签共用同一套档位；未付款且过期 → 已逾期，每周追一次
 *
 * 日期一律转成「UTC 日编号」做整数差，避免时区和夏令时带来的 1 天误差。
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ContractLib = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_TIERS = [90, 60, 30, 7, 0];
  var DEFAULT_REPEAT_DAYS = 7;

  var RISK_LEVELS = [
    { key: 'expired', label: '已过期', text: '#b3261e', bg: '#fdecea', border: '#f6c7c4' },
    { key: 'd30',     label: '30 天内', text: '#c2410c', bg: '#fff4e5', border: '#fed7aa' },
    { key: 'd90',     label: '90 天内', text: '#9a6700', bg: '#fef9c3', border: '#fde68a' },
    { key: 'normal',  label: '正常',    text: '#15803d', bg: '#ecfdf3', border: '#bbf7d0' }
  ];

  /* ------------------------------------------------------------------ 日期 */

  /** 'YYYY-MM-DD' -> UTC 日编号（整数）；非法返回 null */
  function toDayNumber(s) {
    if (s === null || s === undefined) return null;
    var str = String(s).trim().slice(0, 10);
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var n = Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
    // 反查校验，挡住 2026-02-31 这类日期
    var back = new Date(n * 86400000);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return null;
    return n;
  }

  /** UTC 日编号 -> 'YYYY-MM-DD' */
  function fromDayNumber(n) {
    var dt = new Date(n * 86400000);
    return dt.getUTCFullYear() + '-' +
      String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(dt.getUTCDate()).padStart(2, '0');
  }

  /** 本机今天的 'YYYY-MM-DD' */
  function localToday(now) {
    now = now || new Date();
    return now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
  }

  /** 剩余天数：target - today（负数 = 已过期） */
  function remainingDays(target, today) {
    var a = toDayNumber(target);
    var b = toDayNumber(today === undefined ? localToday() : today);
    if (a === null || b === null) return null;
    return a - b;
  }

  function addDays(dateStr, n) {
    var d = toDayNumber(dateStr);
    if (d === null) return null;
    return fromDayNumber(d + n);
  }

  function weekdayCN(dateStr) {
    var n = toDayNumber(dateStr);
    if (n === null) return '';
    return '周' + '日一二三四五六'[new Date(n * 86400000).getUTCDay()];
  }

  /* -------------------------------------------------------------- 风险分级 */

  function riskOf(days) {
    if (days === null || days === undefined) {
      return RISK_LEVELS[3];
    }
    if (days < 0) return RISK_LEVELS[0];
    if (days <= 30) return RISK_LEVELS[1];
    if (days <= 90) return RISK_LEVELS[2];
    return RISK_LEVELS[3];
  }

  function remainingLabel(days) {
    if (days === null || days === undefined) return '日期无效';
    if (days < 0) return '已过期 ' + (-days) + ' 天';
    if (days === 0) return '今天到期';
    return '剩 ' + days + ' 天';
  }

  function tierLabel(tier) {
    if (tier === 'EXPIRED') return '已过期';
    if (tier === 'OVERDUE') return '已逾期';
    return tier;
  }

  /* ------------------------------------------------------------ 档位计算 */

  function normalizeTiers(data) {
    var t = data && data.settings && data.settings.renewalTiers;
    if (!Array.isArray(t) || !t.length) return DEFAULT_TIERS.slice();
    var out = t
      .map(function (x) { return Number(x); })
      .filter(function (x) { return isFinite(x) && x >= 0; })
      .sort(function (a, b) { return b - a; }); // 从大到小 90,60,30,7,0
    return out.length ? out : DEFAULT_TIERS.slice();
  }

  function repeatDays(data) {
    var r = data && data.settings && data.settings.expiredRepeatDays;
    r = Number(r);
    return isFinite(r) && r > 0 ? Math.floor(r) : DEFAULT_REPEAT_DAYS;
  }

  /**
   * 给定剩余天数，算出「本次应该触发哪一档」。
   * 只返回最紧急的那一档 —— 新录入的临期合同不会一次连发 4 封。
   * 返回 null 表示还没到任何档位。
   */
  function pickTier(days, tiers) {
    if (days === null || days === undefined) return null;
    if (days < 0) return 'EXPIRED';
    var crossed = tiers.filter(function (t) { return days <= t; });
    if (!crossed.length) return null;
    var min = crossed[0];
    for (var i = 1; i < crossed.length; i++) if (crossed[i] < min) min = crossed[i];
    return 'T-' + min;
  }

  function isRepeatTier(tier) {
    return tier === 'EXPIRED' || tier === 'OVERDUE';
  }

  /* -------------------------------------------------------------- 数据解析 */

  /**
   * 兼容三种写法：
   *   window.CONTRACTS = { ... };
   *   module.exports = { ... };
   *   纯 JSON { ... }
   */
  function parseDataFile(src) {
    var s = String(src)
      .split('\n')
      .filter(function (line) { return !/^\s*\/\//.test(line); })
      .join('\n');
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('数据文件格式错误：找不到 JSON 对象');
    var obj = JSON.parse(s.slice(start, end + 1));
    if (!obj || typeof obj !== 'object') throw new Error('数据文件格式错误：顶层必须是对象');
    if (!Array.isArray(obj.contracts)) obj.contracts = [];
    if (!obj.settings) obj.settings = {};
    return obj;
  }

  function defaultSettings() {
    return {
      timezone: 'Asia/Shanghai',
      recipients: [],
      renewalTiers: DEFAULT_TIERS.slice(),
      expiredRepeatDays: DEFAULT_REPEAT_DAYS
    };
  }

  function normalizeData(raw) {
    var data = raw || {};
    var settings = Object.assign(defaultSettings(), data.settings || {});
    if (!Array.isArray(settings.recipients)) settings.recipients = [];
    var contracts = (Array.isArray(data.contracts) ? data.contracts : []).map(function (c, i) {
      c = c || {};
      c.id = c.id || ('c-' + String(i + 1).padStart(3, '0'));
      if (!Array.isArray(c.payments)) c.payments = [];
      c.payments = c.payments.map(function (p, j) {
        p = p || {};
        p.id = p.id || ('p' + (j + 1));
        if (typeof p.paid !== 'boolean') p.paid = !!p.paid;
        return p;
      });
      return c;
    });
    return {
      version: data.version || 1,
      settings: settings,
      contracts: contracts
    };
  }

  /* ------------------------------------------------------------ 提醒评估 */

  function recipientsOf(contract, settings) {
    if (Array.isArray(contract.notify) && contract.notify.length) {
      return contract.notify.filter(Boolean);
    }
    return (settings.recipients || []).filter(Boolean);
  }

  /**
   * 计算「本次应当发送」的提醒。
   * @param data     合同数据（已 normalize）
   * @param sentLog  { entries: { "key": "YYYY-MM-DD" } }
   * @param todayStr 'YYYY-MM-DD'
   * @param opts     { ignoreLog: true,          忽略已发送记录（预览全部）
   *                   fallbackRecipients: [] }  合同没配收件人时的兜底地址
   * @returns { due: Alert[], checked: number }
   */
  function evaluate(data, sentLog, todayStr, opts) {
    opts = opts || {};
    data = normalizeData(data);
    var today = todayStr || localToday();
    var todayN = toDayNumber(today);
    var tiers = normalizeTiers(data);
    var repeat = repeatDays(data);
    var entries = (sentLog && sentLog.entries) || {};
    var due = [];
    var checked = 0;

    function consider(o) {
      checked++;
      var tier = o.tier;
      if (!tier) return;
      var key = [o.contractId, o.targetDate, o.kind, tier].join('|');
      if (!opts.ignoreLog) {
        var last = entries[key];
        if (last !== undefined && last !== null) {
          if (!isRepeatTier(tier)) return;                 // 普通档位：只发一次
          var lastN = toDayNumber(last);
          if (lastN !== null && todayN - lastN < repeat) return; // 追发未到周期
        }
      }
      // 合同自己的 notify → 数据里的默认 recipients → MAIL_TO 兜底
      var recips = (o.recipients && o.recipients.length)
        ? o.recipients
        : (opts.fallbackRecipients || []);
      if (!recips || !recips.length) return;              // 三层都没有，跳过
      due.push(Object.assign({}, o, { key: key, tier: tier, recipients: recips }));
    }

    data.contracts.forEach(function (c) {
      var recips = recipientsOf(c, data.settings);
      if (!c.endDate) return;

      var rDays = remainingDays(c.endDate, today);
      consider({
        kind: 'renewal',
        contractId: c.id,
        title: c.title || '(未命名合同)',
        counterparty: c.counterparty || '',
        owner: c.owner || '',
        category: c.category || '',
        targetDate: c.endDate,
        days: rDays,
        tier: pickTier(rDays, tiers),
        amount: Number(c.amount) || 0,
        autoRenew: !!c.autoRenew,
        recipients: recips
      });

      (c.payments || []).forEach(function (p) {
        if (p.paid || !p.dueDate) return;
        var pDays = remainingDays(p.dueDate, today);
        consider({
          kind: 'payment',
          contractId: c.id,
          paymentId: p.id,
          paymentLabel: p.label || '分期款',
          title: c.title || '(未命名合同)',
          counterparty: c.counterparty || '',
          owner: c.owner || '',
          category: c.category || '',
          targetDate: p.dueDate,
          days: pDays,
          tier: pDays < 0 ? 'OVERDUE' : pickTier(pDays, tiers),
          amount: Number(p.amount) || 0,
          recipients: recips
        });
      });
    });

    // 排序：最紧急的排前面
    var order = { EXPIRED: 0, OVERDUE: 1, 'T-0': 2, 'T-7': 3, 'T-30': 4, 'T-60': 5, 'T-90': 6 };
    due.sort(function (a, b) {
      var oa = order[a.tier] !== undefined ? order[a.tier] : 9;
      var ob = order[b.tier] !== undefined ? order[b.tier] : 9;
      if (oa !== ob) return oa - ob;
      return (a.days || 0) - (b.days || 0);
    });

    return { due: due, checked: checked, today: today, tiers: tiers };
  }

  /* ------------------------------------------------------------ 看板统计 */

  function contractSummary(c, today) {
    var payments = c.payments || [];
    var paidCount = payments.filter(function (p) { return p.paid; }).length;
    var totalAmount = payments.reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0);
    var paidAmount = payments
      .filter(function (p) { return p.paid; })
      .reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0);
    var outstanding = payments
      .filter(function (p) { return !p.paid; })
      .reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0);
    var overduePayments = payments.filter(function (p) {
      return !p.paid && p.dueDate && remainingDays(p.dueDate, today) < 0;
    });
    var days = c.endDate ? remainingDays(c.endDate, today) : null;
    return {
      days: days,
      risk: riskOf(days),
      paymentCount: payments.length,
      paidCount: paidCount,
      totalAmount: totalAmount,
      paidAmount: paidAmount,
      outstanding: outstanding,
      overduePaymentCount: overduePayments.length
    };
  }

  function summarize(data, today) {
    data = normalizeData(data);
    today = today || localToday();
    var counts = { expired: 0, d30: 0, d90: 0, normal: 0 };
    var outstanding = 0;
    var overduePayments = 0;
    var nextExpiry = null;

    data.contracts.forEach(function (c) {
      var s = contractSummary(c, today);
      counts[s.risk.key]++;
      outstanding += s.outstanding;
      overduePayments += s.overduePaymentCount;
      if (s.days !== null && s.days >= 0) {
        if (nextExpiry === null || s.days < nextExpiry.days) {
          nextExpiry = { days: s.days, title: c.title, date: c.endDate };
        }
      }
    });

    return {
      total: data.contracts.length,
      counts: counts,
      outstanding: outstanding,
      overduePayments: overduePayments,
      nextExpiry: nextExpiry
    };
  }

  /* -------------------------------------------------------------- 金额格式 */

  function formatMoney(n, currency) {
    n = Number(n) || 0;
    var symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '¥';
    return symbol + n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  return {
    DEFAULT_TIERS: DEFAULT_TIERS,
    DEFAULT_REPEAT_DAYS: DEFAULT_REPEAT_DAYS,
    RISK_LEVELS: RISK_LEVELS,
    toDayNumber: toDayNumber,
    fromDayNumber: fromDayNumber,
    localToday: localToday,
    remainingDays: remainingDays,
    addDays: addDays,
    weekdayCN: weekdayCN,
    riskOf: riskOf,
    remainingLabel: remainingLabel,
    tierLabel: tierLabel,
    normalizeTiers: normalizeTiers,
    repeatDays: repeatDays,
    pickTier: pickTier,
    isRepeatTier: isRepeatTier,
    parseDataFile: parseDataFile,
    normalizeData: normalizeData,
    defaultSettings: defaultSettings,
    recipientsOf: recipientsOf,
    evaluate: evaluate,
    contractSummary: contractSummary,
    summarize: summarize,
    formatMoney: formatMoney
  };
});
