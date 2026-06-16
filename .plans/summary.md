[step-1 | 2026-06-16T20:42:00+08:00] ✓ 建立项目级工作流骨架并记录定制分支边界
keep: 定制分支默认观测优先；sticky provider 做可配置能力且默认关闭。
[step-2 | 2026-06-16T20:55:00+08:00] ✓ 为 official usage cache 增加 1 小时 TTL 失败测试
[step-3 | 2026-06-16T20:57:00+08:00] ✓ 实现 usage cache 1 小时 TTL，并保留内部无 TTL 读取路径
keep: `refresh=true` 继续绕过缓存；`readUsageCache({ maxAgeMs: null })` 仅用于缓存内部更新。
