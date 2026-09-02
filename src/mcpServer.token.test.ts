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
  pollListener: vi.fn(() => ({ entries: [], lastSeq: 0 })),
  backupState: vi.fn(async () => "C:\\fake\\backup.json"),
}));

import { dispatchAction } from "./vortexControl";

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

function parseToolNames(body: string): string[] {
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const parsed = JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as {
    result?: { tools?: Array<{ name: string }> };
  };
  return (parsed.result?.tools ?? []).map((tool) => tool.name);
}

describe("mcpServer bearer token gating", () => {
  beforeAll(async () => {
    process.env.VORTEX_MCP_PORT = "38174";
    process.env.VORTEX_MCP_TOKEN = "test-secret";
    port = 38174;
    const { startMcpServer } = await import("./mcpServer");
    server = startMcpServer({ getState: () => ({ confidential: {} }) } as never);
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
    const names = parseToolNames(res.body);
    expect(names).toEqual(
      expect.arrayContaining([
        "switch_profile",
        "clone_profile",
        "vortex_dispatch",
        "poll_listener",
        "backup_state",
        "launch_game",
        "vortex_restart",
      ]),
    );
    // deploy_mods/purge_mods/install_mod_from_url/activate_game were removed as dedicated
    // tools once vortex_dispatch's event/apiMethods fallback tiers made them fully
    // expressible generically (e.g. action="deploy-mods", args=["__CALLBACK__"]).
    expect(names).not.toEqual(
      expect.arrayContaining([
        "deploy_mods",
        "purge_mods",
        "install_mod_from_url",
        "activate_game",
      ]),
    );
  });

  it("vortex_dispatch passes any action/api.ext name through to dispatchAction, not just a curated subset", async () => {
    const res = await request(
      { ...jsonHeaders, authorization: "Bearer test-secret" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "vortex_dispatch",
          arguments: { action: "nexusGetModInfo", args: ["skyrimse", 63979] },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(dispatchAction).toHaveBeenCalledWith(expect.anything(), "nexusGetModInfo", [
      "skyrimse",
      63979,
    ]);
  });
});
