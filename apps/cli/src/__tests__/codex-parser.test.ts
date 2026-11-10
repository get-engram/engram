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
  for (const l of lines) parser.processLine(JSON.stringify(l), filePath, 0);
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

/**
 * engram#583 — a subagent's rollout copies its parent's history in before
 * its own turns, and its messages go to the parent's conversation, which
 * the parent's own rollout has already filled. A paginated rollout numbers
 * its records from 0, and the subagent's session_meta (record 0) says which
 * record is its own first: subagent_history_start_ordinal.
 */
describe("a subagent's copy of its parent's history (engram#583)", () => {
  const ROOT = "019f8e95-d0a3-70f3-88af-5f96100f86be";
  const SUB = "019f8e97-aaaa-7bbb-8ccc-9ddddeeeefff";
  const MID = "019f8e96-1111-7222-8333-944455556666";
  const SUB_PATH = `/Users/x/.codex/sessions/2026/11/09/rollout-2026-11-09T10-00-00-${SUB}.jsonl`;

  /** A paginated rollout's record, numbered as Codex numbers it. */
  const numbered = (ordinal: unknown, record: object) => ({
    timestamp: "2026-11-09T10:00:00.000Z",
    ordinal,
    ...record,
  });
  /** Record 0, the subagent's own session_meta; record 1, its parent's, copied in. */
  const heads = (start: unknown, parentStart?: unknown) => [
    numbered(0, {
      type: "session_meta",
      payload: { id: SUB, session_id: ROOT, cwd: "/work/proj", subagent_history_start_ordinal: start },
    }),
    numbered(1, {
      type: "session_meta",
      payload: {
        id: parentStart === undefined ? ROOT : MID,
        session_id: ROOT,
        cwd: "/work/proj",
        ...(parentStart === undefined ? {} : { subagent_history_start_ordinal: parentStart }),
      },
    }),
  ];
  const texts = (out: ReturnType<typeof run>) => out.map((o) => o.messages[0].content);

  it("skips the parent's messages it copied in, and captures its own under the parent's session", () => {
    const out = run(
      [
        ...heads(6),
        numbered(2, turnCtx),
        numbered(3, userMsg("parent's question")),
        numbered(4, asstMsg("parent's answer")),
        numbered(5, userMsg("parent: hand this to a subagent")),
        numbered(6, userMsg("the subagent's task")),
        numbered(7, asstMsg("the subagent's answer")),
      ],
      SUB_PATH,
    );
    expect(texts(out)).toEqual(["the subagent's task", "the subagent's answer"]);
    expect(out.map((o) => [o.sessionId, o.meta.cwd])).toEqual([
      [ROOT, "/work/proj"],
      [ROOT, "/work/proj"],
    ]);
  });

  it("goes by its own session_meta's boundary, not the one in its parent's, copied in after it", () => {
    // A subagent of a subagent: the session_meta copied in is its parent's,
    // with the boundary that counts in the parent's own file, before or
    // after this one's.
    for (const parentStart of [3, 50]) {
      const out = run(
        [
          ...heads(6, parentStart),
          numbered(2, userMsg("root's question")),
          numbered(3, asstMsg("root's answer")),
          numbered(4, userMsg("the parent subagent's task")),
          numbered(5, asstMsg("the parent subagent's answer")),
          numbered(6, userMsg("this subagent's task")),
          numbered(7, asstMsg("this subagent's answer")),
        ],
        SUB_PATH,
      );
      expect(texts(out), `parent's boundary ${parentStart}`).toEqual([
        "this subagent's task",
        "this subagent's answer",
      ]);
    }
  });

  it("captures a legacy rollout's copy as before: with no numbers, there is no boundary to go by", () => {
    const out = run(
      [
        { type: "session_meta", payload: { id: SUB, session_id: ROOT, cwd: "/work/proj" } },
        { type: "session_meta", payload: { id: ROOT, cwd: "/work/proj" } },
        userMsg("parent's question"),
        userMsg("the subagent's task"),
      ],
      SUB_PATH,
    );
    expect(texts(out)).toEqual(["parent's question", "the subagent's task"]);
  });

  it("keeps a message with no number, or one that isn't a number, wherever it is", () => {
    const out = run(
      [
        ...heads(6),
        userMsg("unnumbered, among the copied ones"),
        numbered(2, userMsg("parent's question")),
        numbered("3", userMsg("numbered with a string")),
        numbered(null, userMsg("numbered with null")),
        numbered(6, userMsg("the subagent's task")),
      ],
      SUB_PATH,
    );
    expect(texts(out)).toEqual([
      "unnumbered, among the copied ones",
      "numbered with a string",
      "numbered with null",
      "the subagent's task",
    ]);
  });

  it("captures every message of a rollout with no boundary: a session of its own, or a fork", () => {
    const root = run([numbered(0, sessionMeta), numbered(1, userMsg("q")), numbered(2, asstMsg("a"))]);
    expect(texts(root)).toEqual(["q", "a"]);
    // A paginated fork's file holds only its own records, numbered on from
    // the end of the parent's history it goes by (history_base).
    const fork = run(
      [
        numbered(40, {
          type: "session_meta",
          payload: {
            id: SUB,
            session_id: SUB,
            forked_from_id: ROOT,
            history_base: { thread_id: ROOT, end_ordinal_exclusive: 40, end_byte_offset: 9000 },
          },
        }),
        numbered(41, userMsg("forked question")),
      ],
      SUB_PATH,
    );
    expect(texts(fork)).toEqual(["forked question"]);
  });

  it("skips nothing by a boundary that isn't a whole number above 0", () => {
    for (const start of [0, -1, 2.5, "3", null, true, 2 ** 53, { ordinal: 3 }]) {
      const out = run([...heads(start), numbered(2, userMsg("one")), numbered(3, userMsg("two"))], SUB_PATH);
      expect(texts(out), JSON.stringify(start)).toEqual(["one", "two"]);
    }
  });

  it("keeps the boundary to the subagent's own file", () => {
    const out: string[] = [];
    const parser = new CodexParser((_s, _m, messages) => out.push(messages[0].content));
    const ROOT_PATH = `/Users/x/.codex/sessions/2026/11/09/rollout-2026-11-09T09-00-00-${ROOT}.jsonl`;
    const line = (path: string, record: object) => parser.processLine(JSON.stringify(record), path, 0);
    for (const record of heads(6)) line(SUB_PATH, record);
    line(ROOT_PATH, numbered(0, { type: "session_meta", payload: { id: ROOT, session_id: ROOT } }));
    line(SUB_PATH, numbered(2, userMsg("copied")));
    line(ROOT_PATH, numbered(2, userMsg("the root's own, numbered 2")));
    line(SUB_PATH, numbered(6, userMsg("the subagent's own")));
    line(ROOT_PATH, numbered(5, asstMsg("the root's own, numbered 5")));
    expect(out).toEqual(["the root's own, numbered 2", "the subagent's own", "the root's own, numbered 5"]);
  });

  it("goes by the latest record 0 read for a file, so one written over doesn't keep an old boundary", () => {
    // The watcher doesn't read a file from the start again today. If it ever
    // does, for a file written over, a stale boundary would drop the new
    // session's first messages.
    const out: string[] = [];
    const parser = new CodexParser((_s, _m, messages) => out.push(messages[0].content));
    const line = (record: object) => parser.processLine(JSON.stringify(record), SUB_PATH, 0);
    for (const record of heads(6)) line(record);
    line(numbered(0, { type: "session_meta", payload: { id: SUB, session_id: SUB, cwd: "/work/proj" } }));
    line(numbered(1, userMsg("a new session's first question")));
    expect(out).toEqual(["a new session's first question"]);
  });

  it("restoreLine brings the boundary back from record 0, and only from record 0", () => {
    const [own, parents] = heads(6, 50);
    // A new process reading on, from part-way into the copy.
    const out: string[] = [];
    const resumed = new CodexParser((_s, _m, messages) => out.push(messages[0].content));
    resumed.restoreLine(JSON.stringify(own), SUB_PATH);
    resumed.restoreLine(JSON.stringify(parents), SUB_PATH);
    resumed.processLine(JSON.stringify(numbered(5, userMsg("copied"))), SUB_PATH, 0);
    resumed.processLine(JSON.stringify(numbered(6, userMsg("own"))), SUB_PATH, 0);
    expect(out).toEqual(["own"]);

    // One that got only the parent's session_meta back (the file's first
    // line too long for its head window) has no boundary: it skips nothing.
    out.length = 0;
    const tailOnly = new CodexParser((_s, _m, messages) => out.push(messages[0].content));
    tailOnly.restoreLine(JSON.stringify(parents), SUB_PATH);
    tailOnly.processLine(JSON.stringify(numbered(5, userMsg("copied"))), SUB_PATH, 0);
    tailOnly.processLine(JSON.stringify(numbered(6, userMsg("own"))), SUB_PATH, 0);
    expect(out).toEqual(["copied", "own"]);
  });
});
