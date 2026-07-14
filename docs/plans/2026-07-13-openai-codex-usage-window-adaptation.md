# OpenAI Codex 用量窗口兼容适配实施计划

> **供 Codex/Claude 执行：** 计划获批并进入项目工作流后，必须依次使用 `executing-plans`、`test-driven-development`、`verification-before-completion`。

**目标：** 同时正确展示和执行旧版 `5h + weekly` 与新观察到的 `weekly-only primary_window`，避免把额度、Token 统计和 reset credits 混成一组含义不清的数据。

**架构：** 新增一个共享的 Codex 限额窗口归一层，按上游 duration 字段判断窗口语义，不再用 `primary_window` / `secondary_window` 的位置猜测 5 小时或周额度。用量格式化、Provider 路由、审计日志、额度健康、预热和前端共同消费该归一模型；保留 raw payload 和旧配置字段以兼容历史数据。

**技术栈：** Node.js ES Modules、Jest、现有原生 JavaScript 管理端与 i18n。

---

## 证据与决策

- 本机 2026-07-13 生成的脱敏缓存中，通用额度只有 `primary_window`，其 `limit_window_seconds=604800`，没有 secondary；Spark 独立额度的 primary 也是 604800 秒。
- 当前 formatter 无条件把 primary 标成 `5h`，因此截图会出现“5 小时额度却在约 7 天后重置”。
- OpenAI 当前公开文档仍描述共享 5 小时窗口，并可能叠加周限制。因此 weekly-only 应被视为账号级/渐进发布/接口形态兼容问题，不能全局删除 5 小时支持。
- 当前分支落后 `origin/main` 15 个提交，但远程 main 仍有相同的位置假设，没有可直接复用的 quota 修复。
- 上游 `f158310` 的 Codex 请求/SSE 稳定性改动有独立价值，但与本问题无关，应另开切片评估，避免干扰额度回归验证。

## 验收标准

1. 旧响应 `primary=18000s`、`secondary=604800s` 仍分别显示并执行 5 小时和周额度。
2. 新响应只有 `primary=604800s` 时只显示一个周额度，页面任何位置都不出现 `(5h)`。
3. Spark weekly-only additional limit 显示为 Spark 周额度，并保持模型范围隔离。
4. Provider Pool 按窗口语义应用阈值；primary 槽位里的周窗口必须使用 weekly 阈值，不能误用 5h 阈值。
5. Request Audit 使用真实窗口语义，不能把 weekly primary 记录为 `5h`。
6. 顶部摘要显示被选中的额度名称，而不是没有上下文的“总用量”。
7. profile 没有当天 bucket 时显示不可用/延迟，不显示精确的 `0`。
8. 最近 7 天 Token 明确标为统计数据，不能与官方周额度混淆。
9. Rate-limit reset credits 保持独立卡片和操作，不参与额度窗口汇总。
10. weekly-only 账号默认跳过基于短窗口的预热；仍保留旧账号的短窗口预热能力。
11. 缓存中的 raw payload 能由新 formatter 重新格式化，无需破坏性迁移缓存文件。

## 不在本切片范围

- 全局删除所有 5h 配置项；官方文档仍表明部分计划/账号存在 5 小时限制。
- 合并 `origin/main` 的全部 15 个提交。
- 修改 OpenAI 凭据、浏览器登录态或私有接口鉴权。
- 把本地 API Potluck 统计当作 OpenAI 官方 quota。
- 未经用户确认安装缺失依赖。

## Task 1：增加脱敏回归 fixture 与归一器测试

**文件：**

- Create: `tests/fixtures/codex-usage-weekly-only.json`
- Create: `tests/codex-rate-limit-normalizer.test.js`
- Modify: `tests/codex-usage-format.test.js`

**步骤：**

1. 新增最小脱敏 fixture，仅保留 plan、通用 weekly primary、Spark weekly primary、reset credit 数量、Token profile 元数据和 bucket；去掉账号标识、邮箱、credit ID、头像和凭据。
2. 先写 snake_case 与 camelCase duration 字段的失败测试。
3. 覆盖以下分类：
   - `18000` 秒 -> `short` / 5 小时。
   - `604800` 秒 -> `weekly`。
   - 其他正数 duration -> `custom`，输出可读时长。
   - 缺少 duration -> `unknown`，仅把源槽位保留为兼容元数据。
4. 断言 weekly-only fixture 的 item 和 label 均不含 `5h`。
5. 运行：

   ```powershell
   npx.cmd jest tests/codex-rate-limit-normalizer.test.js tests/codex-usage-format.test.js --runInBand
   ```

   实现前预期：因当前位置假设而失败。
6. 失败原因符合预期后原子提交：

   ```powershell
   git add tests/fixtures/codex-usage-weekly-only.json tests/codex-rate-limit-normalizer.test.js tests/codex-usage-format.test.js
   git commit -m "test(codex): cover weekly-only usage windows"
   ```

## Task 2：实现共享的窗口语义归一层

**文件：**

- Create: `src/utils/codex-rate-limit.js`
- Modify: `src/services/usage-service.js`

**归一窗口契约：**

```js
{
  id,
  category: 'quota',
  scope: 'general' | 'model',
  limitName,
  sourceWindow: 'primary_window' | 'secondary_window',
  windowKind: 'short' | 'weekly' | 'custom' | 'unknown',
  durationSeconds,
  usedPercent,
  resetAt,
  allowed,
  limitReached
}
```

**步骤：**

1. 解析 `limit_window_seconds`、`limitWindowSeconds`，并兼容可能的分钟字段。
2. 用 5 小时与 7 天附近的窄容差分类；只要 duration 存在，就禁止根据 primary/secondary 猜语义。
3. 通用 `rate_limit` 与所有 `additional_rate_limits` 复用同一归一函数。
4. 保留旧 ID/源槽位以兼容旧客户端，同时增加 `windowKind`、`durationSeconds`、`scope`。
5. 动态生成 label：
   - 通用 short -> `Request Quota (5h)`
   - 通用 weekly -> `Weekly Limit`
   - 模型 short/weekly -> `<limitName> (5h|Weekly)`
   - unknown -> `<limitName or Usage Limit>`，不伪造时长
6. summary 只从通用 quota 窗口选取，使用最高 `usedPercent` 作为当前压力，并返回 `summary.label` / `summary.windowKind`。
7. 重跑 Task 1 测试并提交：

   ```powershell
   git add src/utils/codex-rate-limit.js src/services/usage-service.js tests
   git commit -m "fix(codex): normalize quota windows by duration"
   ```

## Task 3：让路由、额度健康和审计消费语义窗口

**文件：**

- Modify: `src/providers/provider-pool-manager.js`
- Modify: `src/ui-modules/usage-api.js`
- Modify: `src/plugins/model-usage-stats/stats-manager.js`
- Modify: `tests/provider-pool-codex-quota.test.js`
- Modify: `tests/model-usage-account-stats.test.js`

**步骤：**

1. 先写 Provider Pool 失败测试：weekly primary 必须检查 `codexGeneralMaxWeeklyPercent`，不得套用 `codexGeneralMax5hPercent`。
2. 为 Spark/model bucket 增加同类回归测试。
3. 把 primary/secondary 查询改为共享归一器提供的 `short` / `weekly` 查询。
4. 暂时保留已有配置键作为 legacy 阈值，本切片不重命名配置。
5. quota health 按 `scope` 和 `windowKind` 聚合，不再匹配包含 `primary`、`secondary`、`5h` 的字符串。
6. Request Audit 改为记录语义窗口；如已有消费者依赖 `fiveHourPercent` / `weeklyPercent`，仅保留兼容字段并新增明确的 normalized windows。
7. 运行：

   ```powershell
   npx.cmd jest tests/provider-pool-codex-quota.test.js tests/model-usage-account-stats.test.js --runInBand
   ```

8. 提交：

   ```powershell
   git add src/providers/provider-pool-manager.js src/ui-modules/usage-api.js src/plugins/model-usage-stats/stats-manager.js tests/provider-pool-codex-quota.test.js tests/model-usage-account-stats.test.js
   git commit -m "fix(codex): enforce semantic quota windows"
   ```

## Task 4：拆分 quota 与 Token telemetry，并处理 profile 延迟

**文件：**

- Modify: `src/services/usage-service.js`
- Modify: `tests/codex-usage-format.test.js`

**步骤：**

1. 增加失败测试：历史 daily buckets 存在但当天 bucket 缺失时，Daily 不得显示 `0`。
2. 把 `stats_as_of` / 最新 bucket 日期带入 telemetry 元数据。
3. 只有真实命中当天 bucket 才生成 Daily 值；否则生成 unavailable/stale 状态与 as-of 日期。
4. 若使用 `weekly_usage_buckets`，按其真实周期命名；若由 daily buckets 滚动求和，命名为 `Last 7 Days Tokens`，不能叫官方 weekly quota。
5. lifetime tokens 保持 `Total Tokens`；三类 profile item 均标记 `category: 'telemetry'`，没有 token limit 时不画百分比进度。
6. 重跑格式化测试并提交：

   ```powershell
   git add src/services/usage-service.js tests/codex-usage-format.test.js
   git commit -m "fix(codex): distinguish token telemetry from quota"
   ```

## Task 5：修正管理端的信息语义

**文件：**

- Modify: `static/app/usage-manager.js`
- Modify: `static/app/i18n.js`
- Modify: `static/app/utils.js`（仅在缺少现成时长格式化函数时）
- Modify/Create: 对应前端 source assertion 测试

**步骤：**

1. 摘要百分比旁展示 `summary.label`；无 label 时使用中性“额度概览”，不再使用无上下文“总用量”。
2. 将 quota windows、reset credits、token telemetry 分成三个视觉分组。
3. 只有 quota item 显示百分比进度条；无上限的 telemetry 只显示数值和 as-of，不显示空的 0% 条。
4. 未知/缺失值显示 `—`，必要时附“数据延迟”或“上游未提供”。
5. reset 卡片继续使用 `availableCount` / `canReset` 控制数量和按钮，expiry 只放 tooltip/detail。
6. weekly-only fixture 的预期画面：
   - 摘要：`周额度 2.0%`
   - 明细：`周额度 2.0%`
   - 明细：`GPT-5.3-Codex-Spark（周额度）43.0%`
   - Daily：不可用/as-of，而非 `0`
   - 最近 7 天与累计 Token 明确标注为统计
7. 仅在现有环境无需安装依赖即可启动时执行本地 UI smoke。
8. 提交：

   ```powershell
   git add static/app/usage-manager.js static/app/i18n.js static/app/utils.js tests
   git commit -m "fix(ui): clarify Codex quota and telemetry"
   ```

## Task 6：使预热对 weekly-only 账号安全

**文件：**

- Modify: `src/services/codex-prewarm-service.js`
- Modify: `tests/codex-prewarm-service.test.js`
- Modify: 配置文档（仅当新增 override 时）

**步骤：**

1. 先写失败测试：缓存中没有归一化 short window 时，定时预热应跳过该账号。
2. 保留真实 short window 账号的预热行为。
3. 如为兼容生产需要 override，只新增一个明确配置键，默认仍采用安全的语义检测；不能因一个账号 weekly-only 就全局关闭预热。
4. skip 日志只写简短原因，不写账号凭据或 raw payload。
5. 运行：

   ```powershell
   npx.cmd jest tests/codex-prewarm-service.test.js --runInBand
   ```

6. 提交：

   ```powershell
   git add src/services/codex-prewarm-service.js tests/codex-prewarm-service.test.js
   git commit -m "fix(codex): skip prewarm without short quota window"
   ```

## Task 7：集中回归与交接

**文件：**

- 仅在行为/配置变化时更新文档。
- 不直接修改 `.plans/current.md`；由 Cursor/Opus 把本计划提升为正式 handoff 切片。

**步骤：**

1. 如果 Jest 仍报告本地依赖缺失，必须先获得用户批准再恢复依赖环境。
2. 运行聚焦测试：

   ```powershell
   npx.cmd jest tests/codex-rate-limit-normalizer.test.js tests/codex-usage-format.test.js tests/provider-pool-codex-quota.test.js tests/model-usage-account-stats.test.js tests/codex-prewarm-service.test.js --runInBand
   ```

3. 聚焦测试通过后运行更广测试：

   ```powershell
   npm.cmd test -- --runInBand
   ```

4. 刷新一次脱敏真实用量并验证：
   - weekly 窗口不再标成 5h；
   - 通用 weekly 不重复；
   - 路由阈值命中正确语义窗口；
   - profile 延迟不显示成 Daily 0；
   - reset credits 保持独立。
5. 对管理端做桌面宽度和窄屏截图对比。
6. 执行 `git diff --check` 和 `git status --short`，保留无关 `.gitignore` 与测试配置改动。
7. 只提交属于本切片的最终文档/测试，不 push。

## 发布与回滚

- 本改动是增量解析与消费者调整；raw upstream 数据仍保留，不需要破坏性缓存迁移。
- 部署前至少对比一个 legacy 账号和一个 weekly-only 账号。
- 如果路由行为仍有不确定性，先发布展示/审计归一化，并把 quota enforcement 置于 observe-only 日志；观察一个刷新周期后再启用语义阈值。
- 回滚以本切片原子提交为单位；保留脱敏 fixture 作为长期回归证据。

