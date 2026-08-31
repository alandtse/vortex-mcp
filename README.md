# vortex-mcp

A [Vortex](https://www.nexusmods.com/about/vortex/) extension that runs an
MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server inside
Vortex, so an AI agent (Claude, etc.) can list, install, enable/disable,
deploy, and purge mods, and switch profiles/games — all through one local
endpoint, no clicking through the UI.

## Status

Scaffold stage. Unit- and integration-tested against a fake Vortex API (real
HTTP requests against the actual server, real Host/Origin/token gating,
real MCP `initialize` handshake) — see `pnpm run test`. **Not yet run inside
a real Vortex process or installed into a live `plugins` folder.** Load-order
control is not yet implemented.

## Stack

- TypeScript, bundled to a single CommonJS `dist/index.js` via `tsup`
- `@modelcontextprotocol/server` + `@modelcontextprotocol/node` — official MCP
  TypeScript SDK v2, implementing the
  [2026-07-28 MCP spec](https://modelcontextprotocol.io/specification/2026-07-28)
  (stateless Streamable HTTP — no `initialize` handshake session or session id)
- `@nexusmods/vortex-api` — Vortex's published extension API
- `vitest` for tests, `oxlint`/`oxfmt` for lint/format (matches Vortex's own
  toolchain)

## Install

```sh
pnpm install
pnpm run ci               # typecheck + lint + format:check + test + build
pnpm run install-plugin   # copy dist/ + info.json into %APPDATA%\vortex\plugins\vortex-mcp
```

Restart Vortex. The MCP server listens on `http://127.0.0.1:3701/mcp`
(override with `VORTEX_MCP_PORT`). There's no packaged zip/release yet —
`install-plugin` is a straight directory copy for local development.

## Connect an MCP client

Streamable HTTP, so most clients connect natively:

```sh
claude mcp add --transport http vortex http://127.0.0.1:3701/mcp
```

For a stdio-only client, bridge with the off-the-shelf `mcp-remote`:
`{ "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:3701/mcp"] }`

## Tools

| Tool                    | What it does                                                              |
| ------------------------ | -------------------------------------------------------------------------- |
| `list_profiles`         | List all profiles, marking which one is active.                          |
| `get_active_profile`    | Get the currently active profile.                                        |
| `switch_profile`        | Switch to a different profile by id.                                     |
| `list_mods`             | List mods for a game (defaults to active), with enabled state.           |
| `set_mods_enabled`      | Enable/disable a set of mods for a profile. Does not deploy.             |
| `deploy_mods`           | Deploy currently enabled mods for the active profile.                    |
| `purge_mods`            | Purge (undeploy) all deployed mod files for the active profile.          |
| `install_mod_from_url`  | Download and install a mod from a URL (e.g. an `nxm://` link).           |
| `activate_game`         | Switch Vortex's active game mode.                                        |

## Architecture

- `src/vortexControl.ts` — thin wrapper around `@nexusmods/vortex-api`
  selectors/actions (`switchProfile`, `setModsEnabled`) and Vortex's internal
  event bus (`api.events.emit`) for `deploy-mods`/`purge-mods`/`start-download`/
  `activate-game`, which have no plain dispatchable-action equivalent — this
  is the same interface Vortex uses internally to trigger them.
- `src/mcpServer.ts` — MCP tool definitions + a `NodeStreamableHTTPServerTransport`
  HTTP server, bound to `127.0.0.1` only. Stateless: a fresh transport is
  connected to the shared `McpServer` per request (`sessionIdGenerator:
  undefined`), matching the 2026-07-28 spec's removal of sessions — there is
  no session state to leak, TTL, or clobber across requests.
- `src/index.ts` — the Vortex extension entry point (`context.once`). This
  has to run in the renderer process: the event listeners and Redux store
  this extension talks to are all renderer-side, so `onceMain` would produce
  a server that reads/writes nothing real.

## Safety

Bound to `127.0.0.1` only; `localhostHostValidation()` / `localhostOriginValidation()`
(from `@modelcontextprotocol/node`) reject any request whose `Host`/`Origin`
hostname isn't `localhost`/`127.0.0.1`/`[::1]` — this, not the loopback bind
alone, is what stops a DNS-rebinding page from reaching the server as
same-origin. Set `VORTEX_MCP_TOKEN` to additionally require `Authorization:
Bearer <token>` on every request.

There is otherwise **no authorization model** — any tool call an agent makes
executes with full Vortex privileges, including `purge_mods` (deletes
deployed game files) and `install_mod_from_url` (downloads and installs
arbitrary content). Acceptable for a local single-user tool; do not bind
this to a non-loopback address.

## License

GPL-3.0-only, matching Vortex core and `@nexusmods/vortex-api` (both
GPL-3.0-only with no extension-linking exception).
