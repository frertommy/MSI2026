type LogLevel = "info" | "warn" | "error" | "debug";

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, msg: string, data?: unknown): string {
  const color = LEVEL_COLORS[level];
  const ts = timestamp();
  const prefix = `${color}[${ts}] [${level.toUpperCase()}]${RESET}`;
  if (data !== undefined) {
    const extra =
      typeof data === "object" ? JSON.stringify(data, null, 0) : String(data);
    return `${prefix} ${msg} ${extra}`;
  }
  return `${prefix} ${msg}`;
}

export const log = {
  info(msg: string, data?: unknown) {
    console.log(formatMessage("info", msg, data));
  },
  warn(msg: string, data?: unknown) {
    console.warn(formatMessage("warn", msg, data));
  },
  error(msg: string, data?: unknown) {
    console.error(formatMessage("error", msg, data));
  },
  debug(msg: string, data?: unknown) {
    if (process.env.DEBUG === "true") {
      console.log(formatMessage("debug", msg, data));
    }
  },
};
