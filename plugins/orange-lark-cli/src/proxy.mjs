/**
 * 企业网络代理（HTTP API + WebSocket 长连接）。
 *
 * 与旧 `openclaw-lark` 的最大区别：那个插件的飞书流量走 Node SDK（axios + ws），
 * 必须自己构造 `https-proxy-agent` 塞进 SDK 和 MCP 的 undici dispatcher；新插件的
 * 飞书流量**全部在 lark-cli 子进程里**（REST + WebSocket + 长连接 bus），所以「代理
 * 能力」等价于「把正确的环境变量交给子进程」。
 *
 * lark-cli 自己的优先级（`internal/transport/shared.go`，优先级从高到低）：
 *
 *   1. proxy-plugin 模式：`LARKSUITE_CLI_PROXY_ENABLE` + `LARKSUITE_CLI_PROXY_ADDRESS`
 *      (+ `LARKSUITE_CLI_CA_PATH`)，强制所有出站流量走**固定 loopback 代理**，并信任
 *      一个额外的根证书（TLS 中间人代理用）。配置非法时 fail-closed。
 *   2. `LARK_CLI_NO_PROXY` 非空 → 直连。
 *   3. `http.DefaultTransport` → 遵守 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`。
 *
 * WebSocket 走 oapi-sdk-go 的 `ws.DefaultDialer`（gorilla），其 Proxy 是
 * `http.ProxyFromEnvironment`，所以第 1/3 档同样覆盖长连接——这正是旧插件必须给
 * `WSClient` 单独传 agent 才能做到的事。
 *
 * 本模块只做三件事，不引入任何依赖：
 *   - 解析配置（config > 环境变量），校验并脱敏；
 *   - 算出应该发给 lark-cli 子进程的 env；
 *   - 把 loopback 从代理里摘掉，避免插件自己的本地调用（gateway / token service）
 *     被宿主机上的全局代理带走。
 *
 * 兼容性：**没配代理、环境里也没有代理变量时，`proxyEnv()` 返回 undefined**，子进程
 * 完全继承父进程环境，行为与改造前一致。
 */

/** 代理地址相关环境变量，按优先级排列。 */
const PROXY_URL_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"];

/** 永远直连的主机：插件自己的 gateway / token service 都在这上面。 */
export const PROXY_LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];

function asText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstEnv(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** `no_proxy` 允许数组、逗号串、空格串。 */
function splitList(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => splitList(entry));
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * 规范化代理地址：`127.0.0.1:7890` → `http://127.0.0.1:7890`。
 *
 * @throws 地址不可用时抛出（错误信息已脱敏，不会带出 user:password）。
 */
export function normalizeProxyUrl(raw) {
  const text = asText(raw);
  if (!text) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`malformed proxy address ${maskProxyUrl(text)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported proxy scheme ${parsed.protocol} (use http:// or https://)`);
  }
  if (!parsed.hostname) throw new Error("proxy address is missing a host");
  // lark-cli 的 proxy-plugin 校验不接受 path/query/fragment，这里统一抹掉。
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

/** 日志里只保留 host:port，账号密码一律 `***`。 */
export function maskProxyUrl(raw) {
  const text = asText(raw);
  if (!text) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    const parsed = new URL(withScheme);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "***";
  }
}

/**
 * 解析代理配置。
 *
 * 支持三种写法（`config.yaml`）：
 *
 * ```yaml
 * proxy: http://127.0.0.1:7890          # 简写
 * proxy:
 *   url: http://127.0.0.1:7890
 *   no_proxy: [".corp.internal"]
 *   ca_path: /etc/ssl/corp-ca.pem
 *   mode: cli-plugin                    # 或 env（默认）
 * proxy:
 *   enabled: false                      # 显式直连（覆盖环境变量）
 * ```
 *
 * @returns {{
 *   enabled: boolean, url: string|undefined, source: "config"|"env"|"none",
 *   explicit: boolean, explicitUrl: boolean, noProxy: string[],
 *   mode: "env"|"cli-plugin", caPath: string|undefined,
 * }}
 */
export function resolveProxyConfig(raw, { env = process.env, log } = {}) {
  const cfg = typeof raw === "string" ? { url: raw } : raw && typeof raw === "object" ? raw : null;
  const flag = cfg?.enabled ?? cfg?.enable;
  const explicit = flag !== undefined;

  const envUrl = firstEnv(env, PROXY_URL_KEYS);
  const baseNoProxy = [...PROXY_LOOPBACK, ...splitList(firstEnv(env, NO_PROXY_KEYS))];
  const noProxy = dedupe([...baseNoProxy, ...splitList(cfg?.no_proxy ?? cfg?.noProxy)]);

  // 显式关闭：无论环境里有什么代理变量，都要求直连。
  if (flag === false) {
    return {
      enabled: false,
      url: undefined,
      source: "config",
      explicit: true,
      explicitUrl: false,
      noProxy,
      mode: "env",
      caPath: undefined,
    };
  }

  const configuredUrl =
    cfg?.url ?? cfg?.https_proxy ?? cfg?.httpsProxy ?? cfg?.http_proxy ?? cfg?.address;

  let url;
  let source = "none";
  let explicitUrl = false;

  if (configuredUrl !== undefined) {
    try {
      url = normalizeProxyUrl(configuredUrl);
      source = "config";
      explicitUrl = true;
    } catch (error) {
      log?.warn?.(`proxy: ignoring invalid address (${error?.message ?? error})`);
    }
  }
  if (!url && envUrl) {
    try {
      url = normalizeProxyUrl(envUrl);
      source = "env";
    } catch (error) {
      log?.warn?.(`proxy: ignoring invalid address from env (${error?.message ?? error})`);
    }
  }
  if (flag === true && !url) {
    log?.warn?.("proxy: enabled but no usable address; lark-cli will connect directly");
  }

  const caPath = asText(cfg?.ca_path ?? cfg?.caPath);
  // 需要额外根证书 = 必须走 CLI 的 proxy-plugin 模式，否则 CA 不会生效。
  const mode =
    asText(cfg?.mode) === "cli-plugin" || asText(cfg?.mode) === "plugin" || caPath
      ? "cli-plugin"
      : "env";

  return {
    enabled: Boolean(url),
    url,
    source,
    explicit,
    explicitUrl,
    noProxy,
    mode,
    caPath,
  };
}

/**
 * 发给 lark-cli 子进程的代理相关环境变量。
 *
 * 未配置且环境里没有代理 → `undefined`（子进程继承父进程，行为不变）。
 */
export function proxyEnv(proxy, { log } = {}) {
  if (!proxy) return undefined;
  if (!proxy.enabled) {
    // 只有「显式关闭」才主动要求直连；没写配置时保持继承。
    return proxy.explicit ? { LARK_CLI_NO_PROXY: "1" } : undefined;
  }

  const noProxy = proxy.noProxy.join(",");
  const env = {
    HTTP_PROXY: proxy.url,
    http_proxy: proxy.url,
    HTTPS_PROXY: proxy.url,
    https_proxy: proxy.url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };

  if (proxy.mode !== "cli-plugin") return env;

  let host = "";
  try {
    host = new URL(proxy.url).hostname;
  } catch {
    host = "";
  }
  if (host !== "127.0.0.1") {
    // CLI 的安全策略只允许 loopback 固定代理，且配错会 fail-closed（全部出站被拒）。
    // 这里退回标准 env 模式，保证「配了代理但主机不合规」时链路仍然可用。
    log?.warn?.(
      `proxy: cli-plugin mode requires a 127.0.0.1 proxy, got ${maskProxyUrl(proxy.url)}; falling back to standard env proxy`,
    );
    return env;
  }

  env.LARKSUITE_CLI_PROXY_ENABLE = "true";
  env.LARKSUITE_CLI_PROXY_ADDRESS = proxy.url;
  if (proxy.caPath) env.LARKSUITE_CLI_CA_PATH = proxy.caPath;
  // proxy-plugin 模式优先级高于 LARK_CLI_NO_PROXY，显式清掉避免误配造成直连。
  delete env.LARK_CLI_NO_PROXY;
  return env;
}

/** 一行日志，用于启动时自证「到底走没走代理」。 */
export function describeProxy(proxy) {
  if (!proxy) return "none";
  if (!proxy.enabled) return proxy.explicit ? "disabled (direct)" : "none";
  const parts = [`${maskProxyUrl(proxy.url)}`, `source=${proxy.source}`, `mode=${proxy.mode}`];
  if (proxy.caPath) parts.push(`ca=${proxy.caPath}`);
  parts.push(`no_proxy=${proxy.noProxy.join(",")}`);
  return parts.join(" ");
}

/**
 * 把 loopback 永久加进本进程的 `NO_PROXY`。
 *
 * 插件自己有几个本地 fetch（gateway 的 `/api/v1/cron/...`）。Node 24 起可以靠
 * `NODE_USE_ENV_PROXY=1` 让原生 fetch 走代理，那时如果宿主机设了全局
 * `HTTP_PROXY` 而没有排除 loopback，本地调用会被带去代理并失败。启动时补一次，
 * 对不支持代理的旧 Node 完全无副作用。
 */
export function ensureLoopbackBypass() {
  for (const key of NO_PROXY_KEYS) {
    const current = splitList(process.env[key]);
    const merged = dedupe([...current, ...PROXY_LOOPBACK]);
    if (merged.length !== current.length || !process.env[key]) {
      process.env[key] = merged.join(",");
    }
  }
}
