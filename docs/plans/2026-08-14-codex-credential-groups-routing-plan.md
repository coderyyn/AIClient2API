# Codex OAuth 凭据组与 Potluck Key 路由计划

> 状态：已完成（2026-08-14）

## 目标

在现有 Codex OAuth Provider Pool 与 API Potluck Key 的基础上，增加可审计的“凭据组”路由能力，支持约 10 个 Pro 凭据服务约 20 个用户/自动化任务的稳定分发。

## 已确认的行为

- Key 支持 `fixed` 和 `auto` 两种路由模式。
- `fixed` 只允许指定凭据；指定凭据不可用时直接失败，不静默切换。
- `auto` 优先主组，主组额度/健康/认证不可用时允许跨组 spillover；spillover 不永久改主组，且保留当前会话的粘性。
- 分配建议使用最近 7 个完整自然日的 `Asia/Shanghai` 用量，优先实际成本，其次总 Token，最后请求数。
- 健康凭据数为 0 时不生成可应用建议；1 个凭据 1 组；2 个凭据 2 组；3 个及以上至少 3 组，目标为每组约 2–3 个凭据。
- 建议必须预览后由管理员确认应用；保留 revision 与上一版本回滚。
- 手工锁定的组、凭据和 Key 不参与自动重排。
- UI 只显示脱敏的凭据标识、Key 标识、组和聚合用量，不显示 Token/Cookie/原始 API Key。

## 实现步骤

1. 领域服务与 focused tests：组数、容量、7 日需求、容量感知分配、锁定项、revision/rollback。
2. Potluck Key 路由字段与管理 API：Key 与组/凭据关系可读可写。
3. Provider Pool 与 Service Manager：固定凭据约束、主组优先、健康/额度失败后的跨组降级、诊断信息。
4. OAuth 管理页与 Potluck 摘要：分组预览/应用/回滚、关系和 spillover 展示。
5. 聚焦测试、相关 Jest 测试、`git diff --check` 与边界检查。

## 非目标与安全边界

- 不共享 OAuth Token、Cookie 或浏览器登录态。
- 不实现 IP/代理轮换、指纹伪造或规避上游风控/额度的逻辑。
- 不自动每周无确认地重排生产 Key。
- 不把完整凭据、Key store 或敏感请求内容写入日志、文档或测试夹具。

## 验收标准

- 领域服务能对 0/1/2/3+ 个健康凭据给出正确组数与可解释建议。
- Key 路由字段能持久化并从认证结果安全透传到请求配置。
- fixed 模式不会触发其他凭据 fallback；auto 模式可在主组失效时选择其他组。
- sticky/cache affinity 在组约束之上继续生效。
- UI 能显示 Key ↔ 凭据组 ↔ 凭据关系，并能预览、应用、回滚建议。
- 现有测试不回归，新增测试与 `git diff --check` 通过。

## 实际完成内容

- 新增凭据组领域服务：按最近 7 个完整 `Asia/Shanghai` 自然日的实际成本、Token 和请求数生成需求权重，并按健康凭据数执行 `0/1/2/3+` 组数规则；默认 10 个凭据目标为 `3/3/2/2`。
- 新增 Potluck 凭据组管理 API：读取关系、预览、应用、revision 列表和直接上一版本回滚；应用前校验 `baseRevision`，预览默认 5 分钟过期。
- 接入 Key 路由元数据和批量同步：`fixed` 只使用指定凭据且失败不 fallback；`auto` 优先主组，在额度、健康或认证不可用时临时跨组 spillover，并保留会话粘性。
- 接入 OAuth/Provider 管理页与 Potluck 摘要：展示脱敏凭据、组、Key、路由模式、锁定状态、聚合用量和 spillover；支持预览、管理员确认应用及回滚。
- 手工锁定的组、凭据和 Key 不参与自动重排；管理输出和审计链路不透传 Token、Cookie、原始 API Key、原始凭据 UUID 或请求正文。

## 实际验证（2026-08-14）

- `npx.cmd jest tests/codex-credential-group-service.test.js tests/api-potluck-credential-groups.test.js tests/codex-credential-group-ui-source.test.js tests/api-potluck-admin-persistence-routes.test.js tests/api-potluck-key-routing.test.js tests/service-manager-credential-group-routing.test.js --runInBand`：6 个 suite、65 个测试全部通过。
- `node --check`：`static/app/provider-manager.js`、`static/app/i18n.js`、`src/services/codex-credential-group-service.js`、`src/plugins/api-potluck/api-routes.js` 全部通过。
- `static/potluck.html` 内嵌脚本使用内存 `vm.Script` 检查通过（1 个脚本）；`git diff --check` 通过。
- 本轮未执行真实浏览器截图或页面 smoke；UI 验证为源码级断言，API/持久化/路由验证由 Jest 覆盖。
