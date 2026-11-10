# 企业网络代理（HTTP / WebSocket）

企业内网通常不允许直连 `open.feishu.cn` / `open.larksuite.com`，所有出站流量必须走
HTTP 代理（gost、Squid、企业网关），并且很多代理会做 TLS 中间人（需要额外根证书）。

## 与旧插件（openclaw-lark）的差异

旧插件的飞书流量在 Node 进程里（`@larksuiteoapi/node-sdk` 的 axios + `ws`），所以
`PROXY_PATCH.md` 里必须自己构造 `https-proxy-agent`，再分别塞进 `Lark.Client`、
`Lark.WSClient` 和 MCP 的 undici `dispatcher`。

新插件**没有任何飞书 SDK 调用**：REST、WebSocket 长连接、卡片、发消息全部在
`lark-cli` 子进程里。因此「代理能力」= **把正确的环境变量交给子进程**，不需要
agent、不需要依赖。`src/proxy.mjs` 只负责这件事。

## lark-cli 的代理契约

`lark-cli/internal/transport/shared.go` 的优先级（从高到低）：

| 优先级 | 机制 | 环境变量 |
|---|---|---|
| 1 | proxy-plugin 模式：强制全部出站走**固定 loopback 代理**，可带 TLS 中间人根证书；配置非法时 fail-closed | `LARKSUITE_CLI_PROXY_ENABLE=true`、`LARKSUITE_CLI_PROXY_ADDRESS=http://127.0.0.1:7890`、`LARKSUITE_CLI_CA_PATH=/path/ca.pem` |
| 2 | 强制直连 | `LARK_CLI_NO_PROXY=1` |
| 3 | 标准代理（`http.DefaultTransport`） | `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` |

WebSocket 走 oapi-sdk-go 的 `ws.DefaultDialer`，其 `Proxy` 是 `http.ProxyFromEnvironment`，
所以第 1、3 档同样覆盖长连接；`event consume` fork 出来的本地 bus daemon 继承同一个
环境，不需要单独处理。

## 配置

三种写法等价优先级：**配置文件里的 `proxy.url` > 进程环境变量 > 无代理**。

```yaml
plugins:
  entries:
    orange-lark-cli:
      config:
        # 1) 最简：只写地址（没有 http:// 也可以）
        proxy: http://127.0.0.1:7890
```

```yaml
plugins:
  entries:
    orange-lark-cli:
      config:
        proxy:
          url: http://127.0.0.1:7890
          # 直连白名单：loopback 永远在里面（插件自己的 gateway / token service）
          no_proxy: [".corp.internal", "10.0.0.0/8"]
          # TLS 中间人代理的根证书：设置后自动切到 lark-cli 的 proxy-plugin 模式
          ca_path: /etc/ssl/certs/corp-root-ca.pem
          # 强制模式：env（默认，标准 HTTP_PROXY）| cli-plugin（固定 loopback 代理 + CA）
          mode: cli-plugin
```

显式直连（覆盖宿主机上的全局代理变量）：

```yaml
        proxy:
          enabled: false
```

按账号覆盖（多租户 / 不同出口）：

```yaml
        accounts:
          work:
            proxy: http://127.0.0.1:7890
          lab:
            proxy:
              enabled: false
```

账号级 `proxy:` **整体覆盖**插件级，不做字段合并——避免出现「半套配置」难以排查。
`env:` 里显式写的 `HTTPS_PROXY` 等仍然优先于 `proxy:` 生成的变量。

## 兼容性

| 场景 | 行为 |
|---|---|
| 没写 `proxy:`，环境里也没有代理变量 | 子进程 env 不加任何东西，**与改造前完全一致** |
| 没写 `proxy:`，但宿主机设了 `HTTPS_PROXY` | 原样继承（Orange 的 env 白名单已包含代理变量） |
| `proxy.enabled: false` | 子进程收到 `LARK_CLI_NO_PROXY=1`，强制直连 |
| 地址写错 / 协议不支持（如 `socks5://`） | 打一条 warn，退回继承模式，**不会让渠道启动失败** |
| `mode: cli-plugin` 但地址不是 `127.0.0.1` | 打 warn 并退回标准 `HTTPS_PROXY` 模式（否则 CLI 会 fail-closed 断开全部出站） |
| 代理地址带 `user:pass@` | env 里照常使用；**日志里一律 `***`** |

插件的本地调用（Orange gateway 的 `/api/v1/cron/...`、`http_token_injector` 的
token service）在启动时会确保 `NO_PROXY` 包含 `localhost` / `127.0.0.1` / `::1`，
不会被宿主机上的全局代理带走。

> 插件自身的 `fetch` 只在 Node ≥ 24 且 `NODE_USE_ENV_PROXY=1` 时才读代理变量。
> 如果 token service 在需要代理的外网，给 gateway 进程设这个变量；否则它默认直连。

## 验证

启动日志（每个账号一行，凭据已脱敏）：

```
resolved accounts: work(cli=/path/bin/lark-cli, proxy=http://127.0.0.1:7890 source=config mode=env no_proxy=localhost,127.0.0.1,::1,[::1],.corp.internal)
network proxy: http://127.0.0.1:7890 source=config mode=cli-plugin ca=/etc/ssl/certs/corp-root-ca.pem no_proxy=...
```

没配代理时是 `proxy=none`，配了 `enabled: false` 是 `proxy=disabled (direct)`。

代理侧应当能看到两条不同的连接：

- `POST /open-apis/im/v1/messages`（发消息，HTTPS）
- 飞书 WebSocket 的 `CONNECT` / 长连接（收消息；用的是 `open.feishu.cn` 的 ws 端点）

反向验证（确认代理真的生效）：停掉代理进程后重启 gateway，日志里会出现
`lark-cli ... timeout` 或 `network` 类错误，而 `event consume` 迟迟不 ready。

## 常见问题

- **gost 用原始 TCP 模式**（`gost -L :7890`）无法承载 WebSocket 的 CONNECT 隧道，
  请用 `gost -L http://:7890`（必要时 `-F forward://+tls:7891` 支持 TLS 隧道）。
- **TLS 中间人代理**必须同时配 `ca_path`；只配 `url` 会看到
  `x509: certificate signed by unknown authority`。
- **只想让某个账号直连**：在账号下写 `proxy: { enabled: false }`，不要去改全局环境。
- **临时绕过**：`LARK_CLI_NO_PROXY=1 orange gateway restart`（优先级低于 proxy-plugin 模式）。
