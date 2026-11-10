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
  const data = result.data ?? {};
  const cardId = data.card_id ?? data?.data?.card_id;
  if (!cardId) throw new Error("cardkit create returned no card_id");
  return cardId;
}

export async function updateCard(account, cardId, card, sequence, { log, timeoutMs = 20_000 } = {}) {
  await runCli({
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
}

/**
 * Toggle `streaming_mode`. Turned on for the first frame so Feishu animates the
 * card instead of showing "card updated" hints, and off at the end so the
 * finish state is stable.
 */
export async function updateCardSettings(account, cardId, settings, sequence, { log } = {}) {
  await runCli({
    cliPath: account.cliPath,
    configDir: account.configDir,
    cwd: account.scratchDir,
    args: cardArgs(account, "PATCH", `/open-apis/cardkit/v1/cards/${cardId}/settings`),
    stdinText: JSON.stringify({ settings: JSON.stringify(settings), sequence }),
    timeoutMs: 15_000,
    env: account.env,
    log,
  });
}
