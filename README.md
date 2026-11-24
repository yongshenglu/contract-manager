# 合同管理 · 到期续签与付款提醒

一个**零服务器**的合同管理工具。架构是**两个仓库**：

| 仓库 | 可见性 | 内容 |
|---|---|---|
| **`contract-manager`**（本仓库） | 🌐 公开 | 只有代码：看板、规则引擎、定时任务。**不含任何合同数据** |
| **`contract-manager-data`** | 🔒 私有 | 合同数据 `contracts.js` + 提醒发送记录 `sent-log.json` |

公开看板通过 GitHub Contents API 读写私有数据仓库，凭据（Token）只存在你自己浏览器的 localStorage 里，**不进任何仓库**。定时提醒由本仓库的 Actions 跑，用 `DATA_TOKEN` 跨仓库读数据、回写记录。

- 📅 **风险分级**：已过期 / 30 天内 / 90 天内 / 正常，剩余天数倒计时
- 🔔 **分级预警**：T-90 / T-60 / T-30 / T-7 / 到期当天，**每档只提醒一次**
- 🔁 **逾期追踪**：合同已过期、分期付款已逾期，**每 7 天追一次**
- 💰 **分期付款**：任意期数、金额不等、单独标记已付
- 📧 **邮件汇总**：每天一封，按收件人分组，只发新触发的条目

---

## 首次使用（3 步）

### 1. 给数据仓库建一个 Token

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

- **Repository access**：Only select repositories → 勾 `contract-manager-data`
- **Permissions → Repository permissions → Contents**：`Read and write`
- 有效期按需（建议 1 年，到期重建即可）

> 普通的 classic token 也能用（勾 `repo` 权限），但权限过大，建议用 fine-grained。

### 2. 打开看板并填 Token

访问 `<你的用户名>.github.io/contract-manager/`，右上角 **设置** → 粘贴 Token → **测试连接**。

其余字段都有默认值（`yongshenglu/contract-manager-data`），fork 改仓库名时才需要动。

### 3. 配 Actions 的 Secrets 和 Variables

页面仓库 → **Settings → Secrets and variables → Actions**

**Secrets**（密文）：

| 名 | 值 |
|---|---|
| `DATA_TOKEN` | 第 1 步建的 Token（Actions 跨仓库读写用） |
| `SMTP_HOST` | `smtp.qq.com` 或 `smtp.163.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | 发件邮箱 |
| `SMTP_PASS` | **SMTP 授权码**，不是登录密码 |
| `MAIL_FROM` | 发件邮箱 |
| `MAIL_TO` | 兜底收件人（合同没配收件人时用） |
| `PAGE_URL` | 看板地址，可选，邮件页脚链接 |

**Variables**（明文，可选，不填则用脚本内置默认值）：

| 名 | 默认 |
|---|---|
| `DATA_OWNER` | `yongshenglu` |
| `DATA_REPO` | `contract-manager-data` |
| `DATA_BRANCH` | `main` |
| `DATA_CONTRACTS_PATH` | `contracts.js` |
| `DATA_LOG_PATH` | `sent-log.json` |

**收件人按三层取值，谁先有值用谁**：

1. 合同自己的 `notify`
2. 数据文件里 `settings.recipients`
3. `MAIL_TO`（兜底）

三层都没有则跳过该条提醒。数据仓库里的 `settings.recipients` 现在是空的，**改之前所有提醒都靠 `MAIL_TO` 兜底**，建议在看板「设置 → 提醒规则」里填上。

---

## 发布到 GitHub Pages

1. 页面仓库 → **Settings → Pages**
2. **Source** 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`
3. 等约 1 分钟，访问 `https://<用户名>.github.io/contract-manager/`

本仓库是公开的，**Pages 免费**。定时任务的 cron 也会在这个仓库里跑。

> 换别处托管也行（Cloudflare Pages 等），代码完全通用——页面只依赖 `api.github.com`。

---

## 目录结构

```
├── index.html              看板页面
├── style.css               样式
├── app.js                  前端逻辑（渲染 / 表单 / 数据仓库 API）
├── lib.js                  核心规则（风险分级、档位计算）—— 网页与脚本共用
├── scripts/
│   ├── check.js            算档位 + SMTP 发信 + 打码日志
│   ├── data-io.js          读写私有数据仓库（fetch / push-log / check）
│   ├── test.js             核心规则单元测试
│   └── ui-test.js          前端冒烟测试（jsdom + 模拟数据仓库 API）
├── .github/workflows/
│   └── remind.yml          每日定时任务
├── package.json
└── data/                   ← gitignored，由 data-io.js fetch 生成，不进本仓库
```

---

## 提醒规则

### 风险分级

| 剩余天数 `d` | 分级 | 颜色 |
|---|---|---|
| `d < 0` | 已过期 | 🔴 |
| `0 ≤ d ≤ 30` | 30 天内 | 🟠 |
| `30 < d ≤ 90` | 90 天内 | 🟡 |
| `d > 90` | 正常 | 🟢 |

### 提醒档位（续签 与 分期付款 共用）

| 档位 | 触发条件 | 频率 |
|---|---|---|
| `T-90` / `T-60` / `T-30` / `T-7` | 剩余 ≤ 对应天数 | **各一次** |
| `T-0` | 到期当天 | 一次 |
| `已过期` / `已逾期` | 已经过期 | **每 7 天一次** |

**两个关键行为：**

1. **只发最紧急的一档。** 今天新录一份 10 天后到期的合同，不会一口气发 4 封，只发 `T-7`。
2. **漏跑不漏发。** 判断条件是 `剩余天数 ≤ 档位值`，Actions 挂几天再恢复，该补的档位会补上。

**提醒键包含目标日期**（`合同ID | 到期日 | 类型 | 档位`），所以改了 `endDate` 所有档位会**自动重新武装**，不用手动重置。

---

## 数据字段

数据在私有仓库的 `contracts.js`，外壳 `window.CONTRACTS = { ... };` 不要动。

### 顶层 `settings`

| 字段 | 说明 |
|---|---|
| `recipients` | 默认收件人，字符串数组 |
| `renewalTiers` | 提醒档位（天），默认 `[90,60,30,7,0]` |
| `expiredRepeatDays` | 过期/逾期追发周期，默认 `7` |

### 每份合同

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识，如 `c-001` |
| `title` | ✅ | 合同名称 |
| `counterparty` / `category` / `owner` / `notes` | | 对方、类别、负责人、备注 |
| `startDate` / `endDate` | `endDate` ✅ | `YYYY-MM-DD`，**`endDate` 决定分级和续签提醒** |
| `amount` / `currency` | | 合同总金额（`CNY`/`USD`/`EUR`） |
| `autoRenew` | | 是否含自动续签条款 |
| `notify` | | **覆盖默认收件人**，留空 `[]` 则用 `settings.recipients` |

### 每期付款（`payments` 数组）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | `p1`、`p2`… |
| `label` | | 款项名称 |
| `dueDate` | ✅ | `YYYY-MM-DD` |
| `amount` | | 本期金额 |
| `paid` | | `true` = 已付，**已付的不再提醒** |
| `paidDate` | | 实际付款日期 |

---

## 测试与调试

```powershell
npm install

# 1) 核心规则（66 项断言，不需要数据）
npm test

# 2) 前端冒烟（71 项，自带 fixture，不依赖数据仓库）
npm run test:ui

# 3) 拉一次数据，然后本地预览
$env:DATA_TOKEN = "<你的 Token>"
node scripts/data-io.js fetch
npm run preview            # 今天会发哪些提醒？不发信
npm run preview-all        # 忽略已发送记录看全量

# 4) 导出邮件 HTML，浏览器里先看效果
node scripts/check.js --dry-run --all --out preview.html

# 5) 模拟任意日期
node scripts/check.js --dry-run --date 2026-12-24

# 6) 验证 SMTP（真发一封测试信）
$env:SMTP_HOST="smtp.163.com"; $env:SMTP_PORT="465"
$env:SMTP_USER="you@163.com"; $env:SMTP_PASS="授权码"
$env:MAIL_TO="you@163.com"
node scripts/check.js --test

# 7) 查看当前数据仓库配置
node scripts/data-io.js check
```

---

## 常见问题

**Q：打开看板是空的，提示「尚未连接数据仓库」？**
正常——公开页面不含数据。到「设置」填 Token 即可。Token 只存在你浏览器里。

**Q：本地双击 `index.html` 用不了？**
双击打开时浏览器禁止 `localStorage` 的情况很少，但 `file://` 下部分浏览器会限制。起个本地服务器最稳：
```powershell
python -m http.server 8080
```

**Q：Actions 报「缺少 DATA_TOKEN」？**
页面仓库 Secrets 里配 `DATA_TOKEN`，且该 Token 对数据仓库有 **Contents: Read and write**。

**Q：邮件发不出去？**
- 用的是**授权码**不是登录密码
- `SMTP_PORT=465`，`SMTP_HOST` 是 `smtp.qq.com` / `smtp.163.com`
- 先在邮箱网页端**开启 SMTP 服务**

**Q：提醒没发？**
- 看 Actions 日志，`--dry-run` 会列出本次该发的条目
- 数据仓库的 `sent-log.json` 记着每个档位的发送日期
- **收件人三层都为空会直接跳过**——先在设置里填 `settings.recipients` 或 `MAIL_TO`

**Q：为什么日志里邮箱是 `v***@…`？**
本仓库是公开的，Actions 日志所有人可见，所以脚本把邮箱打码了。本地想看完整地址：`$env:DEBUG_EMAIL="1"`。

**Q：定时任务停了？**
仓库 60 天无活动会自动停用 cron，随便提交一次即可恢复。

---

## 技术说明

- **无构建、无框架**；`nodemailer` 只有发信脚本用，`jsdom` 只有测试用
- 日期计算用 UTC 日编号做整数差，避免时区和夏令时导致的 1 天误差
- 前端与脚本共用 `lib.js`，规则只有一份实现
- 保存前会校验「数据确实是从当前这个仓库读来的」，防止换仓库后没重新加载就把远端覆盖成空
- 提交失败会回滚内存状态并保持弹窗打开，不会出现「界面关了但没存上」
