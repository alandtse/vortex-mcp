import http from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", () => ({
  log: vi.fn(),
}));

vi.mock("./vortexControl", () => ({
  listProfiles: vi.fn(() => []),
}));

let port: number;
let server: http.Server;

function request(headers: http.OutgoingHttpHeaders): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    );
    req.end();
  });
}

describe("mcpServer bearer token gating", () => {
  beforeAll(async () => {
    process.env.VORTEX_MCP_PORT = "38174";
    process.env.VORTEX_MCP_TOKEN = "test-secret";
    port = 38174;
    const { startMcpServer } = await import("./mcpServer");
    server = startMcpServer({} as never);
    await new Promise<void>((resolve) => server.once("listening", resolve));
  });

  afterAll(() => {
    server.close();
    delete process.env.VORTEX_MCP_TOKEN;
  });

  const jsonHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  it("rejects a request with no Authorization header", async () => {
    const res = await request(jsonHeaders);
    expect(res.status).toBe(403);
  });

  it("rejects a request with the wrong token", async () => {
    const res = await request({ ...jsonHeaders, authorization: "Bearer wrong" });
    expect(res.status).toBe(403);
  });

  it("accepts a request with the correct bearer token", async () => {
    const res = await request({ ...jsonHeaders, authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
  });
});
