import { describe, it, expect } from "vitest";
import { CodexParser } from "../daemon/codex-parser.js";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

const PATH =
  "/Users/x/.codex/sessions/2026/07/23/rollout-2026-07-23T04-46-50-019f8e95-d0a3-70f3-88af-5f96100f86be.jsonl";

function run(lines: object[], filePath = PATH) {
  const out: { sessionId: string; meta: SessionMeta; messages: ParsedMessage[] }[] = [];
  const parser = new CodexParser((sessionId, meta, messages) =>
    out.push({ sessionId, meta, messages }),
  );
  for (const l of lines) parser.processLine(JSON.stringify(l), filePath);
  parser.flush();
  return out;
}

const sessionMeta = {
  type: "session_meta",
  payload: { session_id: "sess-1", id: "sess-1" },
};
const turnCtx = { type: "turn_context", payload: { turn_id: "t1", cwd: "/work/proj" } };
const userMsg = (t: string) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: t }] },
});
const asstMsg = (t: string) => ({
  type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "text", text: t }] },
});

describe("CodexParser (engram#261)", () => {
  it("extracts user + assistant messages with session id, cwd, and host", () => {
    const out = run([sessionMeta, turnCtx, userMsg("hello"), asstMsg("hi there")]);
    expect(out.map((o) => o.messages[0])).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(out[0].sessionId).toBe("sess-1");
    expect(out[0].meta.host).toBe("codex");
    expect(out[1].meta.cwd).toBe("/work/proj");
  });

  it("skips developer/tool roles and Codex's injected context blocks", () => {
    const out = run([
      sessionMeta,
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ text: "sys" }] } },
      userMsg("<environment_context>\ncwd: /x"),
      userMsg("<recommended_plugins>\n- foo"),
      userMsg("a real question"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].messages[0].content).toBe("a real question");
  });

  it("skips non-message record types (event_msg, world_state)", () => {
    const out = run([
      sessionMeta,
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "world_state", payload: { full: true } },
      asstMsg("done"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("falls back to the uuid in the filename when session_meta is missing (mid-file read)", () => {
    const out = run([userMsg("mid-file start")]);
    expect(out[0].sessionId).toBe("019f8e95-d0a3-70f3-88af-5f96100f86be");
  });
});
