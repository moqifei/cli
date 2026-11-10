/**
 * Tiny logging helpers. Everything goes through the logger injected by the
 * Orange bridge (`ctx.log` / `api.logger`) so plugin output lands in the
 * gateway log with the right channel prefix.
 */

const SECRET_PATTERNS = [
  /(app[_-]?secret\s*[:=]\s*)["']?[^\s"',;]+/gi,
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s"',;]+/gi,
  /(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g,
  /((?:tenant|user)_access_token\s*[:=]\s*)["']?[^\s"',;]+/gi,
];

/** Redact obvious credentials before anything reaches a log sink. */
export function redact(value) {
  let out = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_m, prefix) => `${prefix}***`);
  }
  return out;
}

export function createLogger(sink, scope) {
  const emit = (level, message) => {
    const text = `[orange-lark-cli${scope ? `:${scope}` : ""}] ${redact(message)}`;
    try {
      if (typeof sink === "function") sink(level, text);
    } catch {
      /* logging must never break the channel */
    }
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    child: (childScope) => createLogger(sink, scope ? `${scope}:${childScope}` : childScope),
  };
}

export function tail(text, max = 800) {
  const value = String(text ?? "");
  return value.length > max ? `…${value.slice(-max)}` : value;
}
