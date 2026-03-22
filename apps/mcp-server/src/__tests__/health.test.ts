import { describe, it, expect } from "vitest";
import app from "../index.js";

describe("Health endpoint", () => {
  it("returns 200 with status ok", async () => {
    const response = await app.fetch(
      new Request("http://localhost/health")
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      service: "engram-mcp-server",
      version: "0.1.0",
    });
  });

  it("returns 404 for unknown routes", async () => {
    const response = await app.fetch(
      new Request("http://localhost/nonexistent")
    );
    expect(response.status).toBe(404);
  });
});
