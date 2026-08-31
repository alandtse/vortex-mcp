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
// Set VORTEX_MCP_TOKEN to require `Authorization: Bearer <token>` on every request AND to
// unlock the write tools (see startMcpServer) — with no token, only read tools are ever
// registered. Host/Origin checks below are what actually stop DNS-rebinding (a page whose
// hostname resolves to 127.0.0.1); the token is a second, independent gate for writes.
const TOKEN = process.env.VORTEX_MCP_TOKEN;

function registerReadTools(server: McpServer, api: IExtensionApi): void {
  server.registerTool(
    "vortex_describe",
    {
      description:
        "Discover the live Vortex API surface: callable selector names (for vortex_query), " +
        "Vortex's action-creator names (informational), and top-level Redux state keys (for " +
        "vortex_query's path mode). Reflects whatever vortex-api version is actually running — " +
        "new selectors/state show up here without an extension rebuild.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(control.describeApi(api), null, 2) }],
    }),
  );

  server.registerTool(
    "vortex_query",
    {
      description:
        "Read Vortex state. Two modes: `selector` calls that named vortex-api selector as " +
        "`(state, ...args)` (e.g. selector='activeProfileId', or selector='profiles' then " +
        "cross-reference the id yourself); `path` walks the Redux state tree by key " +
        "(e.g. path=['persistent','mods','skyrimse']). Use vortex_describe first to see what's " +
        "available. Read-only; use list_mods for a ready-formatted mod list.",
      inputSchema: z.object({
        selector: z.string().optional(),
        args: z.array(z.unknown()).optional(),
        path: z.array(z.string()).optional(),
      }),
    },
    async ({ selector, args, path }) => {
      if (selector !== undefined) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(control.querySelector(api, selector, args), null, 2),
            },
          ],
        };
      }
      if (path !== undefined) {
        return {
          content: [
            { type: "text", text: JSON.stringify(control.queryStatePath(api, path), null, 2) },
          ],
        };
      }
      throw new Error("Provide either `selector` or `path`.");
    },
  );

  server.registerTool(
    "list_mods",
    {
      description:
        "List mods for a game (defaults to the active game), with friendly names and enabled " +
        "state for the active profile — a formatted join vortex_query can't do in one call.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [{ type: "text", text: JSON.stringify(control.listMods(api, gameId), null, 2) }],
    }),
  );
}

function registerWriteTools(server: McpServer, api: IExtensionApi): void {
  server.registerTool(
    "switch_profile",
    {
      description: "Switch Vortex to a different profile by id.",
      inputSchema: z.object({
        profileId: z.string().describe("Target profile id (query selector='profiles' to list)"),
      }),
    },
    async ({ profileId }) => {
      control.switchProfile(api, profileId);
      return { content: [{ type: "text", text: `Switched to profile ${profileId}` }] };
    },
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

  server.registerTool(
    "vortex_restart",
    {
      description:
        "Restart Vortex via its own graceful relaunch (same path as Vortex's 'Restart now' " +
        "button): closes windows and lets Vortex's normal shutdown sequence finish — " +
        "finalizing in-progress operations, flushing its database — before actually quitting. " +
        "Not a hard process kill. The MCP connection drops during restart and this server " +
        "reconnects automatically once Vortex is back up.",
      inputSchema: z.object({}),
    },
    async () => {
      // Respond before relaunching so the client sees this call succeed — win.close()
      // in Vortex's main process is asynchronous, but give the HTTP response a moment
      // to flush before triggering it regardless.
      setTimeout(() => control.restartVortex(), 200);
      return { content: [{ type: "text", text: "Restarting Vortex..." }] };
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
  registerReadTools(server, api);
  // Fail closed: writes (profile switch, mod enable/disable, deploy, purge, install,
  // game activation) are only ever registered — let alone reachable — when an operator
  // has explicitly opted in by setting a token. No token means no write tool exists to call.
  if (TOKEN !== undefined) {
    registerWriteTools(server, api);
  } else {
    log("warn", "[vortex-mcp] VORTEX_MCP_TOKEN not set — write tools disabled, read-only mode");
  }

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
