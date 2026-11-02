# 阿里云地区准入例外

只覆盖固定的 AS37963、AS45102、AS134963（国内、香港和海外核心云），不自动发现新 ASN，不包含其他 CDN/关联 ASN。BGP 是网络通告证据，不是租户身份或物理位置证明；地区例外不会跳过 Key、配额、并发或管理接口白名单。

## 数据及判定

应用与 edge-auth 同时设置 `ALIBABA_ALLOWLIST_ENABLED=true`、`ALIBABA_ALLOWLIST_FILE=/app/security/alibaba-allowlist.json`，使用同一只读数据目录和同版本代码。

判定：真实公网 IP → 固定例外 `EXPLICIT_IP_ALLOWLIST` → 大陆 `MAINLAND_CN` → 阿里云 `ALIBABA_CLOUD_ALLOWLIST` → 地区拒绝。审计包含 `allowlistSha256` 和 `asn`，香港例外不标为大陆，私网或无法核实的 IP 不放行。

独立 manifest 包含 ASN、规范化 CIDR、来源、查询截止时间、生成时间、固定例外和 SHA-256。`explicit-ip-allowlist.json` 是固定 IP 字符串数组，每次更新编译进 manifest，不再污染 CN 清单。健康状态位于 `mainlandPolicy.alibabaAllowlist`（runtime 在各 worker 下），包含版本、数据时间、最后成功更新、加载/更新错误及 stale；汇总为 `alibabaAllowlistReady`。

每秒热加载；损坏更新保留上次有效数据。冷启动没有有效清单时大陆保持可用，非大陆返回 503。数据或最后成功更新超过 72 小时显示过期，继续使用最后有效版本。

## 更新操作

在应用镜像内运行 `node scripts/ops/update-alibaba-allowlist.mjs`，可写挂载 `/data`，使用 host 网络检查宿主 loopback 健康接口。

- 默认预览：`--output /data/alibaba-allowlist.json --exceptions-file /data/explicit-ip-allowlist.json`。仅写 `.candidate.json`，不改活动清单或状态。
- 首次启用：人工审查候选后 `--output /data/alibaba-allowlist.json --candidate /data/alibaba-allowlist.json.candidate.json --apply --bootstrap`。活动文件必须不存在；先准备数据，再启用配置。
- 日常更新：`--output /data/alibaba-allowlist.json --exceptions-file /data/explicit-ip-allowlist.json --apply --runtime-url http://127.0.0.1:13000/runtime/health --edge-health-url http://127.0.0.1:18081/health`。
- 大幅变化：审核候选后，使用 `--candidate <候选绝对路径> --accept-large-change` 加日常 apply 参数。只覆盖变化阈值，不能绕过数据校验。
- 恢复上一版：`--restore-previous` 加日常 apply 参数；不下载，仍验证收敛。

来源为 RIPEstat Announced Prefixes：https://stat.ripe.net/docs/data-api/api-endpoints/announced-prefixes 。用整数 Unix 秒查询最近 48 小时，只选截止时有效通告。三个 ASN 都需有有效公网网段，数据不超过 72 小时。每个 ASN 的网段数量或 IPv4/IPv6 地址并集覆盖量变化超过 25% 时保留旧版和候选。首次无基线，必须人工审查。

更新采用互斥锁、备份、原子替换；30 秒不收敛则恢复并复核原数据。不要自动抢占遗留 `.lock`：先确认 systemd 与更新容器均不运行并检查锁内容，才可清理。失败写 `.status.json`，不增加外部通知渠道。

## 发布与回滚

使用同提交双容器发布流程，规格设置 `alibabaAllowlist=true`、`alibabaSha=<审核哈希>`。先保留当前地区数据启用独立机制，确认四 worker 与 edge 收敛，再从校验过的备份恢复纯 CN 数据并复核。

正式应用镜像另打标签 `aiclient2api:alibaba-allowlist-updater`；安装仓库 `docker/alibaba-allowlist-update.service`、`.timer`，北京时间每天 04:20 随机延迟最多 10 分钟，漏跑补执行。先手动启动一次 service 验证真实更新，再启用 timer。

回滚先停 timer 并确认无更新任务；恢复原先含两条例外的地区清单后，再恢复旧容器。只恢复本次批准配置字段，不覆盖业务并发配置或数据库。保留备份、旧容器和旧镜像。
