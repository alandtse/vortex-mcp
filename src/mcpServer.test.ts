import http from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", () => ({
  log: vi.fn(),
}));

vi.mock("./vortexControl", () => ({
  describeApi: vi.fn(() => ({
    selectors: [],
    actions: [],
    dispatchableActions: [],
    stateKeys: [],
    extensionApis: [],
  })),
  querySelector: vi.fn(() => undefined),
  queryStatePath: vi.fn(() => undefined),
  switchProfile: vi.fn(),
  cloneProfile: vi.fn(async () => ({
    id: "new-id",
    name: "clone",
    gameId: "skyrimse",
    active: false,
  })),
  listMods: vi.fn(() => []),
  listLoadOrder: vi.fn(() => []),
  setModsEnabled: vi.fn(async () => undefined),
  deployMods: vi.fn(async () => undefined),
  purgeMods: vi.fn(async () => undefined),
  installModFromUrl: vi.fn(async () => "download-1"),
  activateGame: vi.fn(),
  restartVortex: vi.fn(),
  dispatchAction: vi.fn(() => ({ type: "NOOP" })),
  backupState: vi.fn(async () => "C:\\fake\\backup.json"),
}));

let startMcpServer: typeof import("./mcpServer").startMcpServer;
let port: number;
let server: http.Server;

function request(
  options: Partial<http.RequestOptions> & { body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const { body, ...rest } = options;
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", ...rest },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  },
};

const jsonHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function parseToolNames(body: string): string[] {
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const parsed = JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as {
    result?: { tools?: Array<{ name: string }> };
  };
  return (parsed.result?.tools ?? []).map((tool) => tool.name);
}

describe("mcpServer HTTP gating", () => {
  beforeAll(async () => {
    process.env.VORTEX_MCP_PORT = "38173";
    port = 38173;
    ({ startMcpServer } = await import("./mcpServer"));
    server = startMcpServer({} as never);
    await new Promise<void>((resolve) => server.once("listening", resolve));
  });

  afterAll(() => {
    server.close();
  });

  it("returns 404 for any path other than /mcp", async () => {
    const res = await request({ path: "/nope", headers: jsonHeaders });
    expect(res.status).toBe(404);
  });

  it("rejects a request whose Host header isn't localhost/127.0.0.1 (DNS-rebinding guard)", async () => {
    const res = await request({
      headers: { ...jsonHeaders, host: "evil.example" },
      body: initializeBody,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a request with a spoofed Origin header", async () => {
    const res = await request({
      headers: { ...jsonHeaders, origin: "http://evil.example" },
      body: initializeBody,
    });
    expect(res.status).toBe(403);
  });

  it("accepts a well-formed initialize request from localhost", async () => {
    const res = await request({ headers: jsonHeaders, body: initializeBody });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"protocolVersion"');
  });

  it("only registers read tools when VORTEX_MCP_TOKEN is unset (fail closed)", async () => {
    const res = await request({
      headers: jsonHeaders,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(res.status).toBe(200);
    const names = parseToolNames(res.body);
    expect(names).toEqual(
      expect.arrayContaining(["vortex_query", "vortex_describe", "list_mods", "list_load_order"]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "purge_mods",
        "install_mod_from_url",
        "switch_profile",
        "clone_profile",
        "vortex_dispatch",
        "backup_state",
        "vortex_restart",
      ]),
    );
  });
});
