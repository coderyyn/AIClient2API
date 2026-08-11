# AIClient2API 轻量蓝绿部署设计

## 目标与边界

本方案先解决当前“停旧容器后才启动新容器”造成的长时间 502：候选镜像在备用主 API 端口完成启动、版本和健康预检，确认可用后才进入正式交接。

当前 `provider_pools.json`、API Potluck key store、用量缓存等状态由 Node 进程在内存中维护，文件锁也主要是进程内锁。因此两个实例不能长期共享同一个可写 `configs` 并同时承载流量。本方案坚持单写者，属于“预热蓝绿验证 + 数秒级有状态交接”，不等于严格无缝双活。

本轮只保障主 API 的候选预热。OAuth 使用固定回调端口，部署窗口暂停发起新的 OAuth 授权；候选预检不发布 `1455`、`8085–8087`、`19876–19880`、`56121`。

## 镜像构建和版本确认

必须从干净提交构建：

```bash
./scripts/ops/build-image.sh <git-ref> aiclient2api:custom-<shortsha>-<date>
```

构建脚本把完整提交写入：

- 镜像标签 `yyn.base_commit`
- 镜像内 `/app/REVISION`
- `yyn.build_date` 和 `yyn.build_source`

标签与目标提交不一致时构建直接失败。部署前再次执行：

```bash
docker image inspect --format '{{ index .Config.Labels "yyn.base_commit" }}' <image>
```

## 候选预检

脚本默认 dry-run：

```bash
./scripts/ops/blue-green-deploy.sh --image <image> --revision <full-commit>
```

明确授权后，才可创建候选：

```bash
./scripts/ops/blue-green-deploy.sh \
  --image <image> \
  --revision <full-commit> \
  --phase prepare \
  --apply
```

行为如下：

1. 核对镜像 revision。
2. 把 canonical configs 复制到权限为 700 的候选快照目录。
3. 候选限制为 1 CPU、1 GB 内存，只绑定 `127.0.0.1:13001 -> 3000`。
4. 等待 Docker health，并检查 `/api/health`。
5. 不触碰当前容器、Nginx 或 OAuth 端口。

可以生成 upstream 预览：

```bash
./scripts/ops/blue-green-deploy.sh \
  --image <image> \
  --revision <full-commit> \
  --phase render \
  --apply
```

该阶段只生成预览并执行 `nginx -t`，不会安装到 `/etc/nginx`。

## 正式单写者交接

正式切换需要单独生产授权，并按以下顺序人工确认：

1. 记录当前镜像、容器 inspect、Nginx upstream、health 和最近错误日志。
2. 暂停新 OAuth 和管理写操作。
3. 候选预检全部通过后，让旧实例停止接收新请求并 graceful flush。
4. 使用 canonical configs 启动最终 green 容器，重新占用固定 OAuth 端口。
5. 检查 health、revision、`/api/usage` 大小与延迟。
6. 写入 upstream 临时文件，执行 `nginx -t`。
7. 原子替换 upstream include 并 reload Nginx。
8. 保留旧容器和镜像至观察窗口结束。

如果必须做到严格零请求中断，需要先把 API Potluck、provider 状态及用量缓存迁移到可并发访问的外部状态存储，或增加可验证的跨进程 mutation ledger；这不属于轻量修复范围。

## 回滚

- 预检失败：删除带 `yyn.deployment_role=candidate` 标签的候选容器，当前服务不受影响。
- Nginx 切换前失败：不安装 upstream 预览。
- 切换后失败：恢复旧 upstream 文件，执行 `nginx -t` 后 reload，并重新启动旧容器。
- 配置快照默认保留，不由脚本自动删除，避免误删凭据和故障证据。

## Docker 日志轮转建议

生产 Docker `json-file` 日志建议配置轮转，但需要单独生产配置授权：

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  }
}
```

修改 daemon 配置前先确认现有日志驱动；修改通常需要重启 Docker，不应与首次蓝绿切换同时执行。
