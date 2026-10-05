const DEFAULT_RECENT_LOG_LIMIT = 40;
const RECENT_LOG_SUMMARY_LINES = 8;

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(fallbackMessage);
  if (typeof error === "string") return new Error(`${fallbackMessage}: ${error}`);

  try {
    return new Error(`${fallbackMessage}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${fallbackMessage}: ${String(error)}`);
  }
}

function summarizeRecentLogs(recentLogs: string[]): string | null {
  if (recentLogs.length === 0) return null;
  return recentLogs
    .slice(-RECENT_LOG_SUMMARY_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function detectEmbeddedPostgresHint(recentLogs: string[]): string | null {
  const haystack = recentLogs.join("\n").toLowerCase();
  if (haystack.includes("could not bind") || haystack.includes("could not create any tcp/ip sockets")) {
    return "Embedded PostgreSQL cannot bind its TCP port. The port may be reserved by Windows or blocked by local network policy. " +
      "Check reserved ranges with: netsh interface ipv4 show excludedportrange protocol=tcp. Use a database port outside those ranges.";
  }
  if (haystack.includes("pre-existing shared memory block is still in use")) {
    return "An old PostgreSQL process or orphaned worker is still using this database. " +
      "Stop the PostgreSQL processes belonging to this Paperclip instance, then retry. " +
      "On Windows, restarting Windows also clears orphaned workers. Do not delete the database directory.";
  }
  if (haystack.includes("administrative permissions")) {
    return "Embedded PostgreSQL cannot run as administrator. Start Paperclip from a regular, non-administrator terminal.";
  }
  if (haystack.includes("permission denied")) {
    return "Embedded PostgreSQL cannot access its database files. Check the database directory permissions for your current user.";
  }
  if (!haystack.includes("could not create shared memory segment")) {
    return null;
  }

  return (
    "Embedded PostgreSQL bootstrap could not allocate shared memory. " +
    "On macOS, this usually means the host's kern.sysv.shm* limits are too low for another local PostgreSQL cluster. " +
    "Stop other local PostgreSQL servers or raise the shared-memory sysctls, then retry."
  );
}

export async function startEmbeddedPostgresWithTimeout(
  start: () => Promise<void>,
  timeoutMs = 60_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(start),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Embedded PostgreSQL startup timed out after ${timeoutMs / 1000} seconds. ` +
          "A previous server or orphaned worker may still be running. Stop only PostgreSQL processes for this Paperclip instance and retry; " +
          "on Windows, restarting Windows clears orphaned workers. Do not delete the database directory.",
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createEmbeddedPostgresLogBuffer(limit = DEFAULT_RECENT_LOG_LIMIT): {
  append(message: unknown): void;
  getRecentLogs(): string[];
} {
  const recentLogs: string[] = [];

  return {
    append(message: unknown) {
      const text =
        typeof message === "string"
          ? message
          : message instanceof Error
            ? message.message
            : String(message ?? "");

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        recentLogs.push(line);
        if (recentLogs.length > limit) {
          recentLogs.splice(0, recentLogs.length - limit);
        }
      }
    },
    getRecentLogs() {
      return [...recentLogs];
    },
  };
}

export function formatEmbeddedPostgresError(
  error: unknown,
  input: {
    fallbackMessage: string;
    recentLogs?: string[];
  },
): Error {
  const baseError = toError(error, input.fallbackMessage);
  const recentLogs = input.recentLogs ?? [];
  const parts = [baseError.message];
  const hint = detectEmbeddedPostgresHint(recentLogs);
  const recentSummary = summarizeRecentLogs(recentLogs);

  if (hint) {
    parts.push(hint);
  }
  if (recentSummary) {
    parts.push(`Recent embedded Postgres logs: ${recentSummary}`);
  }

  return new Error(parts.join(" "));
}
