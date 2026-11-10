#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible chat completions endpoint used to validate the
 * Orange agent round trip without any external LLM dependency.
 *
 *   POST /v1/chat/completions   (stream and non-stream)
 *   GET  /v1/models
 *
 * The reply is deterministic so the e2e assertion can look for `MOCK_REPLY`.
 */

import http from "node:http";

const port = Number(process.env.MOCK_LLM_PORT || 18080);
const host = process.env.MOCK_LLM_HOST || "127.0.0.1";

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return flattenContent(messages[index].content);
  }
  return "";
}

const PREFIX = process.env.MOCK_LLM_PREFIX ?? "MOCK_REPLY: ";
const VERBATIM = process.env.MOCK_LLM_VERBATIM === "1";

function buildReply(userText) {
  if (VERBATIM) return String(userText ?? "");
  const trimmed = String(userText || "").trim().replace(/\s+/g, " ").slice(0, 160);
  return `${PREFIX}${trimmed || "(empty)"}`;
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-chat", object: "model" }] }));
    return;
  }

  if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* keep empty */
    }
    const reply = buildReply(lastUserText(body));
    const model = body.model || "mock-chat";
    const id = `chatcmpl-mock-${Date.now()}`;
    console.log(
      `[mock-llm] ${req.method} ${req.url} stream=${Boolean(body.stream)} model=${model} user=${JSON.stringify(
        lastUserText(body).slice(0, 80),
      )}`,
    );

    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
    sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

    const parts = reply.match(/.{1,24}/gs) ?? [reply];
    let delay = 0;
    for (const part of parts) {
      delay += 30;
      setTimeout(() => {
        sse(res, { ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
      }, delay);
    }
    setTimeout(() => {
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      sse(res, {
        ...base,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    }, delay + 40);
  });
});

server.listen(port, host, () => {
  console.log(`[mock-llm] listening on http://${host}:${port}/v1`);
});
