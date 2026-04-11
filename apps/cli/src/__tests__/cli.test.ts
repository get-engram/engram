import { describe, it, expect } from "vitest";

describe("CLI", () => {
  it("exports all command modules", async () => {
    const auth = await import("../commands/auth.js");
    expect(auth.authLogin).toBeDefined();
    expect(auth.authLogout).toBeDefined();
    expect(auth.authStatus).toBeDefined();
  });

  it("exports conversation commands", async () => {
    const convs = await import("../commands/conversations.js");
    expect(convs.listConversations).toBeDefined();
    expect(convs.createConversation).toBeDefined();
    expect(convs.getConversation).toBeDefined();
    expect(convs.deleteConversation).toBeDefined();
  });

  it("exports store command", async () => {
    const { store } = await import("../commands/store.js");
    expect(store).toBeDefined();
  });

  it("exports search command", async () => {
    const { search } = await import("../commands/search.js");
    expect(search).toBeDefined();
  });

  it("output helpers format correctly", async () => {
    const { bold, dim, green, red, cyan } = await import("../output.js");
    expect(bold("test")).toContain("test");
    expect(dim("test")).toContain("test");
    expect(green("test")).toContain("test");
    expect(red("test")).toContain("test");
    expect(cyan("test")).toContain("test");
  });
});
