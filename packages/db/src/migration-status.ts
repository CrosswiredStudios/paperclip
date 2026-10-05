import { inspectMigrations } from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

const jsonMode = process.argv.includes("--json");
let currentStage = "loading migration status";
function reportStage(stage: string) {
  currentStage = stage;
  process.stderr.write(`[paperclip:database] ${stage}\n`);
}

function toError(error: unknown, context = "Migration status check failed"): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(context);
  if (typeof error === "string") return new Error(`${context}: ${error}`);

  try {
    return new Error(`${context}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${context}: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  const connection = await resolveMigrationConnection(reportStage);

  try {
    reportStage("inspecting migration journal");
    const state = await inspectMigrations(connection.connectionString);
    const payload =
      state.status === "upToDate"
        ? {
            source: connection.source,
            status: "upToDate" as const,
            tableCount: state.tableCount,
            pendingMigrations: [] as string[],
          }
        : {
            source: connection.source,
            status: "needsMigrations" as const,
            tableCount: state.tableCount,
            pendingMigrations: state.pendingMigrations,
            reason: state.reason,
          };

    if (jsonMode) {
      console.log(JSON.stringify(payload));
      return;
    }

    if (payload.status === "upToDate") {
      console.log(`Database is up to date via ${payload.source}`);
      return;
    }

    console.log(
      `Pending migrations via ${payload.source}: ${payload.pendingMigrations.join(", ")}`,
    );
  } finally {
    await connection.stop();
  }
}

// Bound the entire preflight, including connection probes and database shutdown.
const watchdog = setTimeout(() => {
  process.stderr.write(`[paperclip:database] Migration status timed out after 120 seconds while ${currentStage}. ` +
    "Stop this startup and inspect PostgreSQL processes for this instance before retrying. Do not delete the database directory.\n");
  process.exit(1);
}, 120_000);
main().then(() => {
  clearTimeout(watchdog);
}).catch((error) => {
  clearTimeout(watchdog);
  const err = toError(error, "Migration status check failed");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
