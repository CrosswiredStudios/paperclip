import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { execFile, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { ensurePostgresDatabase, getPostgresDataDirectory } from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError, startEmbeddedPostgresWithTimeout } from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import { resolveDatabaseTarget } from "./runtime-config.js";
import { isEmbeddedPostgresProcess } from "./embedded-postgres-process.js";

type EmbeddedPostgresInstance = {
  process?: ChildProcess;
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type MigrationConnection = {
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

async function readRunningPostmasterPid(postmasterPidFile: string): Promise<number | null> {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function readPidFilePort(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      // Reserved Windows ports fail with EACCES even without a listener.
      // Any failed bind means this candidate cannot be used.
      resolve(true);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

export async function findAvailablePort(startPort: number): Promise<number> {
  const maxLookahead = 1024;
  let port = startPort;
  for (let i = 0; i < maxLookahead && port <= 65535; i += 1, port += 1) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(
    `Embedded PostgreSQL could not find a bindable port from ${startPort} to ${startPort + maxLookahead - 1}. Check Windows reserved ports and local socket permissions.`,
  );
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  try {
    const mod = await import("embedded-postgres");
    // The Windows shutdown workaround also accesses the provider's runtime
    // child-process field, which its declarations mark private.
    return mod.default as unknown as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
  reportStage: (stage: string) => void,
): Promise<MigrationConnection> {
  reportStage("loading embedded PostgreSQL runtime");
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  await prepareEmbeddedPostgresNativeRuntime();
  reportStage(`finding a bindable database port near ${preferredPort}`);
  const selectedPort = await findAvailablePort(preferredPort);
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const pgVersionFile = path.resolve(dataDir, "PG_VERSION");
  const recordedPid = await readRunningPostmasterPid(postmasterPidFile);
  const runningPid = recordedPid && await isEmbeddedPostgresProcess(recordedPid) ? recordedPid : null;
  if (recordedPid && !runningPid) reportStage(`ignoring stale PostgreSQL PID ${recordedPid}; it no longer identifies PostgreSQL`);
  const runningPort = readPidFilePort(postmasterPidFile);
  const preferredAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${preferredPort}/postgres`;
  const logBuffer = createEmbeddedPostgresLogBuffer();

  if (!runningPid && existsSync(pgVersionFile)) {
    reportStage(`checking for an existing database on port ${preferredPort}`);
    try {
      const actualDataDir = await getPostgresDataDirectory(preferredAdminConnectionString);
      const matchesDataDir =
        typeof actualDataDir === "string" &&
        path.resolve(actualDataDir) === path.resolve(dataDir);
      if (!matchesDataDir) {
        throw new Error("reachable postgres does not use the expected embedded data directory");
      }
      await ensurePostgresDatabase(preferredAdminConnectionString, "paperclip");
      process.emitWarning(
        `Adopting an existing PostgreSQL instance on port ${preferredPort} for embedded data dir ${dataDir} because postmaster.pid is missing.`,
      );
      return {
        connectionString: `postgres://paperclip:paperclip@127.0.0.1:${preferredPort}/paperclip`,
        source: `embedded-postgres@${preferredPort}`,
        stop: async () => {},
      };
    } catch {
      // Fall through and attempt to start the configured embedded cluster.
    }
  }

  if (runningPid) {
    const port = runningPort ?? preferredPort;
    reportStage(`connecting to existing PostgreSQL PID ${runningPid} on port ${port}`);
    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    const actualDataDir = await getPostgresDataDirectory(adminConnectionString);
    if (!actualDataDir || path.resolve(actualDataDir) !== path.resolve(dataDir)) {
      throw new Error("Refusing to reuse PostgreSQL: its data directory could not be verified for this instance.");
    }
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    return {
      connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
      source: `embedded-postgres@${port}`,
      stop: async () => {},
    };
  }

  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port: selectedPort,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: logBuffer.append,
    onError: logBuffer.append,
  });

  if (!existsSync(path.resolve(dataDir, "PG_VERSION"))) {
    reportStage("initializing the database directory");
    try {
      await instance.initialise();
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage:
          `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${selectedPort}`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }
  if (existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }
  try {
    reportStage(`starting embedded PostgreSQL on port ${selectedPort}`);
    await startEmbeddedPostgresWithTimeout(() => instance.start());
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `Failed to start embedded PostgreSQL on port ${selectedPort}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${selectedPort}/postgres`;
  reportStage(`checking the paperclip database on port ${selectedPort}`);
  await ensurePostgresDatabase(adminConnectionString, "paperclip");

  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${selectedPort}/paperclip`,
    source: `embedded-postgres@${selectedPort}`,
    stop: async () => {
      reportStage("stopping the database started by the migration check");
      if (process.platform === "win32" && instance.process?.pid) {
        // The provider's taskkill shutdown can leave Windows I/O workers and
        // stale PID files. Ask PostgreSQL to shut down its own workers first.
        const ownedPid = instance.process.pid;
        const recordedPid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
        if (recordedPid !== ownedPid || !await isEmbeddedPostgresProcess(ownedPid)) {
          throw new Error("Refusing to stop PostgreSQL: the migration check no longer owns the database process.");
        }
        const require = createRequire(import.meta.url);
        const providerRequire = createRequire(require.resolve("embedded-postgres"));
        const native = providerRequire("@embedded-postgres/windows-x64") as { pg_ctl: string };
        await promisify(execFile)(native.pg_ctl,
          ["-D", dataDir, "stop", "-m", "fast", "-w", "-t", "30"],
          { windowsHide: true, timeout: 35_000 });
        // Prevent the provider's exit hook from stopping an already exited PID.
        instance.process = undefined;
      } else {
        await instance.stop();
      }
    },
  };
}

export async function resolveMigrationConnection(reportStage: (stage: string) => void = () => {}): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      connectionString: target.connectionString,
      source: target.source,
      stop: async () => {},
    };
  }

  return ensureEmbeddedPostgresConnection(target.dataDir, target.port, reportStage);
}
