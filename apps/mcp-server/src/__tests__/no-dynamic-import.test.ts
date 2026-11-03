import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// No dynamic imports in the worker source (engram#528).
//
// wrangler bundles the worker into one file. esbuild turns every module that is
// reachable through a dynamic import into a lazily initialised wrapper, and it
// loses the wrapper dependency across `export *` chains. When zod became both a
// static import of the MCP SDK and lazily reachable through the cron modules,
// the SDK's top-level `z.custom()` ran before zod was initialised and Cloudflare
// rejected the upload (10021) after CI had passed. A dynamic import buys nothing
// in a single-file bundle, so none is allowed. scripts/boot-bundle.mjs catches
// the general case by booting the bundle in workerd.

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DYNAMIC_IMPORT = /\bimport\s*\(/;

// Prose like "Idempotent import (engram#254)" lives in comments; only code counts.
function stripComments(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
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

describe("worker bundle init order (#528)", () => {
  it("has no dynamic import in apps/mcp-server/src", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (DYNAMIC_IMPORT.test(stripComments(line))) {
            offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("actually scans the source tree", () => {
    const files = [...walk(SRC)];
    expect(files.some((f) => f.endsWith(`${sep}index.ts`))).toBe(true);
    expect(files.length).toBeGreaterThan(50);
  });
});
