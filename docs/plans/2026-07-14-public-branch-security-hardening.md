# Public Branch Security Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 清理公开分支中的本机路径，修复请求审计接口鉴权缺口与生产依赖漏洞，并通过临时 Docker 容器验证提交代码可正常启动。

**Architecture:** 保留现有 IP 白名单作为网络边界，同时让 request-audit 插件的所有 API 路由统一复用后台登录 Token 校验，形成纵深防御。依赖只提升到已修复安全公告的兼容版本，容器验证使用 `git archive HEAD` 构建干净上下文，避免混入工作区未提交文件。

**Tech Stack:** Node.js ES modules、Jest、npm lockfile、Docker Desktop。

---

### Task 1: 固化 request-audit 鉴权行为

**Files:**
- Modify: `tests/request-audit-api.test.js`
- Modify: `src/plugins/request-audit/api-routes.js`

1. 新增未携带后台登录 Token 访问 `/summary` 和 `/requests` 时返回 401 的测试。
2. 运行聚焦测试，确认新测试因当前路由未鉴权而失败。
3. 将现有 raw-capture Token Store 鉴权提升为整个 `/api/request-audit` 路由的统一前置校验，避免引入认证模块的额外运行时副作用。
4. 为已有聚合测试显式使用测试专用鉴权跳过开关。
5. 重跑聚焦测试，确认全部通过。

### Task 2: 清理公开文档中的本机绝对路径

**Files:**
- Modify: `.plans/archive/session-20260616-2145.md`
- Modify: `docs/plans/2026-06-23-request-audit-context-breakdown.md`

1. 将用户名和绝对工作区路径替换为通用的“仓库根目录/工作区”描述。
2. 全分支检索本机用户绝对路径，确认不再存在。

### Task 3: 修复生产依赖漏洞

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

1. 查询 npm registry 中 `multer`、`undici`、`form-data` 的当前安全版本。
2. 将直接依赖最低版本提升到修复版本，并刷新 lockfile 中的传递依赖。
3. 运行 `npm audit --omit=dev`，要求 high/critical 均为 0。

### Task 4: 验证、提交与临时容器 smoke

**Files:**
- Verify: touched files and existing test suites

1. 运行 request-audit 聚焦测试和依赖相关测试。
2. 运行完整 Jest 测试或记录不能运行的明确原因。
3. 检查 `git diff`，只暂存本任务文件，不纳入用户原有 `.gitignore`、`static/app/utils.js`、`configs/provider_pools.test.json` 变动。
4. 创建一个中文 Conventional Commit。
5. 用 `git archive HEAD` 生成临时干净构建上下文，构建临时镜像。
6. 用未占用的本机端口启动临时容器，轮询 `/health` 并检查容器状态。
7. 无论成功或失败都删除临时容器和临时构建上下文；成功后删除临时镜像。
