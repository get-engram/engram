import { describe, it, expect } from "vitest";
import { Parser, REDACTED_TOOL_OUTPUT } from "../daemon/parser.js";
import { SecretScrubber, MIN_SCRUB_LENGTH } from "../daemon/scrubber.js";
import type { ParsedMessage } from "../daemon/types.js";

/**
 * Two deterministic layers that close the leak the homepage promised could
 * not happen: a vault secret, used by an agent, ending up in searchable
 * memory. The server-side regex is the third layer and is NOT under test
 * here — its whole problem is that a password has no shape to match.
 */

const PATH = "/Users/x/.claude/projects/-Users-x-p/s.jsonl";

function run(lines: string[]): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const p = new Parser((_s, _m, ms) => out.push(...ms));
  for (const l of lines) p.processLine(l, PATH);
  p.flush();
  return out;
}

const toolUse = (id: string, command: string) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "s",
    message: {
      id: "m1",
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
    },
  });

const toolResult = (id: string, content: string) =>
  JSON.stringify({
    type: "user",
    sessionId: "s",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  });

describe("layer 1 — the parser withholds output of commands that print secrets", () => {
  it("never captures the output of `engram vault get`", () => {
    // This is the exact path docs/vault.md tells users to set up in CLAUDE.md.
    const msgs = run([toolUse("t1", "engram vault get PROD_DB_PASSWORD"), toolResult("t1", "Tr0ub4dor&3-horse")]);
    const tool = msgs.find((m) => m.role === "tool")!;
    expect(tool.content).toBe(REDACTED_TOOL_OUTPUT);
    expect(JSON.stringify(msgs)).not.toContain("Tr0ub4dor");
  });

  it("never captures the vault KEY printed by `engram vault keygen`", () => {
    const msgs = run([toolUse("t2", "engram vault keygen"), toolResult("t2", "Generated key: 8f3a…c2 (save this)")]);
    expect(msgs.find((m) => m.role === "tool")!.content).toBe(REDACTED_TOOL_OUTPUT);
  });

  it("treats reading the key file as the same leak", () => {
    const msgs = run([toolUse("t3", "cat ~/.engram/vault-key"), toolResult("t3", "dGhlLWtleQ==")]);
    expect(msgs.find((m) => m.role === "tool")!.content).toBe(REDACTED_TOOL_OUTPUT);
  });

  it("matches the subcommand however the CLI was invoked", () => {
    for (const cmd of [
      "node dist/index.js vault get X",
      "npx engram vault get X",
      "./bin/engram vault get X",
      "ENGRAM_VAULT_KEY=abc engram vault get X | pbcopy",
    ]) {
      const msgs = run([toolUse("tx", cmd), toolResult("tx", "the-secret")]);
      expect(msgs.find((m) => m.role === "tool")!.content, cmd).toBe(REDACTED_TOOL_OUTPUT);
    }
  });

  it("leaves every other command's output alone", () => {
    const msgs = run([toolUse("t4", "engram vault list"), toolResult("t4", "PROD_DB_PASSWORD\nSTRIPE_KEY")]);
    expect(msgs.find((m) => m.role === "tool")!.content).toContain("PROD_DB_PASSWORD");
    const msgs2 = run([toolUse("t5", "git status"), toolResult("t5", "On branch main")]);
    expect(msgs2.find((m) => m.role === "tool")!.content).toBe("On branch main");
  });

  it("does not let an unrelated result inherit the redaction", () => {
    // Two tool calls; only the first prints a secret. The id is consumed once.
    const msgs = run([
      toolUse("t6", "engram vault get X"),
      toolResult("t6", "secret-value-here"),
      toolUse("t7", "echo hello"),
      toolResult("t7", "hello"),
    ]);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools.map((t) => t.content)).toEqual([REDACTED_TOOL_OUTPUT, "hello"]);
  });
});

describe("layer 2 — exact-value scrubbing of known vault secrets", () => {
  const vault = {
    async list() { return [{ name: "DB_PASSWORD" }, { name: "PIN" }, { name: "PASSPHRASE" }]; },
    async get(name: string) {
      return { DB_PASSWORD: "Tr0ub4dor&3-horse", PIN: "4821", PASSPHRASE: "correct horse battery staple" }[name] ?? null;
    },
  };

  async function scrubber() {
    const s = new SecretScrubber(vault, "base64-vault-key-value", () => {});
    await s.refresh();
    return s;
  }

  it("replaces a password that no regex could recognise", async () => {
    const s = await scrubber();
    const r = s.scrub("The staging DB password is Tr0ub4dor&3-horse, use it for the migration.");
    expect(r.text).toBe("The staging DB password is [VAULT:DB_PASSWORD], use it for the migration.");
  });

  it("replaces a passphrase that reads as ordinary prose", async () => {
    const s = await scrubber();
    expect(s.scrub("try correct horse battery staple first").text).toBe("try [VAULT:PASSPHRASE] first");
  });

  it("replaces a four-digit PIN — exactly the case a pattern cannot handle", async () => {
    const s = await scrubber();
    expect(s.scrub("the PIN is 4821").text).toBe("the PIN is [VAULT:PIN]");
  });

  it("scrubs the vault key itself", async () => {
    const s = await scrubber();
    expect(s.scrub("key=base64-vault-key-value").text).toBe("key=[VAULT:vault-key]");
  });

  it("replaces every occurrence, not just the first", async () => {
    const s = await scrubber();
    const r = s.scrub("4821 then again 4821");
    expect(r.text).toBe("[VAULT:PIN] then again [VAULT:PIN]");
    expect(r.replaced).toEqual([{ name: "PIN", count: 2 }]);
  });

  it("reports names only — the result carries no plaintext", async () => {
    const s = await scrubber();
    const r = s.scrub("Tr0ub4dor&3-horse");
    expect(JSON.stringify(r.replaced)).not.toContain("Tr0ub4dor");
  });

  it("ignores values shorter than the floor so a coincidence cannot be scrubbed", async () => {
    const tiny = { async list() { return [{ name: "N" }]; }, async get() { return "12"; } };
    const s = new SecretScrubber(tiny, undefined, () => {});
    await s.refresh();
    expect(MIN_SCRUB_LENGTH).toBeGreaterThan(2);
    expect(s.active).toBe(false);
    expect(s.scrub("version 12 of 12").text).toBe("version 12 of 12");
  });

  it("keeps the previous set when a refresh fails, rather than silently turning off", async () => {
    let fail = false;
    const flaky = {
      async list() { if (fail) throw new Error("network"); return [{ name: "A" }]; },
      async get() { return "value-one"; },
    };
    const s = new SecretScrubber(flaky, undefined, () => {});
    await s.refresh();
    expect(s.active).toBe(true);
    fail = true;
    await s.refresh();
    expect(s.active).toBe(true);
    expect(s.scrub("value-one").text).toBe("[VAULT:A]");
  });

  it("drops all plaintext on stop", async () => {
    const s = await scrubber();
    expect(s.active).toBe(true);
    s.stop();
    expect(s.active).toBe(false);
    expect(s.scrub("4821").text).toBe("4821");
  });
});
