# 离线 TLS 与代理实际验证

`scripts/ops/security-tls-proxy-smoke.mjs` 在 Node 24 应用镜像中启动本地 HTTPS mock、HTTP CONNECT 代理与真实 Go TLS sidecar，验证证书校验、直连、代理、SSE、客户端中断传播，以及真实 Axios 对一次 500 的重试。另起一个未信任测试 CA 的 sidecar，确认它拒绝证书。没有外部网络或模型调用。

在仓库外的临时目录生成仅用于测试的自签证书：

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout /absolute/fixture/key.pem -out /absolute/fixture/cert.pem -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost
```

运行时显式挂载脚本与 fixture；不必将证书或脚本预先写入已发布镜像：

```sh
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --mount type=bind,src=/absolute/fixture,dst=/fixtures,readonly \
  --mount type=bind,src=/absolute/repo/scripts/ops/security-tls-proxy-smoke.mjs,dst=/smoke.mjs,readonly \
  --entrypoint node aiclient2api:mainland-hardened /smoke.mjs
```

最后一行为 `status: passed` 的 JSON，列出实际场景、CONNECT 次数、重试次数及中断次数。完成后删除本次生成的测试私钥，保留报告；不要将测试私钥或任何真实凭据提交到 Git。
