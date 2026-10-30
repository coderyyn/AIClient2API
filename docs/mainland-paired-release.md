# 大陆门禁双容器发布

应用镜像与 edge-auth 镜像必须来自同一提交。工具为 `scripts/ops/mainland_release.py`，默认 dry-run；只有 `--apply` 执行明确 phase。私有规格、完整 inspect、配置和回滚材料只保存在服务器 root 的 0700 目录，文件 0600，不进入 Git。

规格从执行时的生产配置及两个容器 inspect 生成。包含双镜像 ID、提交、部署 epoch、网络网关、清单哈希、95 个 Key 数量及集合聚合哈希、显式配置文件清单和源码模板路径。只批准大陆门禁、网络审计、清单路径、真实 Nginx 网关信任、只读清单挂载以及 NET_RAW/no-new-privileges 变化。资源上限、UID、其他挂载、端口和业务环境不变。

依次执行以下阶段，每个生命周期动作单独调用并检查返回：

1. `prepare`：保护备份并冻结所有 Nginx include、主配置及旧容器身份。
2. `preview`：在私有配置树中运行 `nginx -t`，不安装配置、不复制 TLS 私钥。
3. `create --role edge-auth`、`create --role aiclient2api`：预创建停止的容器，核对实际资源、挂载、环境和身份。
4. `arm`：开启维护入口并验证 503，暂停管理/OAuth 写入。
5. `drain`：180 秒内连续三次持久化及磁盘缓冲为零，在途请求不超过 4；不满足则 `cancel`，不得停旧写入者。记录 1–4 请求可能被中断的上界。
6. `stop --role aiclient2api`，然后 `stop --role edge-auth`：确认旧写入者已停止且没有 OOM。
7. `configure`：仅写批准字段，安装新版 Nginx 拒绝审计链路；入口仍处于维护。
8. 分别 `rename-old`、`rename-new` 两个 role。先 `start --role edge-auth`，再 `start --role aiclient2api`。
9. `verify`：四进程健康、配置与清单收敛、积压清零、Key 集合不变。补充读取业务自身用量、拒绝审计、管理边界和插件安装禁用验证。
10. `open`：恢复新版入口；观察至少 10 分钟。只读取实际业务审计，不主动发起付费模型请求。核对 Key 集合、IP/Key 指纹/requestId、清单版本、重启/OOM、队列和错误。

若正式切换失败，`rollback-gate` 先恢复维护状态。停新主服务和新 edge-auth 后执行 `rollback-ingress`，再逐一重命名新容器为故障留存、将旧容器恢复原名，先启动旧 edge-auth 再启动旧主服务。旧代码没有大陆门禁，因此客户端入口必须保持维护，不能直接重新开放。不要恢复整个数据库、清空 Redis、覆盖并发产生的合法配置，或临时全球放行来通过验收。若并发配置/Nginx 哈希发生变化，工具停止，先人工核对差异。

正式发布和月度清单更新后检查 `/runtime/health` 的 `mainlandPolicy` 与 edge-auth `/health`，确认所有工作进程和 edge 使用相同哈希。清单更新说明见 [大陆门禁策略](mainland-client-key-policy.md)。

发布验证报告要区分新增功能验收、既有失败和未处理风险。旧配置凭据副本、AGY 授权、禁用 Codex 账号、宿主机 SSH、其他应用端口不在本轮修改范围。
