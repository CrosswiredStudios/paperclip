import { describe, expect, it, vi } from "vitest";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError, startEmbeddedPostgresWithTimeout } from "./embedded-postgres-error.js";

describe("formatEmbeddedPostgresError", () => {
  it("distinguishes denied sockets from denied database files", () => {
    const error = formatEmbeddedPostgresError(undefined, {
      fallbackMessage: "Startup failed",
      recentLogs: ['could not bind IPv4 address "127.0.0.1": Permission denied', "could not create any TCP/IP sockets"],
    });
    expect(error.message).toContain("cannot bind its TCP port");
    expect(error.message).not.toContain("database directory permissions");
  });
  it("explains orphaned workers without recommending database deletion", () => {
    const error = formatEmbeddedPostgresError(undefined, {
      fallbackMessage: "Startup failed",
      recentLogs: ["FATAL: pre-existing shared memory block is still in use"],
    });
    expect(error.message).toContain("orphaned worker");
    expect(error.message).toContain("Do not delete the database directory");
  });

  it("explains administrator and filesystem permission failures", () => {
    for (const [log, hint] of [
      ["Execution of PostgreSQL by a user with administrative permissions is not permitted", "non-administrator terminal"],
      ['could not create lock file "postmaster.pid": Permission denied', "directory permissions"],
    ]) {
      expect(formatEmbeddedPostgresError(undefined, { fallbackMessage: "Startup failed", recentLogs: [log!] }).message).toContain(hint);
    }
  });

  it("bounds a startup that never settles and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const result = startEmbeddedPostgresWithTimeout(() => new Promise(() => {}), 1000);
      const assertion = expect(result).rejects.toThrow("startup timed out after 1 seconds");
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an immediate startup failure", async () => {
    const failure = new Error("start failed");
    await expect(startEmbeddedPostgresWithTimeout(async () => { throw failure; })).rejects.toBe(failure);
    await expect(startEmbeddedPostgresWithTimeout(async () => {})).resolves.toBeUndefined();
  });
  it("adds a shared-memory hint when initdb logs expose the real cause", () => {
    const error = formatEmbeddedPostgresError("Postgres init script exited with code 1.", {
      fallbackMessage: "Failed to initialize embedded PostgreSQL cluster",
      recentLogs: [
        "running bootstrap script ...",
        "FATAL:  could not create shared memory segment: Cannot allocate memory",
        "DETAIL:  Failed system call was shmget(key=123, size=56, 03600).",
      ],
    });

    expect(error.message).toContain("could not allocate shared memory");
    expect(error.message).toContain("kern.sysv.shm");
    expect(error.message).toContain("could not create shared memory segment");
  });

  it("keeps only recent non-empty log lines in the collector", () => {
    const buffer = createEmbeddedPostgresLogBuffer(2);
    buffer.append("line one\n\n");
    buffer.append("line two");
    buffer.append("line three");

    expect(buffer.getRecentLogs()).toEqual(["line two", "line three"]);
  });
});
