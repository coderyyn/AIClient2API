# Codex 上游稳定性改动选择性合并实施计划

> **供 Codex/Claude 执行：** 计划获批后必须依次使用 `executing-plans`、`test-driven-development`、`verification-before-completion`。

**目标：** 只把 `justlovemaki/AIClient2API` `main@f158310` 中与 Codex 请求、SSE 终止错误和工具调用稳定性直接相关的改动合入 `yyn/customized-branch`，不引入其他提供商、通用 UI 或版本发布改动。

**架构：** 不直接 cherry-pick 上游提交，而是以 `f158310^..f158310` 为证据源，按函数级 hunk 手工移植到当前硬分叉代码。Codex 请求清洗与终止错误统一放在 `codex-core.js`；工具名和工具参数容错放在 `CodexConverter.js`；现有图片工具冲突、weekly-only、官方统计、fast 模型和 gpt-5.6 定制作为不可回退基线。

**技术栈：** Node.js ES Modules、Axios、OpenAI Responses SSE、Jest、Docker。

---

## 上游证据与范围决策

- 上游来源固定为 `origin/main@f1583104c7795f84450bdee11c10ebce1a1865c3`，版本 `3.3.6`。
- `f158310` 中只移植：
  - `src/providers/openai/codex-core.js` 的请求清洗、SSE 数据提取、`error` / `response.failed` 终止错误归一。
  - `src/converters/strategies/CodexConverter.js` 的安全工具参数解析和长工具名哈希截断。
- `fa6bf05` 中 Codex 相关部分已经存在：`CODEX_VERSION=0.144.1`、三个 gpt-5.6 模型；不重复修改。
- 单独评估并验证 `gpt-image-2` 的上游承载模型由 `gpt-5.4` 切换到 `gpt-5.5`，不能在未完成 generation/edits 真实测试时发布。
- 明确排除：
  - `VERSION`
  - `src/providers/provider-models.js` 中 `grok-4.5` 和 Claude Sonnet 5
  - `static/app/custom-models-manager.js`
  - 七牛云、Fenno、Grok、Kiro 相关提交
  - README、provider UI、路由示例、图片资源
  - 用户已有 `.gitignore`、`static/app/utils.js`、`configs/provider_pools.test.json`
- 禁止直接执行 `git cherry-pick f158310`、`git merge origin/main` 或整文件覆盖。

## 不可回退基线

1. `image_gen.imagegen` / `image_gen__imagegen` 不得与 hosted `image_generation` 重复注入。
2. 发往 Codex 上游的函数名继续规范化为 `image_gen__imagegen`，回包继续映射为原始名称。
3. `gpt-image-2` 强制 hosted tool、图片质量/尺寸/多输入和 overload 单次重试保持不变。
4. `gpt-5.3-codex-spark`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.5` 和三个 gpt-5.6 模型保持可用。
5. weekly-only、官方统计、延迟天数和按小时更新时间展示不变。
6. 上游 400 不得错误标记 provider 不健康；Responses 客户端继续收到合法 `event: error`。

## 验收标准

1. 普通和流式 Codex 响应都能识别顶层 `type: error` 与 `type: response.failed`。
2. `usage_limit_reached` 和明确的 model capacity 错误转换为 429 语义，允许切换凭据且不累计账号错误次数。
3. `resets_at` / `resets_in_seconds` 能生成 `retryAfterMs`；普通 invalid request 保持 400 且不切换凭据。
4. SSE 同时兼容 `data: {...}`、`data:{...}`、裸 JSON 行、metadata 行和最后一个无换行 buffer。
5. 请求发往上游前删除 `previous_response_id`、`prompt_cache_retention`、`safety_identifier`、`stream_options`。
6. instructions 缺失时提供上游可接受值；没有有效工具时不发送 `parallel_tool_calls`。
7. 非法 JSON 工具参数不再使转换器崩溃，而是保存为 `{ _raw_arguments: original }`。
8. 超过 64 字符的工具名使用稳定哈希后缀，两个同前缀长名称不会碰撞。
9. 图片工具名称映射和重复注入回归测试继续通过。
10. 最终工作树除本切片文件外仍只包含用户原有三项改动；不 push、不部署生产。

## Task 1：建立上游 Codex 终止错误回归测试

**文件：**

- Create: `tests/codex-terminal-errors.test.js`
- Reference only: `src/providers/openai/codex-core.js:209-355, 700-920`

**步骤：**

1. 使用 `CodexApiService.parseNonStreamResponse()` 构造 `response.failed` fixture，断言抛出的错误保留上游 message。
2. 增加 `usage_limit_reached` 测试，覆盖：
   - `error.response.status === 429`
   - `shouldSwitchCredential === true`
   - `skipErrorCount === true`
   - `retryAfterMs` 来自 `resets_in_seconds`。
3. 增加 model capacity 测试，消息覆盖上游两个已知 capacity 文案。
4. 增加普通 `invalid_request_error` 测试，断言 status 为 400，且没有凭据切换标志。
5. 用 Node `Readable` 构造流式 fixture，分别覆盖：
   - `data: {...}`
   - `data:{...}`
   - 裸 JSON
   - `event:` / `id:` / `retry:` metadata
   - 无换行 final buffer。
6. 先运行：

   ```powershell
   npx.cmd jest tests/codex-terminal-errors.test.js --runInBand
   ```

   预期：当前代码无法识别 `response.failed`，测试失败。
7. 提交测试：

   ```powershell
   git add tests/codex-terminal-errors.test.js
   git commit -m "test(codex): cover terminal Responses errors"
   ```

## Task 2：移植请求清洗和终止错误归一

**文件：**

- Modify: `src/providers/openai/codex-core.js:18-120`
- Modify: `src/providers/openai/codex-core.js:411-524`
- Modify: `src/providers/openai/codex-core.js:700-920`
- Test: `tests/codex-terminal-errors.test.js`
- Test: `tests/provider-auth-failure-health.test.js`

**步骤：**

1. 从 `f158310` 手工移植并按当前分支命名调整以下 helper：
   - `normalizeCodexTerminalError(parsed)`
   - `createCodexTerminalError(parsed)`
   - `shouldSwitchCodexCredential(errorBody)`
   - `isCodexUsageLimitError(errorBody)`
   - `isCodexModelCapacityError(errorBody)`
   - `parseCodexRetryAfterMs(errorBody)`
   - `extractSSEData(line)`
2. `createCodexTerminalError()` 只对明确 quota/capacity 返回 429；普通协议/参数错误返回 400。
3. 与当前 `src/utils/common.js` 的 Codex quota bucket 逻辑协作，不复制 provider cooldown；这里只携带 status、切换和 retry metadata。
4. 在 `prepareRequestBody()` 的浅拷贝后删除四个不支持字段，不修改调用者原始 body。
5. 生成最终 result 后：
   - instructions 缺失则补空字符串；图片模型已有非空 instructions 时保持原值。
   - tools 缺失或为空时删除 `parallel_tool_calls`。
6. `parseSSEStream()` 和 `parseNonStreamResponse()` 统一通过 `extractSSEData()` 取 JSON，并统一调用 `createCodexTerminalError()`。
7. 错误事件必须立即抛出，不得再合成 `response.completed`。
8. 运行：

   ```powershell
   npx.cmd jest tests/codex-terminal-errors.test.js tests/provider-auth-failure-health.test.js tests/codex-rate-limit-reset.test.js --runInBand
   ```

9. 提交：

   ```powershell
   git add src/providers/openai/codex-core.js tests/codex-terminal-errors.test.js
   git commit -m "fix(codex): normalize terminal Responses errors"
   ```

## Task 3：建立工具参数与长名称回归测试

**文件：**

- Modify: `tests/codex-tool-name-normalization.test.js`
- Reference only: `src/converters/strategies/CodexConverter.js:169-190, 625-675, 920-1025, 1370-1410`

**步骤：**

1. 增加非法 JSON arguments 测试，断言 OpenAI、Claude、Gemini 三种响应转换均不会抛异常，并返回 `_raw_arguments`。
2. arguments 为对象、空字符串、null 时分别断言保持对象或转换为空对象。
3. 构造两个前 64 字符相同、尾部不同的超长工具名，断言：
   - 输出不超过 64 字符。
   - 名称包含稳定的哈希后缀。
   - 两个名称不相同。
   - 同一输入重复转换结果相同。
4. 保留并重跑现有 `image_gen.imagegen` 双向映射测试。
5. 先运行：

   ```powershell
   npx.cmd jest tests/codex-tool-name-normalization.test.js --runInBand
   ```

   预期：非法 JSON 和长名称碰撞测试失败。
6. 提交测试：

   ```powershell
   git add tests/codex-tool-name-normalization.test.js
   git commit -m "test(codex): cover malformed tool calls"
   ```

## Task 4：移植安全工具参数解析和哈希截断

**文件：**

- Modify: `src/converters/strategies/CodexConverter.js:5-15`
- Modify: `src/converters/strategies/CodexConverter.js:169-190`
- Modify: `src/converters/strategies/CodexConverter.js:646-675`
- Modify: `src/converters/strategies/CodexConverter.js:920-1025`
- Modify: `src/converters/strategies/CodexConverter.js:1370-1410`
- Test: `tests/codex-tool-name-normalization.test.js`

**步骤：**

1. 引入 Node `crypto`，增加 `safeParseToolArguments()`：

   ```js
   safeParseToolArguments(value) {
       if (value === null || value === undefined || value === '') return {};
       if (typeof value !== 'string') return value;
       try {
           return JSON.parse(value);
       } catch {
           return { _raw_arguments: value };
       }
   }
   ```

2. 把三个直接 `JSON.parse(item.arguments)` 的响应转换点改为调用该 helper。
3. 保留当前 `normalizeToolName('image_gen.imagegen')` 逻辑；只在名称仍超过 64 字符时追加 `_` 加 16 位 SHA-256 后缀。
4. MCP 工具名的短化候选仍优先使用；候选也超长时同样通过统一哈希截断，禁止直接 `slice(0, 64)`。
5. 运行：

   ```powershell
   npx.cmd jest tests/codex-tool-name-normalization.test.js --runInBand
   ```

6. 提交：

   ```powershell
   git add src/converters/strategies/CodexConverter.js tests/codex-tool-name-normalization.test.js
   git commit -m "fix(codex): safely normalize tool calls"
   ```

## Task 5：对齐 gpt-image-2 承载模型并保护图片定制

**文件：**

- Modify: `src/providers/openai/codex-core.js:422-455`
- Modify/Create: `tests/codex-image-model-routing.test.js`
- Test: `tests/codex-image-quality.test.js`
- Test: `tests/image-edits-multipart.test.js`

**步骤：**

1. 先写失败测试，断言 `gpt-image-2` 的最终 upstream model 为上游 `fa6bf05` 指定的 `gpt-5.5`。
2. 同时断言以下行为不变：
   - tools 仅包含 hosted `image_generation`。
   - `_imageSize`、`_imageQuality`、`_imageToolOptions` 被写入 hosted tool 后从顶层删除。
   - instructions 非空。
   - 不注入 `web_search`。
3. 把 `effectiveUpstreamModel` 从 `gpt-5.4` 调整到 `gpt-5.5`，不修改普通文本模型路由。
4. 运行：

   ```powershell
   npx.cmd jest tests/codex-image-model-routing.test.js tests/codex-image-quality.test.js tests/image-edits-multipart.test.js --runInBand
   ```

5. 提交：

   ```powershell
   git add src/providers/openai/codex-core.js tests/codex-image-model-routing.test.js
   git commit -m "fix(codex): align image backing model"
   ```

## Task 6：聚焦回归和完整离线验证

**文件：**

- Verify only; 不修改非 Codex 文件。

**步骤：**

1. 当前宿主工作区没有可执行的 Jest launcher，禁止为了本切片直接安装依赖。优先复用最终基础镜像中的 `node_modules`，只读挂载当前 `tests/`、`jest.config.js` 和临时 Babel 配置运行测试；如该方式不可用，再向用户申请恢复依赖环境。
2. 运行 Codex 聚焦测试：

   ```powershell
   npx.cmd jest tests/codex-terminal-errors.test.js tests/codex-tool-name-normalization.test.js tests/codex-image-model-routing.test.js tests/codex-image-quality.test.js tests/codex-56-models.test.js tests/provider-auth-failure-health.test.js tests/codex-rate-limit-reset.test.js tests/image-edits-multipart.test.js --runInBand
   ```

3. 重跑图片 overload、Responses stream error 和 weekly-only/官方统计相关测试，证明没有跨功能回归。
4. 运行完整离线 Jest，排除真实 API 集成测试：

   ```powershell
   npm.cmd test -- --runInBand --forceExit --testPathIgnorePatterns=tests/api-integration.test.js
   ```

5. 运行：

   ```powershell
   git diff --check
   git status --short
   ```

6. 检查范围：`git diff <执行前HEAD>..HEAD --name-only` 只能包含：
   - `src/providers/openai/codex-core.js`
   - `src/converters/strategies/CodexConverter.js`
   - 新增/修改的 Codex 测试
   - 本计划文件（如决定随实现提交）
7. 明确确认以下文件没有进入提交：
   - `.gitignore`
   - `static/app/utils.js`
   - `configs/provider_pools.test.json`
   - `VERSION`
   - `src/providers/provider-models.js`
   - `static/app/custom-models-manager.js`

## Task 7：从最终 commit 构建本地镜像并做真实验证

**文件：**

- Verify only; 镜像必须来自 `git archive HEAD`，不得从脏工作树直接构建。

**步骤：**

1. 构建带 commit label 的新本地镜像，保留当前 `93d481a` 镜像和容器作为回滚基线。
2. 滚动替换本地测试容器，保持现有配置挂载、内存参数和端口映射。
3. 真实验证文本模型：
   - `gpt-5.3-codex-spark`
   - `gpt-5.4`
   - `gpt-5.4-mini`
   - `gpt-5.5`
   - `gpt-5.6-sol`
   - `gpt-5.6-terra`
   - `gpt-5.6-luna`
4. 工具专项：`gpt-5.4`、`gpt-5.5` 携带 `image_gen.imagegen`，必须完成且无 hosted tool 冲突。
5. 图片专项：
   - `/v1/images/generations` 生成有效 PNG。
   - `/v1/images/edits` 使用本地测试图生成有效 PNG。
   - 校验 PNG 文件头、尺寸、文件大小和可视内容。
   - 确认图片 options 与 overload 单次重试日志行为不变。
6. 验证 `/api/health`、用量刷新和最近日志，确认没有 `stream closed before response.completed`、工具冲突或循环重试。
7. 若 `gpt-5.5` 承载图片在真实环境失败，停止，不部署、不自动回退；保留测试证据并单独决定是否继续维持 `gpt-5.4`。

## 提交与交付边界

- 计划实施预计形成 5 个原子提交：
  1. `test(codex): cover terminal Responses errors`
  2. `fix(codex): normalize terminal Responses errors`
  3. `test(codex): cover malformed tool calls`
  4. `fix(codex): safely normalize tool calls`
  5. `fix(codex): align image backing model`（包含对应先失败后通过的测试；如真实验证阻塞则不交付此提交）
- 不执行 `git push`。
- 本计划只完成 custom 分支本地合入和本地容器验证；生产部署必须另获用户明确指令。
- 不修改或提交用户已有工作树改动。
