/**
 * lark-cli process adapter.
 *
 * One function, one job: run the CLI with argv (never a shell string), feed
 * optional stdin, enforce a timeout, and turn the output into either an
 * envelope object or a structured error.
 *
 * Output contract (verified against lark-cli 2026-10 build):
 *   success -> stdout `{ ok: true, identity, data: {...} }`
 *   failure -> stdout/stderr `{ ok: false, error: { type, subtype, message, hint } }`
 *              plus a non-zero exit code
 * The envelope may be pretty-printed, so we parse the whole buffer rather than
 * line by line.
 */

import { spawn } from "node:child_process";
import { redact, tail } from "./log.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 2 * 1024 * 1024;

export class CliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CliError";
    Object.assign(this, details);
  }
}

function parseJsonLoose(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function killTree(child, signal) {
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

/**
 * Run lark-cli.
 *
 * @param {object} options
 * @param {string} options.cliPath        absolute path (or PATH name) of lark-cli
 * @param {string} [options.configDir]    value for LARKSUITE_CLI_CONFIG_DIR
 * @param {string} [options.cwd]          working dir (lark-cli restricts @file paths to it)
 * @param {string[]} options.args         argv, no shell
 * @param {string} [options.stdinText]    content written to stdin before closing
 * @param {number} [options.timeoutMs]
 * @param {Record<string,string>} [options.env]
 * @param {object} [options.log]
 */
export function runCli(options) {
  const {
    cliPath,
    configDir,
    cwd,
    args,
    stdinText,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = {},
    log,
  } = options;

  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      ...(configDir ? { LARKSUITE_CLI_CONFIG_DIR: configDir } : {}),
      ...env,
    };
    // These two make `lark-cli config init` refuse to run; they are not needed
    // for event/send paths but must never leak into the child from an agent
    // workspace.
    delete childEnv.OPENCLAW_HOME;
    delete childEnv.HERMES_HOME;

    let child;
    try {
      child = spawn(cliPath, args, {
        cwd: cwd || undefined,
        env: childEnv,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new CliError(`failed to spawn lark-cli: ${error?.message ?? error}`, { cause: error }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 2_000).unref?.();
    }, timeoutMs);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(() =>
        reject(
          new CliError(`lark-cli spawn error: ${redact(error?.message ?? error)}`, {
            cause: error,
            args,
          }),
        ),
      );
    });

    child.on("close", (code, signal) => {
      finish(() => {
        const envelope = parseJsonLoose(stdout) ?? parseJsonLoose(stderr);
        const ok = !timedOut && code === 0 && envelope?.ok !== false;

        if (ok) {
          resolve({
            ok: true,
            code,
            envelope,
            data: envelope?.data ?? envelope,
            stdout,
            stderr,
          });
          return;
        }

        const errObj = envelope?.error ?? {};
        const parts = [
          `lark-cli ${args.slice(0, 2).join(" ")} failed`,
          timedOut ? `(timeout after ${timeoutMs}ms)` : `(exit=${code}${signal ? `, signal=${signal}` : ""})`,
        ];
        if (errObj.type || errObj.subtype) parts.push(`[${errObj.type ?? "?"}/${errObj.subtype ?? "?"}]`);
        if (errObj.message) parts.push(String(errObj.message));
        if (errObj.hint) parts.push(`hint: ${errObj.hint}`);
        if (!errObj.message && stderr.trim()) parts.push(`stderr: ${tail(redact(stderr))}`);

        reject(
          new CliError(parts.join(" "), {
            code,
            signal,
            timedOut,
            args,
            envelope,
            error: errObj,
            stderr: tail(redact(stderr)),
          }),
        );
      });
    });

    if (child.stdin) {
      child.stdin.on("error", () => {
        /* EPIPE when the child exits early; handled by close */
      });
      if (typeof stdinText === "string") {
        child.stdin.write(stdinText);
      }
      child.stdin.end();
    }

    log?.debug?.(`spawn ${cliPath} ${args.join(" ")} (cwd=${cwd ?? "-"})`);
  });
}

/** Extract a message id from whatever shape the CLI returns. */
export function extractMessageId(result) {
  const data = result?.data ?? {};
  const candidates = [
    data?.message_id,
    data?.data?.message_id,
    data?.items?.[0]?.message_id,
    result?.envelope?.message_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}
