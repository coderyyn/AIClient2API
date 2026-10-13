# Sub2API Codex 能力差异矩阵

固定上游：`Wei-Shaw/sub2api` `v0.1.175`，提交 `93c32fa1a2450351561abc46156d2e28cb5f74ca`。

本项目采用行为级重写，不直接复制 Sub2API 实现。Sub2API 为 LGPL-3.0，本项目为 GPL-3.0；如未来需要移植非纯行为代码，必须保留来源与许可证记录。

| 能力 | 本项目基线 | 本次处理 | 结论 |
| --- | --- | --- | --- |
| Codex OAuth/PAT/Session 导入与身份去重 | 已有 OAuth、导入、重授权、账号身份回填 | 新增指纹模式字段与存量迁移 | 增强 |
| Codex 请求转换、Responses、模型清单、客户端版本 | 已有 `codex-core`、`CodexConverter`、模型清单 | 复用现有链路；不创建第二套请求链 | 已有/保持 |
| Responses/SSE、顶层 error、response.failed、空 completed | 已有终止错误归一和 SSE 合成 | 保持现有实现 | 已有 |
| quota/capacity、401、确定性 400、瞬时网络分类 | 已有 Provider Pool、冷却、failover、审计 | 仅补 allowlist rejected-field 单次重试 | 增强 |
| TTFT、终止事件排除、过载重试 | 已有 Codex 流处理与同凭据重试 | 不重复实现 | 已有 |
| quota snapshot、sticky、prewarm、Potluck、usage ledger | 已有 | 不改变路由语义 | 保持 |
| reasoning item ID 清洗 | 原链路未覆盖所有 Codex 回放场景 | 去掉 reasoning `id`，缺失 `summary` 补空数组 | 增强 |
| 非法工具参数安全解析、长工具名稳定哈希 | 已有测试和实现 | 不重复实现 | 已有 |
| Responses 工具 schema 兼容 | 已有 Codex/OpenAI Responses 转换 | 不改变 hosted image/function 冲突防护 | 已有 |
| Codex OAuth 设备指纹收敛 | 缺失 | 新增 `off/device/session/full`；2026-10-13 起默认 `off`（对齐 sub2api #5668），ID 形态对齐原生 Codex 0.162.1 | 移植/重写 |
| 全局紧急关闭 | 缺失 | `CODEX_FINGERPRINT_ENABLED` 已于 2026-10-13 删除；只按凭据选择模式，残留配置键被忽略 | 移除 |
| 存量账号迁移与备份 | 缺失 | 文件锁、原子写入、迁移前 `.bak`、执行 worker 不持久化 | 新增 |
| 管理端模式选择与状态 | 缺失 | Codex Provider 选择器（默认 off）、脱敏审计摘要 | 新增 |
| 多 worker 全局开关与审计同步 | 开关只更新 control worker，执行 worker 需重启 | `codex_runtime_config_sync` 下发并清理 Codex adapter；审计摘要经 `codex_fingerprint_audit` 回传 control（2026-10-12） | 修复 |
| WebSocket 专属 ingress 恢复流程 | 当前项目无同等 WS Codex forward 链 | 不移植 | 不适用 |

## 指纹实现约束

- 仅对 `openai-codex-oauth` 生效。
- 账号种子优先 `codexAccountKey`，回退 `codexAccountId`、`uuid`。
- `installation_id` 按账号固定，UUIDv4（原生 `~/.codex/installation_id` 形态）。
- `session`：session/thread 由账号种子和会话键派生，`session_id == thread_id`（原生根会话不变量）；会话键取客户端 session，没有时取最终 `prompt_cache_key`。`full`：整个账号一个会话。
- session/thread/turn 为 UUIDv7；来源 ID 是 v7 时继承其时间戳。`x-client-request-id == thread_id`，`x-codex-window-id == <thread_id>:<客户端 window_number>`，`prompt_cache_key == session-id`，`root_turn_id` 根轮次等于 `turn_id`。
- 同一请求的 header/body/内嵌 metadata 共用一组预计算 ID；同账号重试复用 turn ID。
- Provider failover 重新按新账号生成账号级 ID，但保留原始客户端 session 作为 thread 输入。
- malformed metadata JSON fail-open；日志和 API 只返回模式、版本、时间和短哈希。

## 研究来源

- 指纹核心：`backend/internal/service/openai_codex_fingerprint.go`，提交 `c0ab3a00ea733cc0559a5a949c28fb5d9d7c5d16`。
- Responses rejected-field retry：`backend/internal/service/openai_responses_rejected_field_retry.go`。
- reasoning item 清洗：`backend/internal/service/openai_codex_transform.go`。
- 许可证边界：Sub2API `LGPL-3.0`，本项目 `GPL-3.0`。
