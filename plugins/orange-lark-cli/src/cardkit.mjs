/**
 * CardKit entity helpers (create / update / settings).
 *
 * A CardKit card is created once, sent as `{"type":"card","data":{"card_id"}}`,
 * and then updated in place. That is what makes both the streaming answer and
 * the authorization card look "alive" instead of posting a new message per
 * chunk.
 *
 * Verified against lark-cli (2026-10):
 *   POST   /open-apis/cardkit/v1/cards              {type:"card_json", data}
 *   PUT    /open-apis/cardkit/v1/cards/{id}         {card:{type,data}, sequence}
 *   PATCH  /open-apis/cardkit/v1/cards/{id}/settings {settings:"{...}", sequence}
 * Note the full card update is PUT; PATCH on the card itself 404s.
 */

import { runCli } from "./cli.mjs";

function cardArgs(account, method, path) {
  return ["api", method, path, "--as", "bot", "--data", "-", "--format", "json"];
}

/**
 * HTTP 200 / exit 0 不等于 CardKit 成功：业务错误放在响应体 `code` 里
 * （230020 限流、230099 表格超限、sequence number compare failed 等）。
 * 旧插件 openclaw-lark/src/card/cardkit.ts 对四个 API 都做 fail-fast；
 * 少了这层就会把「假成功」当成已落地，继续推进 sequence、丢掉终帧。
 */
function assertCardKitOk(result, api) {
  const body = result?.envelope?.data ?? result?.data ?? {};
  const code = body?.code ?? result?.envelope?.code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(`cardkit ${api} failed: code=${code} msg=${body?.msg ?? ""}`);
  }
}

export async function createCard(account, card, { log, timeoutMs = 20_000 } = {}) {
  const result = await runCli({
    cliPath: account.cliPath,
    configDir: account.configDir,
    cwd: account.scratchDir,
    args: cardArgs(account, "POST", "/open-apis/cardkit/v1/cards"),
    stdinText: JSON.stringify({ type: "card_json", data: JSON.stringify(card) }),
    timeoutMs,
    env: account.env,
    log,
  });
  assertCardKitOk(result, "create");
  const data = result.data ?? {};
  const cardId = data.card_id ?? data?.data?.card_id;
  if (!cardId) throw new Error("cardkit create returned no card_id");
  return cardId;
}

export async function updateCard(account, cardId, card, sequence, { log, timeoutMs = 20_000 } = {}) {
  const result = await runCli({
    cliPath: account.cliPath,
    configDir: account.configDir,
    cwd: account.scratchDir,
    args: cardArgs(account, "PUT", `/open-apis/cardkit/v1/cards/${cardId}`),
    stdinText: JSON.stringify({
      card: { type: "card_json", data: JSON.stringify(card) },
      sequence,
    }),
    timeoutMs,
    env: account.env,
    log,
  });
  assertCardKitOk(result, "update");
}

/**
 * Close `streaming_mode`. Opening is done by the card JSON at creation time —
 * matching the old openclaw-lark plugin, which never issues a PATCH(true) and
 * therefore has no PATCH/PUT sequence race. Closing is the only settings call.
 */
export async function updateCardSettings(account, cardId, settings, sequence, { log } = {}) {
  const result = await runCli({
    cliPath: account.cliPath,
    configDir: account.configDir,
    cwd: account.scratchDir,
    args: cardArgs(account, "PATCH", `/open-apis/cardkit/v1/cards/${cardId}/settings`),
    stdinText: JSON.stringify({ settings: JSON.stringify(settings), sequence }),
    timeoutMs: 15_000,
    env: account.env,
    log,
  });
  assertCardKitOk(result, "settings");
}
