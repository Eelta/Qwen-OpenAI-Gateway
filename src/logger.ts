type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const debugEnabled = () => process.env.QWEN_GATEWAY_DEBUG === "1";

/** DEBUG is printed only when QWEN_GATEWAY_DEBUG=1. */
function write(level: LogLevel, message: string): void {
  if (level === "DEBUG" && !debugEnabled()) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  process.stderr.write(`[${ts}] [${level}] ${message}\n`);
}

/** INFO log with a caller-supplied prefix. */
export function log(message: string): void {
  write("INFO", message);
}

export interface ScopedLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Logger with a fixed `[scope]` prefix:
 * `createLogger("qwen-auth").info("ok")` → `[12:34:56.789] [INFO] [qwen-auth] ok`
 */
export function createLogger(scope: string): ScopedLogger {
  const prefix = `[${scope}]`;
  return {
    debug: (m) => write("DEBUG", `${prefix} ${m}`),
    info: (m) => write("INFO", `${prefix} ${m}`),
    warn: (m) => write("WARN", `${prefix} ${m}`),
    error: (m) => write("ERROR", `${prefix} ${m}`),
  };
}

/**
 * Node's fetch reports a bare "fetch failed" and hides the real reason in
 * `cause`, so the chain is unwrapped — otherwise the log says nothing at all.
 */
export function errToString(err: unknown): string {
  if (!(err instanceof Error)) {
    return typeof err === "string" ? err : String(err);
  }

  const base = err.message || err.name;
  const cause = (err as { cause?: unknown }).cause;
  if (!cause) return base;

  const detail =
    cause instanceof Error
      ? [(cause as NodeJS.ErrnoException).code, cause.message]
          .filter(Boolean)
          .join(": ")
      : String(cause);
  return detail ? `${base} (${detail})` : base;
}
