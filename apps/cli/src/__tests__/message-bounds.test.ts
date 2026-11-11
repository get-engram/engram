import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engram, MessageInput } from "@getengram/sdk";
import {
  GENERIC_MIN_CHARS,
  MAX_MESSAGE_CONTENT_CHARS,
  TRUNCATION_MARKER,
  boundContent,
  stripBinaryPayloads,
} from "../message-bounds.js";
import { STORE_BATCH_BYTES, importHistory, storeBatches } from "../commands/import.js";
import { store } from "../commands/store.js";

// The import test passes --force, so no usage check runs. Were one to run,
// it must not read the developer's own ~/.engram/config.json.
vi.mock("../config-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config-guard.js")>()),
  configForUse: async () => {
    throw new Error("a test asked for ~/.engram/config.json");
  },
}));

// engram#750: the CLI bounds message bodies before it queues and sends
// them, with a copy of the code Engram runs on arrival (engram#386). The
// copy has to stay a copy: these tests read the worker's files and fail
// the moment the two differ.

/** Paths from this file to the worker's code. Never imported statically:
 *  they sit outside the CLI's rootDir, and the CLI is published alone. */
const SERVER_PAYLOADS = "../../../mcp-server/src/services/binary-payloads.ts";
const SERVER_TIER = "../../../mcp-server/src/services/tier.ts";
const SHARED_CONSTANTS = "../../../../packages/shared/src/constants.ts";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Loaded by URL: a bare relative specifier resolves from the project root. */
const load = (rel: string) => import(/* @vite-ignore */ new URL(rel, import.meta.url).href);

/** Code without comments or layout: what a copy must keep the same. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deterministic bytes (mulberry32), so every run sees the same corpus. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randomBytes = (n: number, rand: () => number) =>
  Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256)));

/** The first bytes of each file type the strip recognises. */
const SIGNATURES = {
  PNG: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  JPEG: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  GIF: Buffer.from("GIF89a"),
  WebP: Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP")]),
  PDF: Buffer.from("%PDF-1.7"),
};
type Kind = keyof typeof SIGNATURES;

/** A file of `size` bytes with `kind`'s signature, base64-encoded. */
const encoded = (kind: Kind, size: number, rand = prng(size)) =>
  Buffer.concat([SIGNATURES[kind], randomBytes(size - SIGNATURES[kind].length, rand)]).toString("base64");

/** A Claude Code tool result holding a screenshot, as the parser sends it. */
const toolResult = (data: string) =>
  JSON.stringify([
    { type: "text", text: "Took a screenshot" },
    { type: "image", source: { type: "base64", media_type: "image/png", data } },
  ]);

/** Texts built from the pieces the patterns turn on: runs around both
 *  length floors, signed files, data: URLs, glue, JSON escapes, padding. */
function corpus(seed: number, count: number): string[] {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const run = (n: number) =>
    randomBytes(Math.ceil((n * 3) / 4) + 3, rand)
      .toString("base64")
      .replace(/=+$/, "")
      .slice(0, n);
  const kinds = Object.keys(SIGNATURES) as Kind[];
  const pieces: Array<() => string> = [
    () =>
      pick([
        "hello",
        "the screenshot",
        "π ≈ 3.14",
        "—",
        "data:",
        ";base64,",
        "\\n",
        "\\t",
        "\\r",
        "\\\\",
        '"',
        "_",
        "-",
        "=",
        "==",
        " ",
        "\n",
        ",",
        "{",
        "}",
        "sk_live_",
        "ghp_",
      ]),
    () => run(30 + Math.floor(rand() * 20)),
    () => run(GENERIC_MIN_CHARS - 3 + Math.floor(rand() * 6)),
    () => encoded(pick(kinds), 30 + Math.floor(rand() * 3000), rand),
    () =>
      `data:${pick(["image/png", "image/JPEG", "image/svg+xml", "application/pdf", "audio/mpeg", "video/mp4", "font/woff2", "text/plain", ""])}` +
      `${pick(["", ";charset=utf-8", ";name=a.png"])};base64,` +
      pick([run(60), encoded(pick(kinds), 200, rand)]),
    () => pick(["A", "a", "7"]).repeat(GENERIC_MIN_CHARS + Math.floor(rand() * 10)),
  ];
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(rand() * 12) }, () => pick(pieces)()).join(""),
  );
}

interface Server {
  stripBinaryPayloads: (text: string) => string;
  max: number;
}
let server: Server;

beforeAll(async () => {
  const payloads = (await load(SERVER_PAYLOADS)) as {
    stripBinaryPayloads: (text: string) => string;
  };
  const constants = (await load(SHARED_CONSTANTS)) as {
    MAX_MESSAGE_CONTENT_CHARS: number;
  };
  server = { stripBinaryPayloads: payloads.stripBinaryPayloads, max: constants.MAX_MESSAGE_CONTENT_CHARS };
});

/** What Engram's append stores for a body (apps/mcp-server tier.ts). */
const serverBound = (text: string) => {
  const t = server.stripBinaryPayloads(text);
  if (t.length <= server.max) return t;
  return t.slice(0, server.max) + `\n\n…[truncated: message exceeded ${server.max.toLocaleString("en-US")} characters]`;
};

describe("the CLI bounds a body exactly as Engram does (engram#750)", () => {
  it("its strip is a copy of the worker's, code for code", () => {
    const cli = source("../message-bounds.ts");
    const divider = cli.indexOf("// From here on, a copy of apps/mcp-server/src/services/binary-payloads.ts.");
    expect(divider).toBeGreaterThan(0);
    expect(
      code(cli.slice(divider)),
      "apps/cli/src/message-bounds.ts must stay a copy of apps/mcp-server/src/services/binary-payloads.ts",
    ).toBe(code(source(SERVER_PAYLOADS)));
  });

  it("Engram clips at the same length, with the same marker, after the strip", () => {
    expect(MAX_MESSAGE_CONTENT_CHARS).toBe(server.max);
    expect(TRUNCATION_MARKER).toBe(
      `\n\n…[truncated: message exceeded ${server.max.toLocaleString("en-US")} characters]`,
    );
    const tier = code(source(SERVER_TIER));
    expect(tier).toMatch(/import \{[^}]*\bMAX_MESSAGE_CONTENT_CHARS\b[^}]*\} from "@getengram\/shared";/);
    expect(tier).toContain('import { stripBinaryPayloads } from "./binary-payloads.js";');
    expect(tier).toContain(
      [
        "export function boundContent(content: string): string {",
        "const text = stripBinaryPayloads(content);",
        "if (text.length <= MAX_MESSAGE_CONTENT_CHARS) return text;",
        "return (",
        "text.slice(0, MAX_MESSAGE_CONTENT_CHARS) +",
        "`\\n\\n…[truncated: message exceeded ${MAX_MESSAGE_CONTENT_CHARS.toLocaleString()} characters]`",
        ");",
        "}",
      ].join(" "),
    );
  });

  it("gives the worker's answer for every text in a seeded corpus", () => {
    for (const text of corpus(750, 400)) {
      expect(stripBinaryPayloads(text)).toBe(server.stripBinaryPayloads(text));
      expect(boundContent(text)).toBe(serverBound(text));
    }
  });

  it("gives the worker's answer for long texts, where the clip applies", () => {
    const rand = prng(386);
    const big = [
      "x ".repeat(60_000),
      "x ".repeat(30_000) + toolResult(encoded("PNG", 90_000)) + " after".repeat(5_000),
      "y".repeat(MAX_MESSAGE_CONTENT_CHARS - 10) + " " + encoded("JPEG", 3_000, rand),
      corpus(1, 60).join(" "),
    ];
    for (const text of big) {
      expect(text.length).toBeGreaterThan(MAX_MESSAGE_CONTENT_CHARS);
      expect(boundContent(text)).toBe(serverBound(text));
    }
  });
});

describe("boundContent", () => {
  it("returns a body with nothing to bound unchanged", () => {
    for (const text of ["", "hello", "a".repeat(MAX_MESSAGE_CONTENT_CHARS), 'sk_live_' + "Ab1".repeat(20)]) {
      expect(boundContent(text)).toBe(text);
    }
  });

  it("clips past MAX_MESSAGE_CONTENT_CHARS with a visible marker", () => {
    const text = "a".repeat(MAX_MESSAGE_CONTENT_CHARS) + "b";
    expect(boundContent(text)).toBe("a".repeat(MAX_MESSAGE_CONTENT_CHARS) + TRUNCATION_MARKER);
    expect(TRUNCATION_MARKER).toBe("\n\n…[truncated: message exceeded 100,000 characters]");
  });

  it("notes a screenshot in a tool result and keeps the JSON valid", () => {
    const bounded = boundContent(toolResult(encoded("PNG", 300_000)));
    expect(JSON.parse(bounded)).toEqual([
      { type: "text", text: "Took a screenshot" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "[image not stored: PNG, 293 KB]" },
      },
    ]);
  });

  it("strips before it clips, so the text after a large screenshot is kept", () => {
    const text = "before " + toolResult(encoded("PNG", 150_000)) + " after";
    expect(text.length).toBeGreaterThan(MAX_MESSAGE_CONTENT_CHARS);
    const bounded = boundContent(text);
    expect(bounded).not.toContain("truncated");
    expect(bounded.endsWith(" after")).toBe(true);
  });

  it("stores the same, or less: a run glued past the cut is noted once the cut frees it", () => {
    // The header's one exception. Left alone while glued to "_tail" (it
    // could be part of a key), the run ends at the cut once clipped, and
    // Engram's own pass on arrival notes it.
    const text = "a".repeat(99_000) + " " + encoded("PNG", 2_250) + "_tail";
    const sent = boundContent(text);
    expect(sent).toBe(text.slice(0, MAX_MESSAGE_CONTENT_CHARS) + TRUNCATION_MARKER);
    expect(serverBound(sent)).toBe("a".repeat(99_000) + " [image not stored: PNG, 749 B]" + TRUNCATION_MARKER);
    expect(serverBound(sent).length).toBeLessThan(serverBound(text).length);
  });
});

describe("engram import sends bounded batches (engram#750)", () => {
  const messages = (n: number, size: number): MessageInput[] =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${i}:`.padEnd(size, "x"),
    }));

  it("keeps the 100-message batches for ordinary conversations", () => {
    const batches = storeBatches(messages(250, 200));
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(messages(250, 200));
  });

  it("closes a batch before it passes STORE_BATCH_BYTES of content as sent", () => {
    const batches = storeBatches(messages(30, MAX_MESSAGE_CONTENT_CHARS));
    expect(batches.map((b) => b.length)).toEqual([20, 10]);
    for (const b of batches) {
      const bytes = b.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m.content)), 0);
      expect(bytes).toBeLessThanOrEqual(STORE_BATCH_BYTES);
    }
  });

  it("counts a body by its bytes once encoded, not its characters", () => {
    // "é" is two bytes in UTF-8; "\u0001" is six once JSON-escaped.
    expect(storeBatches(messages(30, 10).map((m) => ({ ...m, content: "é".repeat(50_000) }))).map((b) => b.length))
      .toEqual([20, 10]);
    expect(
      storeBatches(messages(20, 10).map((m) => ({ ...m, content: "\u0001".repeat(50_000) }))).map((b) => b.length),
    ).toEqual([6, 6, 6, 2]);
  });

  it("bounds every body, and sends a message with nothing to bound as it was", () => {
    const shot = { role: "user" as const, content: toolResult(encoded("PNG", 300_000)) };
    const long = { role: "assistant" as const, content: "z".repeat(150_000) };
    const plain = { role: "user" as const, content: "thanks", toolName: "Read" };
    const [batch] = storeBatches([shot, long, plain]);
    expect(batch[0].content).toContain("[image not stored: PNG, 293 KB]");
    expect(batch[1].content).toBe("z".repeat(MAX_MESSAGE_CONTENT_CHARS) + TRUNCATION_MARKER);
    expect(batch[2]).toBe(plain);
  });

  it("fills a batch to STORE_BATCH_BYTES exactly, and no further", () => {
    // 65,535 two-byte characters, quoted: 131,072 bytes, a sixteenth of it.
    const sixteenth = { role: "user" as const, content: "é".repeat(65_535) };
    expect(Buffer.byteLength(JSON.stringify(sixteenth.content)) * 16).toBe(STORE_BATCH_BYTES);
    const full = Array(16).fill(sixteenth);
    expect(storeBatches(full).map((b) => b.length)).toEqual([16]);
    expect(storeBatches([...full, { role: "user", content: "a" }]).map((b) => b.length)).toEqual([16, 1]);
  });

  it("always sends at least one message per batch", () => {
    expect(storeBatches([]).length).toBe(0);
    expect(storeBatches(messages(1, 10)).map((b) => b.length)).toEqual([1]);
  });

  it("imports an export's long conversation in those batches, bounded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-import-bounds-"));
    try {
      // A Claude export: one conversation of 30 long pasted documents.
      const file = join(dir, "conversations.json");
      const chat_messages = Array.from({ length: 30 }, (_, i) => ({
        sender: i % 2 === 0 ? "human" : "assistant",
        text: `${i}:`.padEnd(150_000, "x"),
      }));
      writeFileSync(file, JSON.stringify([{ uuid: "c1", name: "Long", chat_messages }]));

      const sent: MessageInput[][] = [];
      const engram = {
        createConversation: async () => ({ conversationId: "conv_1", existing: false }),
        store: async (p: { messages: MessageInput[] }) => {
          sent.push(p.messages);
          return { appended: p.messages.length, messageIds: [] };
        },
      } as unknown as Engram;
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      await importHistory(engram, [file], { force: "" });

      expect(sent.map((b) => b.length)).toEqual([20, 10]);
      expect(sent.flat().map((m) => m.content)).toEqual(
        chat_messages.map((m) => m.text.slice(0, MAX_MESSAGE_CONTENT_CHARS) + TRUNCATION_MARKER),
      );
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engram store bounds the message and says what it kept (engram#750)", () => {
  afterEach(() => vi.restoreAllMocks());

  async function run(content: string) {
    const sent: MessageInput[][] = [];
    const engram = {
      store: async (p: { messages: MessageInput[] }) => {
        sent.push(p.messages);
        return { appended: 1, messageIds: ["msg_1"] };
      },
    } as unknown as Engram;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await store(engram, [content], { conversation: "conv_1" });
    return { sent: sent[0][0].content, said: errors.mock.calls.map((c) => c.join(" ")).join("\n") };
  }

  it("sends an ordinary message as typed, with no note", async () => {
    const { sent, said } = await run("remember this");
    expect(sent).toBe("remember this");
    expect(said).toBe("");
  });

  it("says nothing of a message of exactly 100,000 characters, and sends it whole", async () => {
    const { sent, said } = await run("w".repeat(MAX_MESSAGE_CONTENT_CHARS));
    expect(sent).toBe("w".repeat(MAX_MESSAGE_CONTENT_CHARS));
    expect(said).toBe("");
  });

  it("says file data is saved as a note", async () => {
    const { sent, said } = await run(toolResult(encoded("PDF", 50_000)));
    expect(sent).toContain("[PDF not stored: 49 KB]");
    expect(said).toMatch(/file data in it \(base64 images, PDFs\) is saved as a note/);
    expect(said).not.toMatch(/100,000 characters/);
  });

  it("says a long message is saved cut, and sends it cut", async () => {
    const { sent, said } = await run("w".repeat(120_000));
    expect(sent).toBe("w".repeat(MAX_MESSAGE_CONTENT_CHARS) + TRUNCATION_MARKER);
    expect(said).toMatch(/saved cut at 100,000 characters/);
    expect(said).not.toMatch(/file data/);
  });

  it("doesn't call a message cut that only its file data made long", async () => {
    const { said } = await run("see " + toolResult(encoded("PNG", 200_000)));
    expect(said).toMatch(/file data/);
    expect(said).not.toMatch(/100,000 characters/);
  });
});
