/**
 * Long-lived `lark-cli event consume <EventKey>` supervisor.
 *
 * Verified behaviours this module depends on (lark-cli 0.1.x, 2026-10 build):
 *   - ready marker on stderr:  `[event] ready event_key=<key>`
 *   - one JSON object per line on stdout (NDJSON), diagnostics on stderr
 *   - non-TTY consumers treat stdin EOF as a graceful shutdown signal
 *   - the first consumer forks a per-app bus daemon that owns the WebSocket;
 *     extra consumers attach over a local unix socket
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import { redact, tail } from "./log.mjs";

const READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const STDERR_RING = 40;

function parseEnvelope(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class EventConsumer {
  constructor(options) {
    this.cliPath = options.cliPath;
    this.configDir = options.configDir;
    this.cwd = options.cwd;
    this.eventKey = options.eventKey ?? "im.message.receive_v1";
    this.identity = options.identity ?? "bot";
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.log = options.log;
    this.onEvent = options.onEvent ?? (() => {});
    this.onFatal = options.onFatal ?? (() => {});
    this.env = options.env ?? {};

    this.child = null;
    this.stopping = false;
    this.ready = false;
    this.everReady = false;
    this.stderrLines = [];
    this.stderrBuf = "";
    this.exitInfo = null;
  }

  get pid() {
    return this.child?.pid;
  }

  argv() {
    return ["event", "consume", this.eventKey, "--as", this.identity];
  }

  async start() {
    const args = this.argv();
    const env = {
      ...process.env,
      ...(this.configDir ? { LARKSUITE_CLI_CONFIG_DIR: this.configDir } : {}),
      ...this.env,
    };
    delete env.OPENCLAW_HOME;
    delete env.HERMES_HOME;

    const child = spawn(this.cliPath, args, {
      cwd: this.cwd || undefined,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.log?.info(`spawned consumer pid=${child.pid} event=${this.eventKey}`);

    const readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`consumer not ready after ${this.readyTimeoutMs}ms (event=${this.eventKey})`));
      }, this.readyTimeoutMs);

      const settle = (fn, arg) => {
        clearTimeout(timer);
        fn(arg);
      };

      child.once("error", (error) => {
        settle(reject, new Error(`consumer spawn error: ${redact(error?.message ?? error)}`));
      });

      child.once("close", (code, signal) => {
        this.ready = false;
        this.exitInfo = { code, signal, stderr: this.stderrTail() };
        if (!this.ready) {
          settle(
            reject,
            new Error(
              `consumer exited before ready (code=${code}${signal ? `, signal=${signal}` : ""}) ${this.stderrTail()}`,
            ),
          );
        }
      });

      const rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      rlErr.on("line", (line) => {
        this.stderrLines.push(line);
        if (this.stderrLines.length > STDERR_RING) this.stderrLines.shift();
        if (this.stderrBuf.length < 64 * 1024) this.stderrBuf += `${line}\n`;
        if (line.includes("[event] ready") && !this.ready) {
          this.ready = true;
          this.everReady = true;
          this.log?.info(`consumer ready: ${line.trim()}`);
          settle(resolve, true);
          return;
        }
        // Keep diagnostics visible but out of the way.
        this.log?.debug(`consumer stderr: ${line.trim()}`);
      });
    });

    // stdout: one JSON object per line.
    const rlOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rlOut.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        this.log?.warn(`dropping non-JSON event line: ${tail(redact(trimmed), 200)}`);
        return;
      }
      Promise.resolve()
        .then(() => this.onEvent(payload))
        .catch((error) => {
          this.log?.error(`event handler failed: ${redact(error?.stack ?? error)}`);
        });
    });

    // Only report a crash after the consumer was up; startup failures surface
    // through start().
    const startedPid = child.pid;
    child.on("close", (code, signal) => {
      this.ready = false;
      if (this.stopping) {
        this.log?.info(`consumer stopped pid=${startedPid} code=${code}`);
        return;
      }
      // Startup failures are already reported by start(); only crashes of a
      // consumer that had reached ready are worth a second log line.
      if (!this.everReady) return;
      this.log?.error(
        `consumer exited unexpectedly pid=${startedPid} code=${code}${signal ? ` signal=${signal}` : ""} ${this.stderrTail()}`,
      );
      this.onFatal(this.exitInfo);
    });

    await readyPromise;
    return this;
  }

  /**
   * lark-cli prints its error envelope as *pretty* JSON across several lines,
   * so a line-based tail is unreadable. Prefer a compact one-liner when the
   * buffer parses as an envelope, fall back to the last few raw lines.
   */
  stderrTail() {
    if (!this.stderrBuf.trim() && this.stderrLines.length === 0) return "";
    const envelope = parseEnvelope(this.stderrBuf);
    if (envelope?.error) {
      const { type, subtype, message, hint } = envelope.error;
      const tag = type || subtype ? `[${type ?? "?"}/${subtype ?? "?"}]` : "";
      return ["cli_error=" + tag, message, hint ? `hint: ${hint}` : ""].filter(Boolean).join(" ");
    }
    if (this.stderrLines.length === 0) return "";
    return `stderr_tail=${JSON.stringify(this.stderrLines.slice(-6))}`;
  }

  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    this.log?.info(`stopping consumer pid=${child.pid}`);

    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }

    const exited = await Promise.race([
      new Promise((resolve) => child.once("close", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS)),
    ]);
    if (exited) return;

    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const terminated = await Promise.race([
      new Promise((resolve) => child.once("close", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (terminated) return;

    this.log?.warn(`consumer pid=${child.pid} ignored SIGTERM, sending SIGKILL`);
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
