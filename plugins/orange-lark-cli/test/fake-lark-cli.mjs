#!/usr/bin/env node
/**
 * Test double for the real lark-cli.
 *
 * Implements only the two surfaces the plugin uses, with the same observable
 * contract (stderr ready marker, NDJSON on stdout, JSON envelope, exit codes).
 *
 * Env:
 *   FAKE_LARK_EVENTS        path to a .jsonl file of canned events
 *   FAKE_LARK_SEND_LOG      path to append sent-message records
 *   FAKE_LARK_EMIT_DELAY_MS delay before the first event (default 1200)
 */

import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const sendLog = process.env.FAKE_LARK_SEND_LOG || "/tmp/fake-lark-send.log";
const eventsFile = process.env.FAKE_LARK_EVENTS || "";
const firstDelay = Number(process.env.FAKE_LARK_EMIT_DELAY_MS || 1200);

function envelope(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function recordSend(entry) {
  try {
    fs.appendFileSync(sendLog, `${JSON.stringify(entry)}\n`);
  } catch {
    /* ignore */
  }
}

function flagValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  if (argv[0] === "--version") {
    process.stdout.write("lark-cli version fake-0.1.0\n");
    return;
  }

  if (argv[0] === "event" && argv[1] === "consume") {
    const eventKey = argv[2] || "im.message.receive_v1";
    process.stderr.write(`[event] started bus daemon pid=${process.pid} (auto-exits 30s after last consumer)\n`);

    let lines = [];
    if (eventsFile && fs.existsSync(eventsFile)) {
      lines = fs
        .readFileSync(eventsFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    }

    process.stderr.write(`[event] ready event_key=${eventKey}\n`);

    let index = 0;
    const timer = setInterval(() => {
      if (index >= lines.length) {
        clearInterval(timer);
        return;
      }
      process.stdout.write(`${lines[index]}\n`);
      index += 1;
    }, 1000);
    timer.unref?.();

    // Stay alive until the parent closes stdin (graceful shutdown contract).
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("close", () => {
      process.stderr.write("[event] shutting down (stdin closed)\n");
      process.exit(0);
    });
    return;
  }

  // Reply path: the card must be attached to the user's message so Feishu renders
  // the quote block ("回复 某某：...") like the previous plugin did.
  if (argv[0] === "im" && argv[1] === "+messages-reply") {
    const body = await readStdin();
    const messageId = `om_fake_reply_${Date.now().toString(36)}`;
    recordSend({
      at: new Date().toISOString(),
      kind: "reply",
      argv,
      reply_to: flagValue("--message-id"),
      reply_in_thread: argv.includes("--reply-in-thread"),
      as: flagValue("--as"),
      msg_type: flagValue("--msg-type"),
      body,
    });
    envelope({ ok: true, data: { message_id: messageId } });
    return;
  }

  if (argv[0] === "im" && argv[1] === "+messages-send") {
    const text = await readStdin();
    const chatId = flagValue("--chat-id");
    const userId = flagValue("--user-id");
    const messageId = `om_fake_${Date.now().toString(36)}`;
    recordSend({
      at: new Date().toISOString(),
      argv,
      chat_id: chatId,
      user_id: userId,
      as: flagValue("--as"),
      idempotency_key: flagValue("--idempotency-key"),
      text,
      message_id: messageId,
    });
    envelope({
      ok: true,
      identity: flagValue("--as") || "bot",
      data: { message_id: messageId, chat_id: chatId ?? null, user_id: userId ?? null, create_time: Date.now() },
    });
    return;
  }

  // ── auth surface (authorization gate tests) ────────────────────────────
  // FAKE_LARK_USER_READY=1 makes the stored user token look usable; the default
  // is "not authorized", which is what the gate must react to.
  if (argv[0] === "auth" && argv[1] === "status") {
    const ready = process.env.FAKE_LARK_USER_READY === "1";
    envelope({
      ok: true,
      appId: process.env.FAKE_LARK_APP_ID || "cli_fake",
      identities: {
        bot: { available: true, status: "ready" },
        user: {
          available: ready,
          status: ready ? "ready" : "missing",
          verified: ready,
          scope: process.env.FAKE_LARK_GRANTED_SCOPES || "docs:document:write drive:drive",
        },
      },
    });
    return;
  }

  if (argv[0] === "auth" && argv[1] === "scopes") {
    const scopes = (process.env.FAKE_LARK_USER_SCOPES ||
      "docs:document:write,drive:drive,contact:user.base:readonly")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    envelope({ ok: true, data: { userScopes: scopes } });
    return;
  }

  if (argv[0] === "auth" && argv[1] === "login") {
    const code = flagValue("--device-code");
    if (code) {
      recordSend({ at: new Date().toISOString(), kind: "device_poll", device_code: code, argv });
      envelope({ ok: true, data: { device_code: code, authorized: true } });
      return;
    }
    if (argv.includes("--no-wait")) {
      recordSend({ at: new Date().toISOString(), kind: "device_flow", argv });
      envelope({
        ok: true,
        data: {
          device_code: "dc_fake",
          verification_url: "https://example.invalid/verify?code=dc_fake",
          expires_in: 600,
        },
      });
      return;
    }
    envelope(
      {
        ok: false,
        error: { type: "validation", subtype: "unsupported_command", message: "auth login needs --no-wait" },
      },
      2,
    );
    return;
  }

  // ── raw api surface (CardKit authorization card) ───────────────────────
  if (argv[0] === "api") {
    const method = argv[1];
    const apiPath = argv[2] || "";
    await readStdin();
    if (method === "POST" && apiPath === "/open-apis/cardkit/v1/cards") {
      const cardId = `card_fake_${Date.now().toString(36)}`;
      recordSend({ at: new Date().toISOString(), kind: "cardkit_create", card_id: cardId });
      envelope({ ok: true, data: { card_id: cardId } });
      return;
    }
    if (method === "PUT" || method === "PATCH") {
      recordSend({ at: new Date().toISOString(), kind: "cardkit_update", path: apiPath });
      envelope({ ok: true, data: {} });
      return;
    }
    envelope(
      {
        ok: false,
        error: { type: "validation", subtype: "unsupported_command", message: `fake api ${method} ${apiPath}` },
      },
      2,
    );
    return;
  }

  envelope(
    {
      ok: false,
      error: {
        type: "validation",
        subtype: "unsupported_command",
        message: `fake-lark-cli does not implement: ${argv.join(" ")}`,
      },
    },
    2,
  );
}

main().catch((error) => {
  envelope(
    { ok: false, error: { type: "internal", subtype: "fake_crash", message: String(error?.stack ?? error) } },
    5,
  );
});
