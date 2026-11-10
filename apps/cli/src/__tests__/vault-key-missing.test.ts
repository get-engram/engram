import { describe, expect, it, vi } from "vitest";
import type { Account } from "../daemon/syncer.js";
import { MissingVaultKey } from "../daemon/vault-key-missing.js";

/**
 * engram#698 — a daemon with no vault key asks whether the account's vault
 * holds secrets it can't remove the values of: how many goes to status.json
 * and the log, never a name. Nothing here reaches a server: the count is a
 * fake.
 */

const A: Account = { key: "engram_sk_test_698_a", server: "http://127.0.0.1:9" };
const B: Account = { key: "engram_sk_test_698_b", server: "http://127.0.0.1:9" };

const TWO =
  "vault scrubber: off, and this account's vault has 2 secrets — with no vault key, their values " +
  "aren't removed from what is captured. Put the key in ~/.engram/vault-key (engram vault save-key): " +
  "it is read before the next send.";
const ONE =
  "vault scrubber: off, and this account's vault has 1 secret — with no vault key, its value " +
  "isn't removed from what is captured. Put the key in ~/.engram/vault-key (engram vault save-key): " +
  "it is read before the next send.";

/** A count that answers when told to. */
function deferred() {
  let answer!: (n: number) => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<number>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  return { promise, answer, fail };
}

/** A check, with what it recorded and said, and the accounts it listed. */
function made(keyless = true) {
  const recorded: (number | null)[] = [];
  const said: string[] = [];
  const listed: (Account | undefined)[] = [];
  const answers: (Promise<number> | number | Error)[] = [];
  const count = vi.fn(async (account: Account) => {
    listed.push(account);
    const next = answers.shift();
    if (next === undefined) throw new Error("no answer queued");
    if (next instanceof Error) throw next;
    return next;
  });
  const missing = new MissingVaultKey(
    count,
    (secrets) => void recorded.push(secrets),
    (msg) => void said.push(msg),
    keyless,
  );
  return { missing, recorded, said, listed, answers, count };
}

describe("a daemon with no vault key, and the vault's secrets (engram#698)", () => {
  it("records and says how many, once", async () => {
    const { missing, recorded, said, listed, answers } = made();
    answers.push(2, 2);
    await missing.check(A);
    expect(recorded).toEqual([2]);
    expect(said).toEqual([TWO]);
    // The same again: nothing written or said again.
    await missing.check(A);
    expect(recorded).toEqual([2]);
    expect(said).toEqual([TWO]);
    expect(listed).toEqual([A, A]);
  });

  it("says it in the log before status.json records it: whoever finds the count there finds the line", async () => {
    const order: string[] = [];
    const answers = [3];
    const missing = new MissingVaultKey(
      async () => answers.shift() ?? 0,
      (secrets) => void order.push(`recorded ${secrets}`),
      (msg) => void order.push(msg.includes("3 secrets") ? "said 3" : msg),
      true,
    );
    await missing.check(A);
    expect(order).toEqual(["said 3", "recorded 3"]);
    // Nothing to say: recorded only.
    missing.keyFound();
    expect(order).toEqual(["said 3", "recorded 3", "recorded null"]);
  });

  it("says one as one", async () => {
    const { missing, recorded, said, answers } = made();
    answers.push(1);
    await missing.check(A);
    expect(recorded).toEqual([1]);
    expect(said).toEqual([ONE]);
  });

  it("records and says nothing for a vault with none, or a count that isn't one", async () => {
    const { missing, recorded, said, answers } = made();
    answers.push(0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53);
    for (let i = 0; i < 6; i++) await missing.check(A);
    expect(recorded).toEqual([]);
    expect(said).toEqual([]);
  });

  it("records none once the vault has none any more, and says nothing of it", async () => {
    const { missing, recorded, said, answers } = made();
    answers.push(3, 0, 1);
    await missing.check(A);
    await missing.check(A);
    expect(recorded).toEqual([3, null]);
    expect(said).toHaveLength(1);
    // Some again: said again.
    await missing.check(A);
    expect(recorded).toEqual([3, null, 1]);
    expect(said).toEqual([said[0], ONE]);
  });

  it("never lists with a key", async () => {
    const { missing, recorded, said, count } = made(false);
    await missing.check(A);
    await missing.check(B);
    await missing.check(undefined);
    expect(count).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    expect(said).toEqual([]);
  });

  it("records none when a key is found, lists no more, and drops an answer in flight", async () => {
    const { missing, recorded, said, answers, count } = made();
    answers.push(2);
    await missing.check(A);
    const late = deferred();
    answers.push(late.promise);
    const checking = missing.check(A);
    missing.keyFound();
    expect(recorded).toEqual([2, null]);
    late.answer(4);
    await checking;
    await missing.check(A);
    await missing.check(B);
    expect(recorded).toEqual([2, null]);
    expect(said).toEqual([TWO]);
    expect(count).toHaveBeenCalledTimes(2);
    // Again, or with nothing recorded: nothing more to write.
    missing.keyFound();
    expect(recorded).toEqual([2, null]);
  });

  it("drops an answer in flight when a key is found with nothing recorded yet", async () => {
    const { missing, recorded, said, answers } = made();
    const late = deferred();
    answers.push(late.promise);
    const checking = missing.check(A);
    missing.keyFound();
    late.answer(2);
    await checking;
    expect(recorded).toEqual([]);
    expect(said).toEqual([]);
  });

  it("changes nothing when the list fails, and never says why", async () => {
    const { missing, recorded, said, answers } = made();
    answers.push(2, new Error("fetch failed: connect ECONNREFUSED http://127.0.0.1:9"));
    await missing.check(A);
    await expect(missing.check(A)).resolves.toBeUndefined();
    expect(recorded).toEqual([2]);
    expect(said).toEqual([TWO]);
    // A list that fails with nothing recorded: still nothing.
    const other = made();
    other.answers.push(new Error("401 Unauthorized"));
    await expect(other.missing.check(A)).resolves.toBeUndefined();
    expect(other.recorded).toEqual([]);
    expect(other.said).toEqual([]);
  });

  it("forgets one account's at once for another's, and drops a late answer about it", async () => {
    const { missing, recorded, said, listed, answers } = made();
    answers.push(2);
    await missing.check(A);
    const aLate = deferred();
    const bAnswer = deferred();
    answers.push(aLate.promise, bAnswer.promise);
    const checkingA = missing.check(A);
    const checkingB = missing.check(B);
    // Before B's answer: nothing said for B yet.
    expect(recorded).toEqual([2, null]);
    aLate.answer(5);
    await checkingA;
    expect(recorded).toEqual([2, null]);
    bAnswer.answer(1);
    await checkingB;
    expect(recorded).toEqual([2, null, 1]);
    expect(said).toEqual([TWO, ONE]);
    expect(listed).toEqual([A, A, B]);
  });

  it("never lets an earlier check's answer replace a later one's", async () => {
    const { missing, recorded, answers } = made();
    answers.push(2);
    await missing.check(A);
    const first = deferred();
    const second = deferred();
    answers.push(first.promise, second.promise);
    const checkingFirst = missing.check(A);
    const checkingSecond = missing.check(A);
    second.answer(0);
    await checkingSecond;
    expect(recorded).toEqual([2, null]);
    first.answer(3);
    await checkingFirst;
    expect(recorded).toEqual([2, null]);
    // In order, each is kept.
    const third = deferred();
    const fourth = deferred();
    answers.push(third.promise, fourth.promise);
    const checkingThird = missing.check(A);
    const checkingFourth = missing.check(A);
    third.answer(4);
    await checkingThird;
    expect(recorded).toEqual([2, null, 4]);
    fourth.answer(5);
    await checkingFourth;
    expect(recorded).toEqual([2, null, 4, 5]);
  });

  it("an earlier check's answer counts when the later one failed", async () => {
    const { missing, recorded, answers } = made();
    const first = deferred();
    answers.push(first.promise, new Error("fetch failed"));
    const checkingFirst = missing.check(A);
    await missing.check(A);
    first.answer(2);
    await checkingFirst;
    expect(recorded).toEqual([2]);
  });

  it("has nothing to say signed out, and lists nothing then", async () => {
    const { missing, recorded, said, listed, answers } = made();
    answers.push(2);
    await missing.check(A);
    await missing.check(undefined);
    expect(recorded).toEqual([2, null]);
    expect(listed).toEqual([A]);
    // A late answer from before signing out: dropped.
    const late = deferred();
    answers.push(late.promise);
    const checking = missing.check(A);
    await missing.check(undefined);
    late.answer(3);
    await checking;
    expect(recorded).toEqual([2, null]);
    // Signed in again: asked, and said, again.
    answers.push(2);
    await missing.check(A);
    expect(recorded).toEqual([2, null, 2]);
    expect(said).toEqual([TWO, TWO]);
  });

  it("starts signed out: nothing to list, and nothing recorded", async () => {
    const { missing, recorded, count } = made();
    await missing.check(undefined);
    expect(count).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it("never throws when writing status.json or the log does", async () => {
    const said: string[] = [];
    let writes = 0;
    const answers = [2, 0, 3];
    const missing = new MissingVaultKey(
      async () => answers.shift() ?? 0,
      () => {
        writes++;
        throw new Error("EACCES: status.json");
      },
      (msg) => {
        said.push(msg);
        throw new Error("EPIPE: log");
      },
      true,
    );
    await expect(missing.check(A)).resolves.toBeUndefined();
    await expect(missing.check(A)).resolves.toBeUndefined();
    await expect(missing.check(A)).resolves.toBeUndefined();
    expect(() => missing.keyFound()).not.toThrow();
    // Each change was still tried, once.
    expect(writes).toBe(4);
    expect(said).toHaveLength(2);
  });
});
