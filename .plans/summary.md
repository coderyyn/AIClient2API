[step-1 | 2026-06-16T20:42:00+08:00] ✓ 建立项目级工作流骨架并记录定制分支边界
keep: 定制分支默认观测优先；sticky provider 做可配置能力且默认关闭。
[step-2 | 2026-06-16T20:55:00+08:00] ✓ 为 official usage cache 增加 1 小时 TTL 失败测试
[step-3 | 2026-06-16T20:57:00+08:00] ✓ 实现 usage cache 1 小时 TTL，并保留内部无 TTL 读取路径
keep: `refresh=true` 继续绕过缓存；`readUsageCache({ maxAgeMs: null })` 仅用于缓存内部更新。
[step-4 | 2026-06-16T21:02:00+08:00] ✓ 为 Codex 账号、模型、日期统计和 cache hit ratio 增加失败测试
[step-5 | 2026-06-16T21:08:00+08:00] ✓ 实现 model-usage-stats 账号维度、日期模型维度与 provider 元信息透传
keep: stats 新增 `accounts` 与 `daily[date].models/accounts`；usage block 返回 `cacheHitRatio`，不保存原始 prompt。
[step-6 | 2026-06-16T21:17:00+08:00] ✓ 为 API Potluck key usage summary 和 Codex sticky provider 增加失败测试
[step-7 | 2026-06-16T21:24:00+08:00] ✓ 实现 Potluck token-first 管理视图摘要与可选 Codex sticky provider
keep: `CODEX_POTLUCK_STICKY_PROVIDER_ENABLED=false` 为默认；开启后仅 Codex provider 使用同 key affinity。
[step-8 | 2026-06-16T21:45:00+08:00] ✓ 更新文档，完成集中测试和本地容器 smoke
keep: 原始需求中的 Codex token 配额过滤、早晨预热和官方 `/usage` 字段展示留作下一批。
