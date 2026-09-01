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
    dispatchHints: {},
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
  listCategories: vi.fn(() => []),
  listDownloads: vi.fn(() => []),
  listNotifications: vi.fn(() => []),
  listModRules: vi.fn(() => []),
  listDialogs: vi.fn(() => []),
  findModByFile: vi.fn(async () => []),
  findMissingMasters: vi.fn(async () => []),
  listRuntimeErrors: vi.fn(async () => []),
  listDuplicateMods: vi.fn(async () => []),
  listKnownModConflicts: vi.fn(() => []),
  findMissingDeployedFiles: vi.fn(async () => []),
  checkNexusModUpdates: vi.fn(async () => ({ checkedCount: 0, updatedModIds: [] })),
  listFileConflicts: vi.fn(async () => []),
  setModsEnabled: vi.fn(async () => undefined),
  launchGame: vi.fn(async () => undefined),
  restartVortex: vi.fn(),
  dispatchAction: vi.fn(async () => ({ type: "NOOP" })),
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
      expect.arrayContaining([
        "vortex_query",
        "vortex_describe",
        "list_mods",
        "list_load_order",
        "list_categories",
        "list_downloads",
        "list_notifications",
        "list_mod_rules",
        "list_dialogs",
        "find_mod_by_file",
        "list_file_conflicts",
        "find_missing_masters",
        "list_runtime_errors",
        "list_duplicate_mods",
        "list_known_mod_conflicts",
        "find_missing_deployed_files",
        "check_nexus_mod_updates",
      ]),
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

  it("returns a clean null (not a transport error) when a vortex_query path resolves to undefined", async () => {
    // querySelector/queryStatePath are mocked to return undefined above (an unresolved
    // selector/path is a legitimate result, found live) — JSON.stringify(undefined) used
    // to return the actual `undefined` value instead of a string, which failed the MCP
    // SDK's own response-schema validation (content[].text must be string) and surfaced
    // as a JSON-RPC error instead of a normal tool result. Regression test for that.
    const res = await request({
      headers: jsonHeaders,
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "vortex_query", arguments: { path: ["nonexistent", "path"] } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('"error"');
    const dataLine = res.body.split("\n").find((line) => line.startsWith("data: "));
    const parsed = JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as {
      result?: { content?: Array<{ type: string; text: string }> };
    };
    expect(parsed.result?.content?.[0]?.text).toBe("null");
  });

  it("vortex_query throws a clear error when neither selector nor path is given", async () => {
    const res = await request({
      headers: jsonHeaders,
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "vortex_query", arguments: {} },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Provide either");
  });
});
