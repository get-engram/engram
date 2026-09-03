import { describe, it, expect } from "vitest";
import { assertWritesEnabled } from "../services/conversation.js";
import type { Env } from "../types.js";

/**
 * The freeze exists so the messages-table rebuild (#383) cannot race with a
 * concurrent insert. A row written between the copy and the table swap would
 * be silently dropped — so "writes are refused" must be reliable, and
 * "writes are allowed" must be the default when the flag is absent.
 */
describe("assertWritesEnabled", () => {
  const env = (v?: string) => ({ WRITES_FROZEN: v }) as unknown as Env;

  it("allows writes when the flag is absent — the normal state", () => {
    expect(() => assertWritesEnabled(env(undefined))).not.toThrow();
  });

  it("blocks writes when frozen", () => {
    expect(() => assertWritesEnabled(env("1"))).toThrow(/maintenance/i);
  });

  it("only freezes on an exact '1' — no accidental truthiness", () => {
    // A stray "0", "false" or "" must not take the service down for writes.
    for (const v of ["0", "false", "", "true", "yes"]) {
      expect(() => assertWritesEnabled(env(v))).not.toThrow();
    }
  });

  it("tells the user nothing is lost, since clients surface this text", () => {
    try {
      assertWritesEnabled(env("1"));
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/nothing is lost/i);
      expect(msg).toMatch(/retry/i);
    }
  });
});
