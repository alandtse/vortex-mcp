import http from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", () => ({
  log: vi.fn(),
}));

vi.mock("./vortexControl", () => ({
  describeApi: vi.fn(() => ({ selectors: [], actions: [], stateKeys: [] })),
  querySelector: vi.fn(() => undefined),
  queryStatePath: vi.fn(() => undefined),
  switchProfile: vi.fn(),
  listMods: vi.fn(() => []),
  setModsEnabled: vi.fn(async () => undefined),
  deployMods: vi.fn(async () => undefined),
  purgeMods: vi.fn(async () => undefined),
  installModFromUrl: vi.fn(async () => "download-1"),
  activateGame: vi.fn(),
}));

let port: number;
let server: http.Server;

function request(
  headers: http.OutgoingHttpHeaders,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.write(
      JSON.stringify(
        body ?? {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2026-07-28",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        },
      ),
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

  it("registers write tools once a token is configured", async () => {
    const res = await request(
      { ...jsonHeaders, authorization: "Bearer test-secret" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain("purge_mods");
    expect(res.body).toContain("switch_profile");
    expect(res.body).toContain("install_mod_from_url");
  });
});
