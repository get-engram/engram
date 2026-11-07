import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The CLI is an ES-module package: `require` does not exist at runtime. A
// bare call throws a ReferenceError, and where a try/catch surrounds it, the
// feature silently never works: desktop notifications never fired
// (engram#581). Vitest provides a `require` of its own, so a test of the
// feature passes either way; this checks the source instead. A file may call
// require() only after binding it: `const require = createRequire(import.meta.url)`.

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("no bare require() in the ES-module CLI", () => {
  it("binds require with createRequire wherever it is called", () => {
    const offenders = sourceFiles(SRC).filter((path) => {
      const code = stripComments(readFileSync(path, "utf-8"));
      return /\brequire\s*\(/.test(code) && !/\brequire\s*=\s*createRequire\(/.test(code);
    });
    expect(offenders.map((p) => relative(SRC, p))).toEqual([]);
  });

  it("finds the source files it is meant to check", () => {
    const files = sourceFiles(SRC).map((p) => relative(SRC, p));
    expect(files).toContain("daemon/status.ts");
    expect(files).toContain("index.ts");
  });
});
