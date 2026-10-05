import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export function taskListIdentifiesPostgres(output: string, pid: number): boolean {
  return output.split(/\r?\n/).some((line) => {
    const match = /^"([^"]+)","(\d+)"(?:,|$)/.exec(line.trim());
    return match?.[1]?.toLowerCase() === "postgres.exe" && Number(match[2]) === pid;
  });
}

/** Windows reuses PIDs quickly; a live PID alone does not identify PostgreSQL. */
export async function isEmbeddedPostgresProcess(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (process.platform === "win32") {
    const { stdout } = await runFile(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"),
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { windowsHide: true, timeout: 5000 },
    );
    return taskListIdentifiesPostgres(stdout, pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
