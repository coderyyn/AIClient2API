## Step 1 - START - 2026-06-16T20:40:00+08:00
建立项目级 AGENTS 与 .plans 骨架，记录定制分支范围和用户已批准的实现口径。

## Step 1 - DONE - 2026-06-16T20:42:00+08:00
产物：AGENTS.md、.plans/current.md、.plans/status.json、.plans/summary.md、.plans/runlog.md、.plans/questions.md。
关键决策：sticky provider 支持会作为可配置能力加入，默认关闭，不改变观测优先策略。
验证：确认项目根此前没有 AGENTS.md / .plans，新文件创建成功。

## Step 2 - START - 2026-06-16T20:48:00+08:00
为 official usage 缓存 TTL 和刷新语义补 focused Jest 测试，先只写测试不改生产代码。

## Step 2 - DONE - 2026-06-16T20:55:00+08:00
产物：tests/usage-cache.test.js。
关键决策：默认 TTL 固定为 1 小时，测试使用可注入 now 保持稳定。
验证：首次运行 `npx.cmd jest tests/usage-cache.test.js --runInBand` 按预期失败在过期缓存仍被返回。

## Step 3 - START - 2026-06-16T20:55:00+08:00
实现 usage cache TTL 的最小代码，并调整内部缓存更新路径避免被 TTL 误拦截。

## Step 3 - DONE - 2026-06-16T20:57:00+08:00
产物：src/ui-modules/usage-cache.js、src/ui-modules/usage-api.js、tests/usage-cache.test.js。
关键决策：公开读取默认启用 TTL；内部需要修改缓存文件时显式传 `maxAgeMs: null`。
验证：`npx.cmd jest tests/usage-cache.test.js --runInBand` 通过，3 个测试全部通过。

## Step 4 - START - 2026-06-16T20:57:00+08:00
为 model-usage-stats 的账号、模型、日期维度和 cache hit ratio 写 focused 测试。

## Step 4 - DONE - 2026-06-16T21:02:00+08:00
产物：tests/model-usage-account-stats.test.js。
关键决策：账号元数据放在 account 对象顶层，summary 仅保留用量字段。
验证：首次运行 `npx.cmd jest tests/model-usage-account-stats.test.js --runInBand` 按预期失败，缺少 `cacheHitRatio` 和账号结构。

## Step 5 - START - 2026-06-16T21:02:00+08:00
扩展 model-usage-stats 存储结构，并把实际 provider uuid/name 从请求链路透传到插件 hook。

## Step 5 - DONE - 2026-06-16T21:08:00+08:00
产物：src/plugins/model-usage-stats/stats-manager.js、src/plugins/model-usage-stats/index.js、src/utils/common.js、src/services/api-manager.js。
关键决策：新增 `accounts`、`daily[date].models`、`daily[date].accounts`；图片接口 hook 顺序改为先记录 response usage 再 finalize。
验证：`npx.cmd jest tests/model-usage-account-stats.test.js --runInBand` 与 `npx.cmd jest tests/usage-cache.test.js --runInBand` 均通过。

## Step 6 - START - 2026-06-16T21:08:00+08:00
为 API Potluck 管理端 key 用量摘要和可选 Codex sticky provider affinity 写 focused 测试。

## Step 6 - DONE - 2026-06-16T21:17:00+08:00
产物：tests/provider-pool-affinity.test.js、tests/api-potluck-key-usage-summary.test.js。
关键决策：sticky provider 测试只覆盖 provider pool 选择逻辑；API Potluck 摘要测试聚焦 key 级 token/ratio 字段。
验证：两组测试首次运行均按预期失败，分别暴露没有固定 provider 和缺少 weekly/ratio 字段。

## Step 7 - START - 2026-06-16T21:17:00+08:00
实现 API Potluck key token-first 摘要、管理端排序/每日展示，以及 Codex sticky provider 可配置选择。

## Step 7 - DONE - 2026-06-16T21:24:00+08:00
产物：src/providers/provider-pool-manager.js、src/services/service-manager.js、src/plugins/api-potluck/key-manager.js、static/potluck.html、src/core/config-manager.js、configs/config.json.example。
关键决策：sticky provider 默认关闭，只有 `CODEX_POTLUCK_STICKY_PROVIDER_ENABLED` 开启且请求来自 API Potluck key 时才传入 affinity key；管理端默认按今日 Token 排序。
验证：`npx.cmd jest tests/provider-pool-affinity.test.js --runInBand`、`tests/api-potluck-key-usage-summary.test.js`、`tests/model-usage-account-stats.test.js`、`tests/usage-cache.test.js` 均通过。

## Step 8 - START - 2026-06-16T21:24:00+08:00
更新决策 HTML/docs，运行更广的测试与本地容器验证。

## Step 8 - PROGRESS - 2026-06-16T21:45:00+08:00
补齐 provider weight 本地能力并提交；更新决策 HTML 和缓存命中率调查文档，明确已完成/待完成范围。
验证：集中运行 9 个 Jest suite，共 23 个测试通过。

## Step 8 - DONE - 2026-06-16T21:45:00+08:00
产物：docs/yyn-customized-branch-plan.html、docs/yyn-codex-usage-cache-hit-investigation.md、测试镜像 aiclient2api:customized-branch-20260616、本地容器 aiclient2api-image2-test。
关键决策：普通日志邮箱脱敏作为本地定制能力补充提交；原始需求中更改路由/窗口的能力保留到下一批，不混入观测优先批次。
验证：集中运行 9 个 Jest suite，共 24 个测试通过；Docker 镜像构建成功；测试容器重启后 healthy；/health 返回 healthy；potluck.html 返回 200；启动日志邮箱已脱敏。
