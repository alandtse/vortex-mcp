import http from "node:http";

import { McpServer } from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import { z } from "zod";

import type { types } from "@nexusmods/vortex-api";
import { log } from "@nexusmods/vortex-api";
import * as control from "./vortexControl";

type IExtensionApi = types.IExtensionApi;

const PORT = Number(process.env.VORTEX_MCP_PORT ?? 3701);
const HOST = "127.0.0.1";
// Optional bearer token: set VORTEX_MCP_TOKEN to require `Authorization: Bearer <token>`
// on every request, in addition to the Host/Origin checks below (which are what
// actually stop DNS-rebinding — a page whose hostname resolves to 127.0.0.1).
const TOKEN = process.env.VORTEX_MCP_TOKEN;

function registerTools(server: McpServer, api: IExtensionApi): void {
  server.registerTool(
    "list_profiles",
    {
      description: "List all Vortex profiles, marking which one is active.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(control.listProfiles(api), null, 2) }],
    }),
  );

  server.registerTool(
    "get_active_profile",
    {
      description: "Get the currently active Vortex profile.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        { type: "text", text: JSON.stringify(control.getActiveProfile(api) ?? null, null, 2) },
      ],
    }),
  );

  server.registerTool(
    "switch_profile",
    {
      description: "Switch Vortex to a different profile by id.",
      inputSchema: z.object({
        profileId: z.string().describe("Target profile id, from list_profiles"),
      }),
    },
    async ({ profileId }) => {
      control.switchProfile(api, profileId);
      return { content: [{ type: "text", text: `Switched to profile ${profileId}` }] };
    },
  );

  server.registerTool(
    "list_mods",
    {
      description:
        "List mods for a game (defaults to the active game), with enabled state for the active profile.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [{ type: "text", text: JSON.stringify(control.listMods(api, gameId), null, 2) }],
    }),
  );

  server.registerTool(
    "set_mods_enabled",
    {
      description:
        "Enable or disable a set of mods for a profile (defaults to the active profile). Does not deploy.",
      inputSchema: z.object({
        modIds: z.array(z.string()).min(1),
        enabled: z.boolean(),
        profileId: z.string().optional(),
      }),
    },
    async ({ modIds, enabled, profileId }) => {
      await control.setModsEnabled(api, modIds, enabled, profileId);
      return {
        content: [
          { type: "text", text: `${enabled ? "Enabled" : "Disabled"} ${modIds.length} mod(s)` },
        ],
      };
    },
  );

  server.registerTool(
    "deploy_mods",
    {
      description: "Deploy currently enabled mods for the active profile.",
      inputSchema: z.object({}),
    },
    async () => {
      await control.deployMods(api);
      return { content: [{ type: "text", text: "Deployment complete" }] };
    },
  );

  server.registerTool(
    "purge_mods",
    {
      description: "Purge (undeploy) all deployed mod files for the active profile.",
      inputSchema: z.object({ allowFallback: z.boolean().optional().default(false) }),
    },
    async ({ allowFallback }) => {
      await control.purgeMods(api, allowFallback);
      return { content: [{ type: "text", text: "Purge complete" }] };
    },
  );

  server.registerTool(
    "install_mod_from_url",
    {
      description:
        "Download and install a mod from a URL (e.g. an nxm:// link or direct download URL).",
      inputSchema: z.object({ url: z.url() }),
    },
    async ({ url }) => {
      const downloadId = await control.installModFromUrl(api, url);
      return { content: [{ type: "text", text: `Download started: ${downloadId}` }] };
    },
  );

  server.registerTool(
    "activate_game",
    {
      description: "Switch Vortex's active game mode.",
      inputSchema: z.object({ gameId: z.string() }),
    },
    async ({ gameId }) => {
      control.activateGame(api, gameId);
      return { content: [{ type: "text", text: `Activated game ${gameId}` }] };
    },
  );
}

function isTokenAuthorized(req: http.IncomingMessage): boolean {
  if (TOKEN === undefined) {
    return true;
  }
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

export function startMcpServer(api: IExtensionApi): http.Server {
  const server = new McpServer({ name: "vortex-mcp", version: "0.1.0" });
  registerTools(server, api);

  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      return;
    }

    if (!isTokenAuthorized(req)) {
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    // Stateless: a fresh transport per request, no session bookkeeping — matches
    // the 2026-07-28 MCP spec, which dropped the initialize handshake / session id.
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log("warn", "[vortex-mcp] port already in use, assuming a prior instance is running", {
        port: PORT,
      });
      return;
    }
    log("error", "[vortex-mcp] HTTP server error", { message: err.message });
  });

  httpServer.listen(PORT, HOST, () => {
    log("info", "[vortex-mcp] MCP server listening", { url: `http://${HOST}:${PORT}/mcp` });
  });

  return httpServer;
}
