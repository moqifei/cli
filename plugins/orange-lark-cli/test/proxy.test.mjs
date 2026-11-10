#!/usr/bin/env node
/**
 * 企业网络代理回归测试（`npm test`）。
 *
 * 关注三件事：
 *   1. 没配代理时行为完全不变（兼容性红线）；
 *   2. 配了代理时，lark-cli 子进程拿到的是它认的那一套 env（含 proxy-plugin 的
 *      CA 模式与 loopback 直连排除）；
 *   3. 凭据不会进日志，错配置也不会把渠道搞挂。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  describeProxy,
  ensureLoopbackBypass,
  maskProxyUrl,
  normalizeProxyUrl,
  proxyEnv,
  resolveProxyConfig,
} from "../src/proxy.mjs";

function makeLogger() {
  const lines = [];
  const log = {
    lines,
    info: (m) => lines.push(["info", m]),
    warn: (m) => lines.push(["warn", m]),
    error: (m) => lines.push(["error", m]),
    debug: () => {},
  };
  log.child = () => log;
  return log;
}

test("no proxy configured and no proxy env keeps the previous behaviour", () => {
  const proxy = resolveProxyConfig(undefined, { env: {} });
  assert.equal(proxy.enabled, false);
  assert.equal(proxy.source, "none");
  assert.equal(proxyEnv(proxy), undefined, "children must inherit the parent env untouched");
  assert.equal(describeProxy(proxy), "none");
});

test("proxy from the gateway environment is inherited and loopback is excluded", () => {
  const proxy = resolveProxyConfig(undefined, {
    env: { HTTPS_PROXY: "http://corp-proxy:3128", NO_PROXY: ".corp.internal" },
  });
  assert.equal(proxy.enabled, true);
  assert.equal(proxy.source, "env");

  const env = proxyEnv(proxy);
  assert.equal(env.HTTPS_PROXY, "http://corp-proxy:3128");
  assert.equal(env.https_proxy, "http://corp-proxy:3128");
  assert.equal(env.LARKSUITE_CLI_PROXY_ENABLE, undefined, "env mode must not force the CLI proxy plugin");
  const noProxy = env.NO_PROXY.split(",");
  for (const host of ["localhost", "127.0.0.1", ".corp.internal"]) {
    assert.ok(noProxy.includes(host), `NO_PROXY should contain ${host}`);
  }
});

test("configured proxy wins over the environment and accepts the short form", () => {
  const proxy = resolveProxyConfig("127.0.0.1:7890", {
    env: { HTTPS_PROXY: "http://elsewhere:3128" },
  });
  assert.equal(proxy.enabled, true);
  assert.equal(proxy.source, "config");
  assert.equal(proxy.url, "http://127.0.0.1:7890");

  const env = proxyEnv(proxy);
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
});

test("enabled:false forces direct egress and overrides a host-level proxy", () => {
  const proxy = resolveProxyConfig({ enabled: false }, { env: { HTTPS_PROXY: "http://corp:3128" } });
  assert.equal(proxy.enabled, false);
  assert.deepEqual(proxyEnv(proxy), { LARK_CLI_NO_PROXY: "1" });
  assert.equal(describeProxy(proxy), "disabled (direct)");
});

test("cli-plugin mode carries the TLS-inspection CA to lark-cli", () => {
  const proxy = resolveProxyConfig(
    { url: "http://127.0.0.1:7890", ca_path: "/etc/ssl/corp-ca.pem" },
    { env: {} },
  );
  assert.equal(proxy.mode, "cli-plugin");
  const env = proxyEnv(proxy);
  assert.equal(env.LARKSUITE_CLI_PROXY_ENABLE, "true");
  assert.equal(env.LARKSUITE_CLI_PROXY_ADDRESS, "http://127.0.0.1:7890");
  assert.equal(env.LARKSUITE_CLI_CA_PATH, "/etc/ssl/corp-ca.pem");
  assert.equal(env.LARK_CLI_NO_PROXY, undefined);
});

test("cli-plugin mode degrades to env mode for a non-loopback proxy", () => {
  const log = makeLogger();
  const proxy = resolveProxyConfig({ url: "http://proxy.corp:3128", mode: "cli-plugin" }, { env: {}, log });
  const env = proxyEnv(proxy, { log });
  assert.equal(env.LARKSUITE_CLI_PROXY_ENABLE, undefined);
  assert.equal(env.HTTPS_PROXY, "http://proxy.corp:3128");
  assert.ok(
    log.lines.some(([, m]) => m.includes("requires a 127.0.0.1 proxy")),
    "the operator has to learn why CA mode was skipped",
  );
});

test("a bad proxy address is reported, never thrown", () => {
  const log = makeLogger();
  const proxy = resolveProxyConfig({ url: "socks5://corp:1080" }, { env: {}, log });
  assert.equal(proxy.enabled, false);
  assert.ok(log.lines.some(([, m]) => m.includes("unsupported proxy scheme")));
});

test("enabled:true without any address logs and goes direct", () => {
  const log = makeLogger();
  const proxy = resolveProxyConfig({ enabled: true }, { env: {}, log });
  assert.equal(proxy.enabled, false);
  assert.ok(log.lines.some(([, m]) => m.includes("no usable address")));
});

test("credentials never reach the logs", () => {
  assert.equal(maskProxyUrl("http://user:s3cret@proxy.corp:8080"), "http://***:***@proxy.corp:8080");
  const proxy = resolveProxyConfig({ url: "http://user:s3cret@proxy.corp:8080" }, { env: {} });
  assert.ok(!describeProxy(proxy).includes("s3cret"));
  assert.ok(!describeProxy(proxy).includes("user:"));
  assert.ok(!String(proxyEnv(proxy)).includes("s3cret"), "the env keeps the password: only logs must hide it");
  assert.equal(normalizeProxyUrl("http://user:s3cret@proxy.corp:8080"), "http://user:s3cret@proxy.corp:8080");
});

test("loopback bypass is merged into the process env exactly once", () => {
  const previous = process.env.NO_PROXY;
  process.env.NO_PROXY = ".corp.internal";
  try {
    ensureLoopbackBypass();
    const merged = process.env.NO_PROXY.split(",");
    assert.ok(merged.includes(".corp.internal"));
    assert.ok(merged.includes("127.0.0.1"));
    assert.ok(merged.includes("localhost"));
    const once = process.env.NO_PROXY;
    ensureLoopbackBypass();
    assert.equal(process.env.NO_PROXY, once, "idempotent");
  } finally {
    if (previous === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previous;
  }
});

test("normalizeAccounts turns the proxy block into child process env", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orange-proxy-"));
  process.env.ORANGE_HOME = home;
  const { normalizeAccounts } = await import("../src/index.mjs");
  const log = makeLogger();

  const [account] = normalizeAccounts(
    { proxy: { url: "http://127.0.0.1:7890", no_proxy: [".corp.internal"] } },
    null,
    {},
    { log },
  );

  assert.equal(account.proxy.enabled, true);
  assert.equal(account.env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.ok(account.env.NO_PROXY.includes(".corp.internal"));
  assert.ok(account.env.NO_PROXY.includes("127.0.0.1"));

  // Per-account override wins, and explicit `env` can still override the proxy.
  const [overridden] = normalizeAccounts(
    {
      proxy: { url: "http://127.0.0.1:7890" },
      accounts: { a: { config_dir: path.join(home, "a"), proxy: { enabled: false } } },
    },
    null,
    {},
    { log },
  );
  assert.deepEqual(overridden.env, { LARK_CLI_NO_PROXY: "1" });

  // The chain that actually matters: those vars must reach the child process.
  const { runCli } = await import("../src/cli.mjs");
  const script =
    "process.stdout.write(JSON.stringify({ok:true,data:{proxy:process.env.HTTPS_PROXY,noProxy:process.env.NO_PROXY}}))";
  const result = await runCli({
    cliPath: process.execPath,
    cwd: home,
    args: ["-e", script],
    timeoutMs: 10_000,
    env: account.env,
  });
  assert.equal(result.data.proxy, "http://127.0.0.1:7890");
  assert.ok(result.data.noProxy.includes("127.0.0.1"));
});
