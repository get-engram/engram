import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// No email address in the worker's logs (engram#734).
//
// Log lines land in `wrangler tail` output and in any store the logs are kept
// in, where an erasure request cannot reach them. The org id identifies the
// account for anyone who can look it up, so a log line never needs the address.
// Seven cron failure lines printed it; this keeps a new one from bringing it
// back. It reads the code each log call runs (its arguments, and the ${…}
// parts of template literals), not the words of its message, so "email
// failed" is fine and `${org.email}` is not.

const SRC = fileURLToPath(new URL("..", import.meta.url));
const LOG_CALL = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/g;

type Frame = { kind: "code"; depth: number } | { kind: "template" };

/**
 * The code inside the call whose opening parenthesis is at `open`, up to the
 * matching closing one: string literals and template text dropped, `${…}`
 * expressions kept.
 */
export function argumentCode(src: string, open: number): string {
  const frames: Frame[] = [{ kind: "code", depth: 0 }];
  let code = "";
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const top = frames[frames.length - 1];
    if (top.kind === "template") {
      if (ch === "\\") i++;
      else if (ch === "`") frames.pop();
      else if (ch === "$" && src[i + 1] === "{") {
        frames.push({ kind: "code", depth: 0 });
        code += " ";
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === "\\") i++;
      code += " ";
      continue;
    }
    if (ch === "`") {
      frames.push({ kind: "template" });
      continue;
    }
    if (ch === "}" && top.depth === 0 && frames.length > 1) {
      frames.pop();
      code += " ";
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") top.depth++;
    if (ch === ")" || ch === "]" || ch === "}") top.depth--;
    code += ch;
    if (frames.length === 1 && top.depth === 0) return code;
  }
  return code;
}

/** Each log call in `src` whose code names an email field: `org.email`, `user_email`, `toEmail`. */
export function logCallsNamingEmail(src: string): string[] {
  const found: string[] = [];
  for (const match of src.matchAll(LOG_CALL)) {
    const start = match.index ?? 0;
    const lineStart = src.lastIndexOf("\n", start) + 1;
    const before = src.slice(lineStart, start).trim();
    // A call written out in a comment is prose, not code.
    if (before.startsWith("//") || before.startsWith("*") || before.startsWith("/*")) continue;
    const code = argumentCode(src, start + match[0].length - 1);
    if (/email/i.test(code)) {
      const line = src.slice(0, start).split("\n").length;
      found.push(`${line}: ${src.slice(lineStart, src.indexOf("\n", start) === -1 ? undefined : src.indexOf("\n", start)).trim()}`);
    }
  }
  return found;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      yield* walk(path);
    } else if (/\.(ts|js|mjs)$/.test(entry.name)) {
      yield path;
    }
  }
}

describe("no email address in worker logs (#734)", () => {
  it("no log call in apps/mcp-server/src names an email field", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const hit of logCallsNamingEmail(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(SRC, file)}:${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually scans the source tree, and its log calls", () => {
    const files = [...walk(SRC)];
    expect(files.some((f) => f.endsWith(`${sep}cron${sep}weekly-digest.ts`))).toBe(true);
    const calls = files.reduce((n, f) => n + [...readFileSync(f, "utf8").matchAll(LOG_CALL)].length, 0);
    expect(calls).toBeGreaterThan(50);
  });

  describe("what it catches", () => {
    it.each([
      ["a template interpolation", "console.error(`[x] Failed for ${org.email}:`, err);"],
      ["a fallback inside one", "console.log(`[grace] Expired grace for ${org.email ?? org.id}`);"],
      ["a plain argument", 'console.warn("send failed", user.email);'],
      ["another name for it", "console.info(`sent to ${row.user_email}`);"],
      ["a camel-case name", "console.log(`to ${toEmail}`)"],
      ["a nested template", "console.log(`a ${ok ? `b ${o.email}` : ''} c`);"],
      ["an object argument", "console.error({ to: org.email, err });"],
      ["a call over several lines", "console.error(\n  `[x] failed`,\n  org.email,\n);"],
      ["console.debug", "console.debug(`${o.email}`)"],
      ["spaces around the dot", "console . error(org.email)"],
    ])("%s", (_label, src) => {
      expect(logCallsNamingEmail(src)).toHaveLength(1);
    });
  });

  describe("what it leaves alone", () => {
    it.each([
      ["the word in the message", "console.warn(`[admin] email_log wiped: type=${type}`);"],
      ["a message about an email", "console.error(`[student] verify email failed: ${res.status}`);"],
      ["a single-quoted message", "console.error('[claim] link email threw', err);"],
      ["an escaped quote in a string", "console.log(\"say \\\"email\\\" here\", id);"],
      ["an escaped ${ in a template", "console.log(`a \\${email} b`, id);"],
      ["an escaped backtick in a template", "console.log(`a \\` email`, id);"],
      ["the org id", "console.error(`[digest] Failed for org ${org.id}:`, err);"],
      ["a call written in a comment", "// console.error(org.email)"],
      ["a call in a doc comment", " * console.log(`${org.email}`)"],
      ["code after the call", "console.log(`sent ${n}`); const to = org.email;"],
    ])("%s", (_label, src) => {
      expect(logCallsNamingEmail(src)).toEqual([]);
    });
  });
});
