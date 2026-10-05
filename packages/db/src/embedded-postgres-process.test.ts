import { describe, expect, it } from "vitest";
import { taskListIdentifiesPostgres } from "./embedded-postgres-process.js";

describe("Windows PostgreSQL PID identity", () => {
  it("rejects a PID recycled into Node", () => {
    expect(taskListIdentifiesPostgres('"node.exe","46308","Console","1","10,000 K"', 46308)).toBe(false);
  });
  it("accepts only the expected PostgreSQL PID", () => {
    const output = '"postgres.exe","1234","Console","1","10,000 K"\r\n';
    expect(taskListIdentifiesPostgres(output, 1234)).toBe(true);
    expect(taskListIdentifiesPostgres(output, 4321)).toBe(false);
  });
  it("rejects missing processes and executable names that only contain postgres", () => {
    expect(taskListIdentifiesPostgres("INFO: No tasks are running which match the specified criteria.", 1234)).toBe(false);
    expect(taskListIdentifiesPostgres('"other-postgres.exe","1234"', 1234)).toBe(false);
  });
});
