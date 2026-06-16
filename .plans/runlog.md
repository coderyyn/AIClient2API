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
