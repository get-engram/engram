import { afterAll, beforeAll } from "vitest";
import { checkChildProcessMocks } from "../helpers/child-process.js";

// What a test file's node:child_process mocks record holds no value from
// the environment of the shell running the tests (engram#728): a failing
// assertion prints it. Checked once the file has made its mocks, before any
// test runs (vi.mock), and again after the last (vi.doMock).
async function check(): Promise<void> {
  checkChildProcessMocks(await import("node:child_process"));
}

beforeAll(check);
afterAll(check);
