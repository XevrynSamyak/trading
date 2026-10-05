/**
 * One place for output. Everything printed (ours, and libraries' console
 * output once installConsoleRedaction() ran) has secrets removed first:
 * API keys in URLs or headers, Jupiter and Telegram tokens, and anything
 * shaped like a Solana secret key.
 */

const PATTERNS: [RegExp, string][] = [
  // ?api-key=... / &apiKey=... (Helius RPC URL, other providers)
  [/(api[-_]?key=)[^&\s"'<>]+/gi, "$1***"],
  // ?token=... (status page links) and "Bearer ..." headers
  [/([?&]token=)[^&\s"'<>]+/gi, "$1***"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1***"],
  // "x-api-key": "..." / x-api-key=...
  [/("?x-api-key"?\s*[:=]\s*"?)[^"',\s}]+/gi, "$1***"],
  // Jupiter API keys
  [/\bjup_[0-9a-f]{16,}\b/gi, "jup_***"],
  // Telegram bot tokens (they appear in the sendMessage URL)
  [/\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g, "bot***"],
  // base58 Solana secret keys (64 bytes ~ 87-88 chars); public keys are ~44 and stay readable
  [/\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g, "[REDACTED-SECRET-KEY]"],
  // secret keys as a JSON byte array (64 numbers)
  [/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g, "[REDACTED-KEY-BYTES]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function stringify(arg: unknown): string {
  if (arg instanceof Error) {
    const cause = (arg as Error & { cause?: unknown }).cause;
    return `${arg.name}: ${arg.message}` + (cause ? ` (cause: ${stringify(cause)})` : "");
  }
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(arg);
  }
}

/** Formats console-style arguments into one redacted line. */
export function fmt(args: unknown[]): string {
  return redact(args.map(stringify).join(" "));
}

const stamp = () => `[${new Date().toISOString()}]`;

export const log = {
  /** Ordinary progress lines (scan results etc.). */
  info: (...args: unknown[]) => console.log(fmt(args)),
  /** Things worth noticing later; timestamped. */
  event: (...args: unknown[]) => console.log(`${stamp()} ${fmt(args)}`),
  warn: (...args: unknown[]) => console.warn(`${stamp()} WARN ${fmt(args)}`),
  error: (...args: unknown[]) => console.error(`${stamp()} ERROR ${fmt(args)}`),
};

let installed = false;

/**
 * Wraps console.* so output from libraries (e.g. RPC/WebSocket errors that
 * could include the RPC URL with its API key) is redacted too.
 */
/**
 * The Solana library prints "ws error: ..." on every reconnect attempt (about
 * once a second) while the RPC's WebSocket is unreachable. Show the first one,
 * then at most one every `quietMs`, with how many were hidden.
 */
export function makeRepeatFilter(quietMs = 10 * 60_000, now: () => number = Date.now) {
  let lastShown = -Infinity;
  let hidden = 0;
  return (line: string): string | null => {
    if (!line.startsWith("ws error")) return line;
    if (now() - lastShown < quietMs) {
      hidden += 1;
      return null;
    }
    lastShown = now();
    const note = hidden ? ` (${hidden} similar hidden)` : "";
    hidden = 0;
    return `${line}${note} [WebSocket unreachable; retrying quietly. Event triggers pause until it's back]`;
  };
}

export function installConsoleRedaction(): void {
  if (installed) return;
  installed = true;
  const filter = makeRepeatFilter();
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const line = filter(fmt(args));
      if (line !== null) original(line);
    };
  }
}
