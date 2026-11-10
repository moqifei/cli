/**
 * Orange Feishu channel backed by the official larksuite/cli binary.
 *
 * Scope of this first cut (feasibility validation):
 *   inbound  : `lark-cli event consume im.message.receive_v1 --as bot`
 *   outbound : `lark-cli im +messages-send` (text only)
 *   routing  : one account == one CLI config dir == one consumer process
 *   retries  : supervised consumer restart with backoff
 *
 * Deliberately NOT implemented yet: cards, threads, media, tools, UAT,
 * enterprise token hook, proxy policy. See docs/ for the staged plan.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CARD_ACTION_EVENT_KEY,
  createAskUserQuestionTool,
  handleCardActionEvent,
} from "./ask-user.mjs";
import {
  argvHasExplicitIdentity,
  argvWantsUserIdentity,
  invalidateAuthStatus,
  normalizeOwnerId,
  wantsUserIdentityByDefault,
} from "./auth.mjs";
import {
  AUTH_WAIT_LINE,
  addressFor,
  clearTurnGate,
  ensureUserAuthorized,
  isScopeFailure,
  isTurnGated,
  isUserTokenFailure,
  ownerIdFromToolCtx,
  registerAuthHooks,
  registerRuntime,
  rememberTurn,
  resolveToolChat,
  setOwnerAccountResolver,
  unregisterRuntime,
} from "./auth-gate.mjs";
import { runCli } from "./cli.mjs";
import { EventConsumer } from "./consumer.mjs";
import { createLogger } from "./log.mjs";
import { createDeduper, mapMessageEvent } from "./mapper.mjs";
import {
  describeProxy,
  ensureLoopbackBypass,
  proxyEnv,
  resolveProxyConfig,
} from "./proxy.mjs";
import { buildBriefCard } from "./brief-card.mjs";
import { looksLikeEnvelope, renderDeltaForUser } from "./render.mjs";
import { registerHttpTokenInjector } from "./http-token-injector.mjs";
import { createUserTools } from "./user-tools.mjs";
import { blocksToPlainText, sendCard, sendPost, sendTextChunked } from "./outbound.mjs";
import { StreamingReply } from "./streaming.mjs";

const DEFAULT_EVENT_KEY = "im.message.receive_v1";
const DEFAULT_IDENTITY = "bot";
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function orangeHome() {
  return process.env.ORANGE_HOME && process.env.ORANGE_HOME.trim()
    ? process.env.ORANGE_HOME
    : path.join(os.homedir(), ".orange");
}

function asString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Footer 开关（与旧插件 `DEFAULT_FOOTER_CONFIG` 一致：默认全关）。
 *
 * 只有 status / elapsed / model 在新插件里有数据源；tokens / cache / context
 * 依赖 session 统计，拿不到时宁可不显示，也不显示 0。
 */
function resolveFooter(raw) {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    status: cfg.status === true,
    elapsed: cfg.elapsed === true,
    tokens: cfg.tokens === true,
    cache: cfg.cache === true,
    context: cfg.context === true,
    model: cfg.model === true,
  };
}

function envMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[key] = String(raw);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* best effort: lark-cli surfaces its own error if the dir is unusable */
  }
  return dir;
}

/**
 * Prefer the CLI binary shipped inside the plugin package
 * (`<plugin>/bin/lark-cli`), so the package is self-contained and `cli_path`
 * does not have to be absolute in config.yaml.
 */
export function defaultCliPath() {
  const pluginDir = process.env.ORANGE_PLUGIN_DIR || process.cwd();
  const bundled = path.join(pluginDir, "bin", "lark-cli");
  try {
    if (fs.existsSync(bundled)) return bundled;
  } catch {
    /* ignore */
  }
  return "lark-cli";
}

/**
 * Derive accounts from the existing `channels.feishu.accounts` block, so
 * switching plugins does not require duplicating credentials or account ids in
 * config.yaml. The CLI keeps its own credential store per `config_dir`.
 */
export function accountsFromChannelConfig(api) {
  const accounts = api?.config?.channels?.feishu?.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return null;
  const out = {};
  for (const [accountId, value] of Object.entries(accounts)) {
    if (!value || typeof value !== "object") continue;
    if (value.enabled === false) continue;
    out[accountId] = {
      config_dir: path.join(orangeHome(), "data", "lark-cli", accountId),
      identity: "bot",
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Normalise `plugins.entries.orange-lark-cli.config.accounts`.
 *
 * lark-cli audits its config directory (owner, mode, symlinks), so the plugin
 * creates it 0700 and never writes secrets itself — credentials stay in the
 * CLI-owned config dir.
 */
export function normalizeAccounts(
  pluginConfig,
  fallbackAccounts = null,
  channelConfig = {},
  { log } = {},
) {
  const cfg = pluginConfig ?? {};
  // `channels.feishu` is Orange's own channel config (renderMode / streaming /
  // reasoning / replyMode). Plugin config wins when both are present.
  const chan = channelConfig && typeof channelConfig === "object" ? channelConfig : {};
  const cliPath = asString(cfg.cli_path, defaultCliPath());
  const defaults = {
    identity: asString(cfg.identity, DEFAULT_IDENTITY),
    eventKey: asString(cfg.event_key, DEFAULT_EVENT_KEY),
    readyTimeoutMs: Number(cfg.ready_timeout_ms) || DEFAULT_READY_TIMEOUT_MS,
    sendTimeoutMs: Number(cfg.send_timeout_ms) || 60_000,
    maxConcurrent: Number(cfg.max_concurrent) || 4,
    botOpenId: asString(cfg.bot_open_id, undefined),
    allowMessageTypes: Array.isArray(cfg.message_types) ? cfg.message_types : undefined,
    // Rendering: "card" enables CardKit streaming; anything else is plain text.
    renderMode: asString(cfg.render_mode ?? cfg.renderMode ?? chan.renderMode, "text"),
    streaming: Boolean(cfg.streaming ?? chan.streaming ?? false),
    reasoning: cfg.reasoning ?? chan.reasoning ?? { enabled: false, expanded: false },
    replyMode: chan.replyMode ?? cfg.replyMode ?? {},
    // Mirrors `channels.feishu.requireMention`: without a mention the host skips
    // the turn, so the plugin must not start rendering a card for it.
    requireMention: (cfg.requireMention ?? chan.requireMention ?? true) !== false,
    // Extra environment for the lark-cli child (proxy, test doubles, …).
    // Orange filters the inherited env, so anything the CLI needs beyond the
    // allowlist has to be declared here.
    env: envMap(cfg.env),
    // 授权范围策略：
    //   skill    —— 只申请当前技能/命令**涉及的业务域**（默认）。等价旧插件
    //               `auto-auth.ts` 按 TOOL_SCOPES 精确申请：日程技能不会把邮箱
    //               权限一起要过来，但同域内的权限一次给全，不再逐项冒。
    //   all      —— 应用已开通的全部用户级权限。对应旧插件 `/feishu_auth`
    //               批量授权（`auth.ts` → `triggerOnboarding`）。
    //   declared —— 只申请 SKILL.md 声明的 scope（最小集）。
    // 显式 auth_scopes 清单优先级最高，等于把范围钉死。
    authScopeMode: asString(
      cfg.auth_scope_mode ?? cfg.authScopeMode ?? chan.auth_scope_mode ?? chan.authScopeMode,
      "skill",
    ),
    authScopes: Array.isArray(cfg.auth_scopes ?? cfg.authScopes)
      ? cfg.auth_scopes ?? cfg.authScopes
      : undefined,
    // 卡片细节，对齐旧插件：
    //   show_tool_use        —— 工具执行面板开关（默认开）
    //   loading_icon_img_key —— 租户自己上传的转圈图标（img_v3_...，默认不发）
    //   footer               —— 终帧 footer 开关（默认全关，与旧插件一致）
    card: {
      showToolUse: (cfg.card?.show_tool_use ?? cfg.card?.showToolUse ?? true) !== false,
      loadingIcon: asString(cfg.card?.loading_icon_img_key ?? cfg.card?.loadingIcon),
      footer: resolveFooter(cfg.footer ?? chan.footer),
    },
    // 回复时是否进话题（thread）。默认按「回复消息」的方式挂在原消息下。
    replyInThread: (cfg.reply_in_thread ?? cfg.replyInThread ?? chan.replyInThread) === true,
    // 企业网络代理（插件级默认，账号级可覆盖）。解析结果见下面每套账号的 env。
    proxy: resolveProxyConfig(cfg.proxy, { log }),
  };

  const rawAccounts =
    cfg.accounts && typeof cfg.accounts === "object" && Object.keys(cfg.accounts).length > 0
      ? cfg.accounts
      : fallbackAccounts;

  if (!rawAccounts || Object.keys(rawAccounts).length === 0) {
    const accountId = "default";
    const configDir = ensureDir(path.join(orangeHome(), "data", "lark-cli", accountId));
    return [
      {
        accountId,
        cliPath,
        configDir,
        scratchDir: ensureDir(path.join(configDir, "workspace")),
        ...defaults,
        env: { ...(proxyEnv(defaults.proxy, { log }) ?? {}), ...(defaults.env ?? {}) },
      },
    ];
  }

  return Object.entries(rawAccounts)
    .filter(([, value]) => value && typeof value === "object" && value.enabled !== false)
    .map(([accountId, value]) => {
      const accountCfg = value;
      const configDir = ensureDir(
        asString(accountCfg.config_dir, path.join(orangeHome(), "data", "lark-cli", accountId)),
      );
      // 账号级 `proxy:` 完全覆盖插件级（不是逐字段合并），避免「半套配置」更难排查。
      const proxy =
        accountCfg.proxy === undefined
          ? defaults.proxy
          : resolveProxyConfig(accountCfg.proxy, { log });
      const ownEnv = envMap(accountCfg.env);
      return {
        accountId,
        cliPath: asString(accountCfg.cli_path, cliPath),
        configDir,
        scratchDir: ensureDir(asString(accountCfg.scratch_dir, path.join(configDir, "workspace"))),
        ...defaults,
        identity: asString(accountCfg.identity, defaults.identity),
        eventKey: asString(accountCfg.event_key, defaults.eventKey),
        botOpenId: asString(accountCfg.bot_open_id, defaults.botOpenId),
        renderMode: asString(accountCfg.render_mode ?? accountCfg.renderMode, defaults.renderMode),
        streaming: accountCfg.streaming === undefined ? defaults.streaming : Boolean(accountCfg.streaming),
        reasoning: accountCfg.reasoning ?? defaults.reasoning,
        authScopeMode: asString(
          accountCfg.auth_scope_mode ?? accountCfg.authScopeMode,
          defaults.authScopeMode,
        ),
        authScopes: Array.isArray(accountCfg.auth_scopes ?? accountCfg.authScopes)
          ? accountCfg.auth_scopes ?? accountCfg.authScopes
          : defaults.authScopes,
        proxy,
        // 显式 env 覆盖代理变量：运维要临时换代理时不用改代码结构。
        env: { ...(proxyEnv(proxy, { log }) ?? {}), ...(ownEnv ?? defaults.env ?? {}) },
      };
    });
}

function probeCliBinary(cliPath, configDir, extraEnv = null) {
  return new Promise((resolve) => {
    execFile(
      cliPath,
      ["--version"],
      {
        timeout: 5_000,
        // 带上代理变量：企业环境里 `--version` 也会触发 CLI 的 proxy-plugin 校验，
        // 配错时代码路径必须和真正跑命令时一致。
        env: {
          ...process.env,
          ...(configDir ? { LARKSUITE_CLI_CONFIG_DIR: configDir } : {}),
          ...(extraEnv ?? {}),
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, detail: String(stderr || error.message).trim().slice(0, 300) });
          return;
        }
        resolve({ ok: true, version: String(stdout).trim() });
      },
    );
  });
}

function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return async function acquire(fn) {
    if (active >= limit) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

class AccountRuntime {
  constructor({ account, api, logger }) {
    this.account = account;
    this.api = api;
    this.log = logger;
    this.consumer = null;
    this.stopped = false;
    this.restartAttempt = 0;
    this.restartTimer = null;
    this.deduper = createDeduper();
    this.chatChains = new Map();
    this.limit = createSemaphore(account.maxConcurrent);
  }

  async start() {
    // 企业部署第一个要确认的就是「到底走没走代理」：启动时打一行、凭证脱敏。
    this.log.info(`network proxy: ${describeProxy(this.account.proxy)}`);
    const probe = await probeCliBinary(
      this.account.cliPath,
      this.account.configDir,
      this.account.env,
    );
    if (probe.ok) {
      this.log.info(`lark-cli version: ${probe.version}`);
    } else {
      this.log.error(`lark-cli not runnable (${this.account.cliPath}): ${probe.detail}`);
    }
    await this.resolveBotOpenId();
    await this.startConsumer();
    // Card callbacks come on a separate EventKey. The CLI's bus daemon owns
    // one WebSocket per app; a second consumer just attaches over the local
    // unix socket, so this costs no extra connection.
    void this.startCardActionConsumer();
  }

  /**
   * 机器人自己的 open_id。
   *
   * 这是**应用维度**的标识：换个飞书应用（测试/生产、不同租户）值就不同，把一份
   * 配置抄到另一个环境必然对不上，群聊里就会把「@别人」当成「@我」，或者反过来
   * 谁 @ 都不响应。所以每次启动都用 `bot/v3/info` 校准一遍：
   *  - 配置为空 → 自动填上；
   *  - 配置和本应用不符 → 用探测值并告警；
   *  - 探测失败 → 保留配置值（没有配置就退化成「任何 mention 都算」）。
   */
  async resolveBotOpenId() {
    const configured = this.account.botOpenId;
    try {
      const result = await runCli({
        cliPath: this.account.cliPath,
        configDir: this.account.configDir,
        cwd: this.account.scratchDir,
        args: ["api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "json"],
        timeoutMs: 15_000,
        env: this.account.env,
        log: this.log,
      });
      const openId = result?.data?.open_id;
      if (typeof openId === "string" && openId.startsWith("ou_")) {
        if (configured && configured !== openId) {
          this.log.warn(
            `configured bot_open_id ${configured} does not belong to this app; using ${openId}`,
          );
        }
        this.account.botOpenId = openId;
        this.log.info(`bot open_id: ${openId}${configured ? " (verified)" : " (auto-detected)"}`);
        return;
      }
    } catch (error) {
      this.log.warn(`could not read bot/v3/info: ${error?.message ?? error}`);
    }
    if (configured) {
      this.log.warn(`keeping the configured bot_open_id ${configured} (unverified)`);
    } else {
      this.log.warn(
        "bot_open_id unknown; group @ detection will treat ANY mention as an @ to this bot",
      );
    }
  }

  /**
   * Subscribe to `card.action.trigger` for feishu_ask_user_question.
   *
   * Kept independent of the message consumer: a broken callback subscription
   * must never take the whole channel down.
   */
  async startCardActionConsumer() {
    if (this.stopped || this.cardConsumer) return;
    const consumer = new EventConsumer({
      cliPath: this.account.cliPath,
      configDir: this.account.configDir,
      cwd: this.account.scratchDir,
      eventKey: CARD_ACTION_EVENT_KEY,
      identity: "bot",
      readyTimeoutMs: this.account.readyTimeoutMs,
      env: this.account.env,
      log: this.log,
      onEvent: (event) => this.handleCardAction(event),
      onFatal: () => {
        if (this.stopped || this.cardConsumer !== consumer) return;
        this.log.warn("card action consumer exited, retrying in 5s");
        setTimeout(() => {
          if (!this.stopped && this.cardConsumer === consumer) {
            void consumer.start().catch((error) =>
              this.log.warn(`card action consumer restart failed: ${error?.message ?? error}`),
            );
          }
        }, 5_000).unref?.();
      },
    });
    this.cardConsumer = consumer;
    try {
      await consumer.start();
      this.log.info(`card actions ready (event=${CARD_ACTION_EVENT_KEY} pid=${consumer.pid})`);
    } catch (error) {
      this.cardConsumer = null;
      this.log.warn(`card actions NOT ready (ask-user cards will not work): ${error?.message ?? error}`);
    }
  }

  async handleCardAction(event) {
    const id = String(event?.event_id ?? event?.message_id ?? "");
    if (id && !this.deduper.firstTime(`card:${id}`)) return;
    const result = await handleCardActionEvent(event, {
      account: this.account,
      runtime: this,
      log: this.log,
    });
    if (result?.handled) this.log.info(`card action: ${result.note ?? "handled"}`);
  }

  async startConsumer() {
    if (this.stopped) return;
    const consumer = new EventConsumer({
      cliPath: this.account.cliPath,
      configDir: this.account.configDir,
      cwd: this.account.scratchDir,
      eventKey: this.account.eventKey,
      identity: this.account.identity,
      readyTimeoutMs: this.account.readyTimeoutMs,
      env: this.account.env,
      log: this.log,
      onEvent: (event) => this.handleEvent(event),
      onFatal: () => this.scheduleRestart(),
    });
    this.consumer = consumer;

    try {
      await consumer.start();
      this.restartAttempt = 0;
      this.log.info(
        `channel ready (account=${this.account.accountId} event=${this.account.eventKey} pid=${consumer.pid})`,
      );
    } catch (error) {
      this.log.error(`channel NOT ready: ${error?.message ?? error}`);
      this.scheduleRestart();
    }
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)];
    this.restartAttempt += 1;
    this.log.info(`restarting consumer in ${delay}ms (attempt ${this.restartAttempt})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startConsumer();
    }, delay);
  }

  async stop() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await Promise.allSettled([this.consumer?.stop(), this.cardConsumer?.stop()]);
    this.log.info("channel stopped");
  }

  /** Per-chat serial queue: replies must not overtake each other. */
  enqueue(chatKey, task) {
    const previous = this.chatChains.get(chatKey) ?? Promise.resolve();
    const next = previous.then(task, task);
    const guarded = next.catch(() => {});
    this.chatChains.set(chatKey, guarded);
    guarded.finally(() => {
      if (this.chatChains.get(chatKey) === guarded) this.chatChains.delete(chatKey);
    });
    return next;
  }

  async handleEvent(event) {
    const messageId = event?.message_id;
    if (!messageId) return;
    if (!this.deduper.firstTime(messageId)) {
      this.log.debug(`duplicate message dropped: ${messageId}`);
      return;
    }

    const mapped = mapMessageEvent(event, {
      accountId: this.account.accountId,
      botOpenId: this.account.botOpenId,
      allowMessageTypes: this.account.allowMessageTypes,
      agentRoute: (peer) => {
        try {
          return this.api.runtime?.channel?.routing?.resolveAgentRoute?.({
            cfg: this.api.config,
            channel: "feishu",
            accountId: this.account.accountId,
            peer,
          });
        } catch (error) {
          this.log.warn(`resolveAgentRoute failed: ${error?.message ?? error}`);
          return undefined;
        }
      },
    });

    if (!mapped.ok) {
      this.log.info(`skip message ${messageId}: ${mapped.reason}`);
      return;
    }

    const chatKey = mapped.context.ChatId ?? mapped.context.SenderId ?? messageId;
    this.enqueue(chatKey, () =>
      this.limit(() => this.dispatchInbound(mapped.context)),
    ).catch((error) => {
      this.log.error(`dispatch failed for ${messageId}: ${error?.message ?? error}`);
    });
  }

  async dispatchInbound(inboundContext) {
    const replyRuntime = this.api.runtime?.channel?.reply;
    if (!replyRuntime?.dispatchReplyFromConfig) {
      throw new Error("orange shim does not expose channel.reply.dispatchReplyFromConfig");
    }

    const startedAt = Date.now();
    this.log.info(
      `inbound chat=${inboundContext.ChatId} sender=${inboundContext.SenderId} chars=${inboundContext.Body.length}`,
    );

    // Record where this turn happened *and* what the user asked for. The
    // authorization gate needs both: a tool failing inside a hook has no chat
    // address of its own, and a resume turn without the user's own wording
    // degrades to "re-run that one command" (exactly how a brief turned into a
    // bare `calendar +agenda` dump).
    rememberTurn(this.account, inboundContext);

    // `renderMode: card` + `streaming: true` in channels.feishu opts into the
    // CardKit path: one card per turn, updated in place with the answer and the
    // reasoning panel. Everything else keeps the plain text path.
    const cardMode = (this.account.renderMode ?? "text") === "card";
    // A group message that does not @ the bot is dropped by the host
    // (`requireMention`). Starting a stream for it would leave an empty "…" card
    // in the group, so bail out before any card exists.
    const willBeSkipped =
      inboundContext.ChatType === "group" &&
      this.account.requireMention &&
      inboundContext.WasMentioned !== true;
    if (willBeSkipped) {
      this.log.info(
        `group message without mention (chat=${inboundContext.ChatId}): no card rendering, host will skip`,
      );
    }
    // 首帧在 dispatch 开始时就要发出去（见下面的 onReplyStart），这样模型迟迟不
    // 吐字、或一轮里什么都没产出时，用户也立刻看到「思考中」，而不是聊天里一片安静。
    const stream = cardMode && this.account.streaming && !willBeSkipped
      ? new StreamingReply({
          account: this.account,
          to: inboundContext.OriginatingTo,
          log: this.log,
          reasoning: this.account.reasoning,
          card: this.account.card,
          // 回复用户那条消息：飞书渲染引用块（「回复 某某：…」），也是旧插件一直
          // 以来的行为。没有 message id（合成消息/定时任务）时退回普通发送。
          replyToMessageId: inboundContext.MessageSid,
          replyInThread: this.account.replyInThread,
        })
      : null;

    // Set mid-turn by the authorization gate — from a tool's own pre-check or
    // from the generic `after_tool_call` hook, whichever fires first.
    const turnId = inboundContext.MessageSid;
    const isAuthGated = () => isTurnGated(turnId);

    const deliverText = async (text, kind) => {
      await sendTextChunked({
        cliPath: this.account.cliPath,
        configDir: this.account.configDir,
        cwd: this.account.scratchDir,
        identity: this.account.identity,
        to: inboundContext.OriginatingTo,
        text,
        timeoutMs: this.account.sendTimeoutMs,
        env: this.account.env,
        idempotencyKey: `${inboundContext.MessageSid}-${kind}`,
        // 卡片失败退回纯文本时也要挂在原消息下面，保持「回复」的视觉一致。
        replyToMessageId: inboundContext.MessageSid,
        replyInThread: this.account.replyInThread,
        log: this.log,
      });
    };

    const { dispatcher, replyOptions } = replyRuntime.createReplyDispatcherWithTyping({
      deliver: async (payload, info) => {
        const kind = info?.kind ?? "final";
        const gated = isAuthGated();
        // Waiting for authorization: nothing the model wrote may reach the chat.
        // Swapping in the one-line pointer is what turns a misleading
        // "半份简报 + 待授权" into the single sentence the adapter asks for.
        const sourceText = typeof payload?.text === "string" ? payload.text : "";
        // delta 信封是给调度器判重用的，不是给用户看的。cron 投递在 Rust 侧
        // 已经渲染（orange/src/proactive/render.rs），会话里手动跑一次走的是
        // 这里，以前会把整段 JSON 直接贴到飞书。
        const text = gated ? AUTH_WAIT_LINE : (renderDeltaForUser(sourceText) ?? sourceText);
        if (!text.trim()) return;

        if (kind === "final") {
          const ok = stream ? await stream.finish(text) : false;
          if (!ok) await deliverText(text, "final");
          return;
        }
        // 别把半个 JSON 信封刷进卡片，等 final 的统一渲染。
        if (gated || looksLikeEnvelope(sourceText)) return;
        if (stream && !stream.failed) {
          // Tool status is rendered by `onToolStart`, so block/tool payloads
          // would only duplicate text inside the card.
          if (kind === "block") stream.onAnswer(text);
          return;
        }
        await deliverText(text, kind);
      },
      onError: (error, info) => {
        this.log.error(`reply delivery (${info?.kind}) failed: ${error?.message ?? error}`);
      },
      onIdle: () => {},
      onReplyStart: async () => {},
      onCleanup: () => {},
    });

    // Streaming callbacks travel through `replyOptions`; the shim reads them
    // from there when it receives text_delta / reasoning_delta / tool_start
    // events from the host.
    const dispatchOptions = stream
      ? {
          ...replyOptions,
          // 立刻建卡并发出去（回复用户那条消息），不等第一个 token。
          onReplyStart: async () => {
            await stream.ensureStarted();
          },
          onPartialReply: (payload) => {
            // Never stream a brief that is about to be replaced by the gate,
            // and never stream a half-written JSON envelope.
            if (isAuthGated() || looksLikeEnvelope(payload?.text)) return;
            stream.onAnswer(payload?.text);
          },
          onReasoningStream: (payload) => stream.onReasoning(payload?.text),
          onReasoningEnd: () => stream.onReasoningEnd(),
          onToolStart: (payload) => stream.onToolStart(payload?.name),
          shouldEmitToolStatus: () => false,
        }
      : replyOptions;

    try {
      await replyRuntime.dispatchReplyFromConfig({
        ctx: inboundContext,
        cfg: this.api.config,
        dispatcher,
        replyOptions: dispatchOptions,
      });
    } finally {
      dispatcher.markComplete?.();
      await dispatcher.waitForIdle?.();
      if (stream) await stream.close();
      // The gate only matters for the turn that tripped it.
      clearTurnGate(turnId);
      this.log.info(`inbound done in ${Date.now() - startedAt}ms message=${inboundContext.MessageSid}`);
    }
  }

  /**
   * Push a synthetic user message into the same conversation.
   *
   * The authorization tool call has already returned by the time the device
   * flow completes, so the only way to resume the task is a new inbound turn.
   * Queueing through `enqueue` puts it behind the run that sent the card, so it
   * renders as a follow-up rather than an interleaved reply.
   */
  dispatchSyntheticUserMessage({
    text,
    chatId,
    senderId,
    messageId,
    chatType = "direct",
    agentId,
    accountId,
    threadId,
    sessionKey,
    idSuffix = ":auth-complete",
  }) {
    const isGroup = chatType === "group";
    const to = addressFor({ chatId, senderId });
    const syntheticId = `${messageId}${idSuffix}`;
    const context = {
      Provider: "feishu",
      Surface: "feishu",
      AccountId: accountId ?? this.account.accountId,
      account_id: accountId ?? this.account.accountId,
      From: `feishu:${senderId}`,
      SenderId: senderId,
      To: to,
      OriginatingTo: to,
      ChatId: chatId,
      ChatType: chatType,
      ...(isGroup ? { GroupId: chatId, GroupSubject: chatId } : {}),
      ...(threadId ? { ThreadId: threadId } : {}),
      Body: text,
      BodyForAgent: text,
      RawBody: text,
      CommandBody: text,
      MessageSid: syntheticId,
      MessageId: syntheticId,
      Synthetic: true,
      WasMentioned: true,
      ...(agentId ? { AgentId: agentId } : {}),
      // Reuse the session the interrupted turn ran in. Omitting this was why the
      // post-authorization turn had no history and produced no brief.
      ...(sessionKey ? { SessionKey: sessionKey } : {}),
      Timestamp: Date.now(),
    };

    this.log.info(`injecting synthetic inbound after authorization: message=${syntheticId}`);
    return this.enqueue(chatId ?? senderId ?? syntheticId, () =>
      this.limit(() => this.dispatchInbound(context)),
    );
  }
}

/**
 * Commands that must never be executed through the `lark_cli` tool:
 *  - long-running (would hang the tool call)
 *  - interactive (device flow / OAuth needs a browser)
 *  - self-updating (would break the version contract)
 *  - local credential writes (must go through setup-account.sh)
 */
const TOOL_BLOCKED_PREFIXES = [
  ["event", "consume"],
  ["event", "_bus"],
  ["event", "start"],
  ["auth", "login"],
  ["config", "init"],
  ["update"],
];

function isBlockedArgv(argv) {
  return TOOL_BLOCKED_PREFIXES.some((prefix) =>
    prefix.every((token, index) => argv[index] === token),
  );
}

/**
 * 按用户隔离的账号目录：`data/lark-cli/<account_id>`。
 *
 * 多用户 proactive 时，每条例程的 `origin_account_id` 就是收件人的 open_id。
 * 目录不存在时从主账号复制**应用凭证**（appId/appSecret/brand），但清空
 * `users` —— user token 必须由那个人自己点授权拿到，绝不能从别人那里继承，
 * 否则 A 的消息和日程会被当成 B 的发给 A。
 */
function ensureOwnerAccount(accountId, template) {
  const id = asString(accountId, "");
  if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) return null;
  const configDir = ensureDir(path.join(orangeHome(), "data", "lark-cli", id));
  const configPath = path.join(configDir, "config.json");
  if (!fs.existsSync(configPath)) {
    const app = readAppCredential(template?.configDir);
    if (!app) return null;
    try {
      fs.writeFileSync(configPath, JSON.stringify({ apps: [{ ...app, users: [] }] }, null, 2), {
        mode: 0o600,
      });
    } catch {
      return null;
    }
  }
  return {
    ...(template ?? {}),
    accountId: id,
    configDir,
    scratchDir: ensureDir(path.join(configDir, "workspace")),
  };
}

/** 从主账号的 config.json 里取应用凭证（不含任何 user token）。 */
function readAppCredential(configDir) {
  if (!configDir) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
    const app = Array.isArray(data?.apps) ? data.apps[0] : null;
    if (!app?.appId || !app?.appSecret) return null;
    return { appId: app.appId, appSecret: app.appSecret, brand: app.brand ?? "feishu" };
  } catch {
    return null;
  }
}

/** 读取某个 lark-cli 目录里 user token 属于谁（`apps[].users[].userOpenId`）。 */
function configUserOpenIds(configDir) {
  if (!configDir) return [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
    const ids = [];
    for (const app of Array.isArray(data?.apps) ? data.apps : []) {
      for (const user of Array.isArray(app?.users) ? app.users : []) {
        const id = normalizeOwnerId(user?.userOpenId ?? user?.openId ?? user?.open_id);
        if (id) ids.push(id);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * 按 owner open_id 解析该用户自己的 lark-cli 账号。
 *
 * 旧插件 openclaw-lark 把 UAT 按 `${appId}:${userOpenId}` 分片；本插件的
 * user token 由 lark-cli 存在 `LARKSUITE_CLI_CONFIG_DIR` 里，等价做法就是
 * 一人一个目录。
 *
 * - 配置里已声明过这个账号 → 直接用；
 * - 共享默认目录里的 token **确实属于这个人** → 复用（单人部署兼容，不逼着
 *   重新授权）；
 * - 否则就地建 `data/lark-cli/<open_id>/`，只复制应用凭证、users 留空，
 *   由这个人自己点授权。绝不把别人的 user token 借给他。
 *
 * `runtimeAccountId` 指回渠道账号：resume / 会话记忆都注册在它下面。
 */
export function resolveAccountForOwner(ownerId, accounts, { log } = {}) {
  const owner = normalizeOwnerId(ownerId);
  const template = accounts?.[0];
  if (!owner || !template) return null;

  const declared = accounts.find((entry) => entry.accountId === owner);
  if (declared) {
    return { ...declared, ownerUserId: owner, runtimeAccountId: template.accountId };
  }
  if (configUserOpenIds(template.configDir).includes(owner)) {
    return { ...template, ownerUserId: owner, runtimeAccountId: template.accountId };
  }
  const perUser = ensureOwnerAccount(owner, template);
  if (!perUser) {
    log?.warn?.(`could not prepare a per-user lark-cli account for ${owner}`);
    return null;
  }
  return { ...perUser, ownerUserId: owner, runtimeAccountId: template.accountId };
}

function createLarkCliTool({ api, getAccounts, logger, toolCtx }) {
  return {
    name: "lark_cli",
    description:
      "在本机执行飞书官方 CLI（lark-cli），参数与命令行完全一致。所有 lark-* 技能里的 " +
      "`lark-cli <子命令> ...` 都改用本工具执行：把 `<子命令>` 及参数按顺序放进 argv，" +
      "不要包含 `lark-cli` 前缀。例如 `lark-cli docs +create --title 测试文档` → " +
      '{"argv":["docs","+create","--title","测试文档"]}。' +
      "工具已自带应用凭证，无需手动传 token。`docs +create` 默认以用户身份执行（--as user），" +
      "落盘到用户自己的云空间；其它需要用户身份的命令请显式传 --as user。" +
      "若返回 awaiting_authorization=true，说明授权卡片已发给用户，本轮直接结束并请用户点授权。",
    parameters: {
      type: "object",
      properties: {
        argv: {
          type: "array",
          items: { type: "string" },
          description: "CLI 参数数组，不含 lark-cli 前缀，例如 [\"docs\",\"+fetch\",\"--token\",\"xxx\"]",
        },
        stdin: {
          type: "string",
          description: "可选：写入 CLI stdin 的内容（当命令用 `-` 表示从 stdin 读取时使用）",
        },
        account_id: {
          type: "string",
          description: "可选：多账号时指定账号 id，默认使用第一个账号",
        },
        timeout_ms: {
          type: "number",
          description: "可选：超时毫秒数，默认 120000，上限 300000",
        },
      },
      required: ["argv"],
    },
    async execute(_toolCallId, params) {
      const rawArgv = params?.argv;
      if (!Array.isArray(rawArgv) || rawArgv.length === 0) {
        return toolText("ERROR: argv 必须是非空字符串数组");
      }
      if (rawArgv.length > 64) {
        return toolText("ERROR: argv 过长（最多 64 项）");
      }
      const argv = [];
      for (const item of rawArgv) {
        if (typeof item !== "string") return toolText("ERROR: argv 里的每一项都必须是字符串");
        if (item.length > 8192) return toolText("ERROR: argv 单项过长（最多 8192 字符）");
        argv.push(item);
      }
      if (argv[0].startsWith("-")) {
        return toolText("ERROR: argv[0] 必须是子命令（如 doc / im / api），不能以 - 开头");
      }
      if (isBlockedArgv(argv)) {
        return toolText(
          `ERROR: 该命令不能通过工具执行（长驻/交互/自更新）：lark-cli ${argv.join(" ")}\n` +
            "长驻事件由插件自己管理；登录与凭证请用 scripts/setup-account.sh。",
        );
      }

      const accounts = getAccounts();
      // 这一轮属于哪个人，就用哪个人的账号目录。旧实现靠
      // `routineAccountFor(toolCtx).origin_account_id` 决定，但台账里这个字段
      // 为空（单人 direct_owners），于是所有用户都落到 accounts[0] 的共享
      // work 目录 —— 里面是别人的 user token，A 的操作因此会写到 B 头上。
      // 现在直接从入站身份 / 投递目标 / cron 例程 owner 取 open_id。
      const ownerId = ownerIdFromToolCtx(toolCtx);
      const explicitId = asString(params?.account_id, "");
      let account = explicitId
        ? accounts.find((entry) => entry.accountId === explicitId) ??
          resolveAccountForOwner(explicitId, accounts, { log: logger })
        : ownerId
          ? resolveAccountForOwner(ownerId, accounts, { log: logger })
          : null;
      if (!account) {
        // 只有纯 bot 身份调用（发消息等）才允许用共享账号；任何 `--as user`
        // 都 fail-close，绝不借用别人的授权去读他的消息和日程。
        if (argvWantsUserIdentity(argv) || wantsUserIdentityByDefault(argv)) {
          return toolText(
            "ERROR: 无法确定当前用户身份，或无法准备该用户独立的飞书账号目录。" +
              "为避免借用其他用户的 user token，本次调用已拒绝；请在飞书私聊中重试。",
          );
        }
        account = accounts[0];
      }
      if (!account) return toolText("ERROR: 没有配置飞书账号");

      const timeoutRaw = Number(params?.timeout_ms);
      const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.min(Math.max(timeoutRaw, 1_000), 300_000)
        : 120_000;

      const log = logger.child(account.accountId);

      // Creating a doc is "my document", not "the bot's document": default to
      // the caller's identity unless the model made the choice explicitly.
      const effectiveArgv = [...argv];
      if (wantsUserIdentityByDefault(effectiveArgv) && !argvHasExplicitIdentity(effectiveArgv)) {
        effectiveArgv.push("--as", "user");
        log.info("tool exec: defaulted docs +create to --as user");
      }
      log.info(
        `tool exec: lark-cli ${effectiveArgv.slice(0, 3).join(" ")}${effectiveArgv.length > 3 ? " …" : ""}`,
      );

      if (argvWantsUserIdentity(effectiveArgv)) {
        const gate = await ensureUserAuthorized({ account, argv: effectiveArgv, toolCtx, log });
        if (gate) {
          return toolText(JSON.stringify(gate, null, 2), {
            ok: false,
            awaiting_authorization: true,
            argv: effectiveArgv,
          });
        }
      }

      try {
        const result = await runCli({
          cliPath: account.cliPath,
          configDir: account.configDir,
          cwd: account.scratchDir,
          args: effectiveArgv,
          stdinText: typeof params?.stdin === "string" ? params.stdin : undefined,
          timeoutMs,
          env: account.env,
          log,
        });
        const payload = result.envelope ?? { ok: true, data: result.data };
        return toolText(truncate(JSON.stringify(payload, null, 2), 40_000), {
          ok: true,
          argv: effectiveArgv,
        });
      } catch (error) {
        const detail = [
          `CLI_ERROR ${error?.message ?? error}`,
          error?.stderr ? `stderr: ${error.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        log.warn(`tool exec failed: ${error?.message ?? error}`);

        // `auth status` can still report a usable user token while the server
        // rejects it (expired, or missing a scope this command needs), so the
        // gate above cannot catch either case. React to the real failure instead
        // of handing the model an opaque 99991677 / scope list.
        const needsUserIdentity = argvWantsUserIdentity(effectiveArgv);
        const tokenFailure = needsUserIdentity && isUserTokenFailure(error);
        const scopeFailure = needsUserIdentity && !tokenFailure && isScopeFailure(error);
        if (tokenFailure || scopeFailure) {
          log.warn(
            tokenFailure
              ? "user token rejected by server, starting re-authorization"
              : "user token lacks required scope, sending an incremental authorization card",
          );
          try {
            // The cached status just proved wrong (the server rejected the
            // call), so drop it before the gate re-reads with `--verify`.
            invalidateAuthStatus(account);
            const gate = await ensureUserAuthorized({
              account,
              argv: effectiveArgv,
              toolCtx,
              log,
              force: true,
              trigger: scopeFailure ? "scope" : "token",
              missingScopes: error?.error?.missing_scopes ?? null,
            });
            // already_authorized：验证过的 token 已覆盖所需 scope，这次失败不是
            // 授权问题。别把它包装成 awaiting_authorization，否则模型会请用户去
            // 点一张根本不存在的授权卡片。
            if (gate && !gate.already_authorized) {
              const trigger = scopeFailure ? "missing_scope" : "token_expired";
              return toolText(JSON.stringify({ ...gate, trigger }, null, 2), {
                ok: false,
                awaiting_authorization: true,
                trigger,
                argv: effectiveArgv,
              });
            }
          } catch (gateError) {
            log.error(`re-authorization could not start: ${gateError?.message ?? gateError}`);
          }
        }

        return toolText(truncate(detail, 8_000), {
          ok: false,
          type: error?.error?.type,
          subtype: error?.error?.subtype,
          code: error?.code,
        });
      }
    },
  };
}

function truncate(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\n…(truncated ${value.length - limit} chars)` : value;
}

function toolText(text, details) {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

export function createChannelPlugin({ api, pluginConfig, logger, resolveAccounts = null }) {
  const runtimes = new Map();

  // `api.pluginConfig` is only populated after plugin/init, which happens
  // *after* register(). Resolve accounts lazily on first use (channel/connect)
  // instead of capturing them at register time.
  let cachedAccounts = null;
  const getAccounts =
    resolveAccounts ??
    (() => {
      if (!cachedAccounts) {
        const merged = { ...(pluginConfig ?? {}), ...(api.pluginConfig ?? {}) };
        cachedAccounts = normalizeAccounts(
          merged,
          accountsFromChannelConfig(api),
          api?.config?.channels?.feishu ?? {},
          { log: logger },
        );
        logger.info(
          `resolved accounts: ${cachedAccounts
            .map((account) => `${account.accountId}(cli=${account.cliPath}, proxy=${describeProxy(account.proxy)})`)
            .join(", ")}`,
        );
      }
      return cachedAccounts;
    });

  return {
    id: "feishu",
    meta: { id: "feishu", label: "Feishu (lark-cli)" },
    capabilities: {
      direct: true,
      group: false, // P0: private chat only
      media: false,
      reactions: false,
      threads: false,
      nativeCommands: false,
      blockStreaming: false,
    },
    setup: {
      resolveAccounts() {
        return getAccounts().map((account) => ({ ...account }));
      },
    },
    config: {
      listAccountIds() {
        return getAccounts().map((account) => account.accountId);
      },
      resolveAccount(_cfg, accountId) {
        const found = getAccounts().find((account) => account.accountId === accountId);
        return found ? { ...found } : undefined;
      },
    },
    gateway: {
      async startAccount(ctx) {
        const accounts = getAccounts();
        const accountId = asString(ctx?.accountId, "default");
        const account = accounts.find((entry) => entry.accountId === accountId) ?? accounts[0];
        if (!account) {
          logger.error(`no accounts configured for plugin orange-lark-cli (account=${accountId})`);
          return;
        }
        const log = logger.child(account.accountId);
        log.info(
          `starting account (cli=${account.cliPath} config_dir=${account.configDir} render=${account.renderMode} streaming=${account.streaming} reasoning=${account.reasoning?.enabled === true})`,
        );

        const runtime = new AccountRuntime({ account, api, logger: log });
        runtimes.set(account.accountId, runtime);
        // Registered outside this closure: the authorization gate (including the
        // generic after_tool_call hook) has to resume *this* conversation after
        // the user authorizes, and it does not have access to `runtimes`.
        registerRuntime(account.accountId, runtime);
        ctx?.abortSignal?.addEventListener?.("abort", () => {
          unregisterRuntime(account.accountId);
          void runtime.stop();
        });

        await runtime.start();
      },
    },
    outbound: {
      async sendText(params) {
        const accounts = getAccounts();
        const accountId = asString(params?.accountId, accounts[0]?.accountId);
        const account = accounts.find((entry) => entry.accountId === accountId) ?? accounts[0];
        if (!account) throw new Error("orange-lark-cli: no account configured");
        const log = logger.child(account.accountId);

        // 多来源简报：Rust 侧把原始 delta 信封放进 blocks 带过来，用它构造
        // Card 2.0（原生表格）。卡片发不出去就退回渲染好的人话；绝不能让
        // 结构化的 blocks 落到下面的 sendPost 变成乱码。
        const brief = params?.blocks?.orange_brief_card;
        if (brief && typeof brief === "object" && brief.envelope) {
          const card = buildBriefCard(brief.envelope);
          if (card) {
            try {
              const { messageId } = await sendCard({
                cliPath: account.cliPath,
                configDir: account.configDir,
                cwd: account.scratchDir,
                identity: account.identity,
                to: params?.to,
                card,
                timeoutMs: account.sendTimeoutMs,
                env: account.env,
                log,
              });
              return { messageId };
            } catch (error) {
              log.warn(`brief card failed, falling back to text: ${error?.message ?? error}`);
            }
          }
          const fallback =
            String(brief.fallback_text ?? "").trim() ||
            String(params?.text ?? "").trim() ||
            renderDeltaForUser(String(brief.envelope ?? "")) ||
            "";
          if (fallback) {
            const ids = await sendTextChunked({
              cliPath: account.cliPath,
              configDir: account.configDir,
              cwd: account.scratchDir,
              identity: account.identity,
              to: params?.to,
              text: fallback,
              timeoutMs: account.sendTimeoutMs,
              env: account.env,
              log,
            });
            return { messageId: ids[0] };
          }
        }

        // Orange's admin notifications carry a Feishu post in `blocks` and an
        // empty `text` (the old plugin rendered the post). Ignoring `blocks`
        // made the CLI send an empty bubble, which Feishu accepted — so the
        // console said "sent" while the group stayed silent.
        if (params?.blocks) {
          try {
            const { messageId } = await sendPost({
              cliPath: account.cliPath,
              configDir: account.configDir,
              cwd: account.scratchDir,
              identity: account.identity,
              to: params?.to,
              content: params.blocks,
              timeoutMs: account.sendTimeoutMs,
              env: account.env,
              log,
            });
            return { messageId };
          } catch (error) {
            log.warn(`post send failed, falling back to text: ${error?.message ?? error}`);
          }
        }

        // cron / proactive 的 channel/send 会把 agent 的 delta 信封原样递过来 ——
        // 那是投递前的机器契约。Rust 侧的 render.rs 对空态（status=summary）
        // 不生效，所以这里再兜一层，否则用户收到的是整段 JSON。
        const rawText =
          (typeof params?.text === "string" ? params.text : "").trim() ||
          blocksToPlainText(params?.blocks);
        const text = renderDeltaForUser(rawText) ?? rawText;
        if (!text) {
          throw new Error("orange-lark-cli: refusing to send an empty message");
        }
        const ids = await sendTextChunked({
          cliPath: account.cliPath,
          configDir: account.configDir,
          cwd: account.scratchDir,
          identity: account.identity,
          to: params?.to,
          text,
          timeoutMs: account.sendTimeoutMs,
          env: account.env,
          log,
        });
        return { messageId: ids[0] };
      },
    },
  };
}

export default {
  id: "orange-lark-cli",
  name: "Orange Lark CLI Channel",
  description: "Feishu channel for Orange backed by the official larksuite/cli binary",
  configSchema: { type: "object", additionalProperties: true },
  register(api) {
    const pluginConfig = api.pluginConfig ?? {};
    const sink = (level, message) => {
      const fn = api.logger?.[level] ?? api.logger?.info;
      if (typeof fn === "function") fn.call(api.logger, message);
      else process.stderr.write(`${message}\n`);
    };
    const logger = createLogger(sink);

    // Shared, lazily-resolved account list used by both the channel and the
    // lark_cli tool. api.pluginConfig is empty until plugin/init.
    let cachedAccounts = null;
    const getAccounts = () => {
      if (!cachedAccounts) {
        const merged = { ...(pluginConfig ?? {}), ...(api.pluginConfig ?? {}) };
        cachedAccounts = normalizeAccounts(
          merged,
          accountsFromChannelConfig(api),
          api?.config?.channels?.feishu ?? {},
          { log: logger },
        );
        logger.info(
          `resolved accounts: ${cachedAccounts
            .map((account) => `${account.accountId}(cli=${account.cliPath}, proxy=${describeProxy(account.proxy)})`)
            .join(", ")}`,
        );
      }
      return cachedAccounts;
    };

    // 所有需要「以用户本人身份」的路径都经过这里：lark_cli、通讯录工具、
    // 网关凭据注入器、以及 after_tool_call 授权钩子。
    const resolveOwnerAccount = (ownerId) =>
      resolveAccountForOwner(ownerId, getAccounts(), { log: logger });

    const plugin = createChannelPlugin({ api, pluginConfig, logger, resolveAccounts: getAccounts });
    api.registerChannel({ plugin });
    // Factory form: the shim materialises the tool per call and hands over the
    // inbound/delivery context, which is how the tool knows where to post the
    // authorization card and which conversation to resume.
    api.registerTool((toolCtx) => createLarkCliTool({ api, getAccounts, logger, toolCtx }));
    // Same factory form: the confirmation card needs the current chat address,
    // poster identity and session key to resume after the user submits.
    api.registerTool((toolCtx) =>
      createAskUserQuestionTool({
        getAccounts,
        logger,
        toolCtx,
        resolveChat: resolveToolChat,
        addressFor,
      }),
    );
    // Contact lookup for oa-workflow (姓名 -> 邮箱). Same auth gate as lark_cli:
    // a never-granted contact scope has to produce a device-flow card, not a
    // raw missing_scope string.
    const buildUserTools = (toolCtx) =>
      createUserTools({
        getAccounts,
        logger,
        toolCtx,
        ensureUserAuthorized,
        runCli,
        isScopeFailure,
        invalidateAuthStatus,
        resolveOwnerAccount: () => {
          const ownerId = ownerIdFromToolCtx(toolCtx);
          return ownerId ? resolveOwnerAccount(ownerId) : null;
        },
      });
    api.registerTool((toolCtx) => buildUserTools(toolCtx).search);
    api.registerTool((toolCtx) => buildUserTools(toolCtx).getUser);

    // Injects the gateway token into http_get / http_post for skills that call
    // the internal API gateway (oa-workflow, knowledge-base proxies). It no
    // longer owns the authorization flow: a missing contact scope is reported as
    // `FEISHU_AUTH_REQUIRED …` and handled by the shared gate below.
    registerHttpTokenInjector({
      api,
      getAccounts,
      runCli,
      logger,
      isScopeFailure,
      resolveOwnerAccount,
    });

    // The generic safety net: ANY tool — ours, a built-in, another plugin's —
    // that comes back with a Feishu authorization error gets the same treatment
    // (card in the current chat, turn muted, resume after the user authorizes).
    // Without this, every new tool has to re-implement the gate or silently
    // degrade to handing the model a raw scope list.
    // 授权门（含 after_tool_call 钩子）拿不到 toolCtx，靠它把「人」翻译成
    // 该人自己的 lark-cli 账号目录。
    setOwnerAccountResolver(resolveOwnerAccount);
    registerAuthHooks({ api, getAccounts, logger });

    // 企业环境的宿主机常在进程级设了 HTTP_PROXY；插件自己的本地调用（gateway
    // `/api/v1/cron/...`、token service）不能被带走，所以启动时补一次 NO_PROXY。
    ensureLoopbackBypass();

    // Accounts are resolved later, once plugin/init has delivered the config.
    logger.info(
      "registered channel feishu + lark_cli + feishu_ask_user_question + feishu_search_user + feishu_get_user tools + after_tool_call auth gate",
    );
  },
};
