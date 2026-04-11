import { EngramError, AuthenticationError, TimeoutError } from "./errors.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | null;
  result?: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: {
    code: number;
    message: string;
  };
}

export class McpTransport {
  private requestId = 0;
  private sessionId: string | null = null;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private timeout: number,
  ) {}

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method: "tools/call",
      params: { name, arguments: args },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new TimeoutError();
      }
      throw new EngramError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError();
    }

    // Capture session ID from response headers
    const sid = response.headers.get("Mcp-Session-Id");
    if (sid) {
      this.sessionId = sid;
    }

    const body = await response.text();

    // Parse SSE response — the server returns "event: message\ndata: {...}"
    const parsed = this.parseResponse(body);

    if (parsed.error) {
      throw new EngramError(
        parsed.error.message,
        String(parsed.error.code),
        response.status,
      );
    }

    if (!parsed.result) {
      throw new EngramError("Empty response from server");
    }

    if (parsed.result.isError) {
      const text = parsed.result.content[0]?.text ?? "Unknown error";
      throw new EngramError(text);
    }

    return parsed.result.content[0]?.text ?? "{}";
  }

  private parseResponse(body: string): JsonRpcResponse {
    // Try direct JSON first
    try {
      return JSON.parse(body);
    } catch {
      // Parse SSE format: "event: message\ndata: {...}"
    }

    const lines = body.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        try {
          return JSON.parse(data);
        } catch {
          continue;
        }
      }
    }

    throw new EngramError(`Unexpected response format: ${body.slice(0, 200)}`);
  }
}
