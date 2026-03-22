import { describe, it, expect } from "vitest";
import { generateId, generateApiKeyRaw } from "../utils/id.js";

describe("generateId", () => {
  it("generates an id with org_ prefix", () => {
    const id = generateId("org");
    expect(id).toMatch(/^org_/);
    expect(id.length).toBe(4 + 21); // "org_" + 21 chars
  });

  it("generates an id with conv_ prefix", () => {
    const id = generateId("conv");
    expect(id).toMatch(/^conv_/);
    expect(id.length).toBe(5 + 21);
  });

  it("generates an id with msg_ prefix", () => {
    const id = generateId("msg");
    expect(id).toMatch(/^msg_/);
    expect(id.length).toBe(4 + 21);
  });

  it("generates an id with key_ prefix", () => {
    const id = generateId("key");
    expect(id).toMatch(/^key_/);
  });

  it("generates an id with chk_ prefix", () => {
    const id = generateId("chk");
    expect(id).toMatch(/^chk_/);
  });

  it("respects custom size", () => {
    const id = generateId("org", 10);
    expect(id).toMatch(/^org_/);
    expect(id.length).toBe(4 + 10);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId("msg")));
    expect(ids.size).toBe(100);
  });
});

describe("generateApiKeyRaw", () => {
  it("returns raw key with maas_sk_live_ prefix", () => {
    const { raw, prefix } = generateApiKeyRaw();
    expect(raw).toMatch(/^maas_sk_live_/);
    expect(raw.length).toBe(13 + 32); // "maas_sk_live_" + 32 chars
  });

  it("returns first 20 chars as prefix", () => {
    const { raw, prefix } = generateApiKeyRaw();
    expect(prefix).toBe(raw.slice(0, 20));
    expect(prefix.length).toBe(20);
  });

  it("generates unique keys", () => {
    const keys = new Set(
      Array.from({ length: 50 }, () => generateApiKeyRaw().raw)
    );
    expect(keys.size).toBe(50);
  });
});
