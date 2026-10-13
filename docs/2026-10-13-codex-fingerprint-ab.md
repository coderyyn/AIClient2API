# Codex 设备指纹长期对照

日期：2026-10-13。账号只用 uuid 前 8 位。

## 背景

- 2026-10-13 删除全局开关 `CODEX_FINGERPRINT_ENABLED`，凭据级默认与启动迁移默认改为 `off`。生产配置里残留的该键会被忽略。
- 开启的模式按原生 Codex 0.162.1 的 ID 形态生成，规则见 [sub2api-codex-capability-matrix.md](sub2api-codex-capability-matrix.md#指纹实现约束)。
- 依据：sub2api v0.1.175 静默默认 `session` 后社区报告降额，[#5668](https://github.com/Wei-Shaw/sub2api/pull/5668) 改为 opt-in；维护者另有"不收敛的新号 100% 降额"的相反数据。两种说法都没有公开的官方依据，所以用对照来判断。
- 2026-08 本项目全池 `session` 期间的诊断见 [2026-08-17-codex-quota-fingerprint-diagnosis.md](2026-08-17-codex-quota-fingerprint-diagnosis.md)。那时的 `session` 是旧形态（v4、session 与 thread 不同、`prompt_cache_key` 与 session-id 不一致），和本次实现不是同一处理。

## 分组（生产启用的 4 个号，2026-10-13 快照）

| 组 | 账号 | 套餐 | 模式 |
| --- | --- | --- | --- |
| 实验 | `82aacbd4`、`c5d764d1` | pro、pro | `session` |
| 对照 | `af84a021`、`8f791792` | pro、prolite | `off` |

同套餐对比优先看 pro 号之间。其余 14 个号停用，保持 `off`，不纳入对照。

## 观测

- 周期：至少 2 个完整周窗，不看几十分钟或单日波动。
- 数据：`configs/codex-weekly-estimate-snapshots.json`（官方周百分比、当周 token、隐含周限）；request audit 的缓存命中率（cached / prompt tokens）；401/403/429 与账号停用事件。
- 每周记录：每号隐含周限、当周 token、缓存命中率、异常事件，以及官方 usage 页客户端类型（能拿到时）。
- 改模式不要中途切换；路由权重两组保持一致，避免负载差异掩盖结果。

## 判定

- 实验组隐含周限或缓存命中率相对对照组持续下降超过 30%：实验组改回 `off`。
- 实验组出现对照组没有的封禁或风控停用：立即改回 `off` 并记录时间线。
- 两周窗无显著差异：维持按凭据 opt-in，不改默认。

## 回滚

在管理端把实验组账号模式改回 `off`。不需要改全局配置，也不需要重启。

## 记录

| 周窗 | 账号 | 模式 | 隐含周限 | 当周 token | 缓存命中率 | 异常 |
| --- | --- | --- | --- | --- | --- | --- |
