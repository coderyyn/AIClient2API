# Antigravity Gemini 冷却自动复测

`ANTIGRAVITY_COOLDOWN_PROBE_ENABLED` 默认 `true`，可通过现有配置 API 或 `configs/config.json` 关闭。配置 API 修改立即影响后续调度；直接编辑文件需要服务重新加载配置。此开关独立于账号健康检查设置。

控制 worker（或 standalone）启动 10 分钟后进行第一轮，此后每 10 分钟扫描。只请求启用、账号健康、不需要刷新认证且仍有模型级冷却的 Antigravity Gemini 凭据；覆盖图片模型，排除 Claude。无冷却不调用生成接口。保留原有到期自动恢复。

每轮最多并行两个凭据，同一凭据串行，上一轮未结束不启动下一轮。请求使用原凭据、代理和模型；不重试生成、不回退、不自动 OAuth 重放。多 worker 使用 Redis 探测锁和账号容量租约；Redis 不可用或账号满载时跳过。

文本探测限制 256 输出 token，60 秒总期限，要求正常 STOP 并返回算术题答案 `43`。图片使用当前适配器支持的基础规格 `1K`、正方形，180 秒总期限，要求 STOP 和可完整解码的图片。图片只在内存验证。输出不符合要求时保守保留冷却。期限或停机取消会传给 HTTP 请求并销毁 SSE 流。

成功只清除该凭据和模型的错误及恢复时间，并保留带版本的健康记录用于拒绝旧 worker 状态；不代表账号级健康恢复。429 有明确恢复时间时替换原时间，允许提前或延后；时间缺失、认证错误、网络错误和其他错误保留原状态。新 429、禁用和配置版本变化使旧探测失效。

Redis 通过冷却值和版本比较更新；恢复记录使延迟到达的旧冷却写入失效。持久化失败不报告恢复，回到可重试状态。现有状态事件向 worker 传播结果，并清除其路由缓存；用量页面读取最新凭据冷却状态，避免旧用量缓存覆盖恢复结果。

日志前缀 `[Antigravity Cooldown Probe]` 包含每轮数量，以及每个凭据 UUID、模型、HTTP 状态、恢复时间、耗时和结果。不会记录 token、提示词或生成图片。启用后图片探测会产生实际生成用量；无需冷却的组合不消耗探测用量。

## 本地验证

```powershell
npm test -- --runInBand --silent tests/antigravity-cooldown-probe.test.js tests/provider-state-event.test.js tests/provider-pool-antigravity-quota.test.js tests/antigravity-rate-limit-cooldown.test.js tests/redis-lease-coordinator.test.js
node --test --test-force-exit --test-timeout=10000 tests/antigravity-cooldown-probe-transport.test.mjs
$env:COOLDOWN_PROBE_TEST_REDIS_CONTAINER = 'aiclient2api-redis'
node --test --test-timeout=30000 tests/antigravity-cooldown-probe-redis.test.mjs
```

HTTP/SSE 测试仅使用本机模拟上游及虚构 token，不请求真实模型。Redis 测试需要明确指定本机测试容器，仅写入随机的 `cooldown-probe-test-*` 命名空间，并在结束时删除及复查自己的键。传输测试使用 Node 原生测试运行器，避免 Jest 的 CommonJS 转换与 gaxios 动态 ESM 导入冲突；`--test-force-exit` 用于已有全局模块定时器，测试本身会关闭 HTTP 服务和连接。

生产部署不包含在本地实现中。发布后需验证控制 worker 单实例调度、真实生成终态、Redis/文件/worker 状态一致，以及恢复组合能重新通过正常调度。
