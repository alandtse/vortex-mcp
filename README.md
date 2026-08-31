# vortex-mcp

A [Vortex](https://www.nexusmods.com/about/vortex/) extension that runs an
MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server inside
Vortex, so an AI agent (Claude, etc.) can list, install, enable/disable,
deploy, and purge mods, and switch profiles/games — all through one local
endpoint, no clicking through the UI.

## Status

Unit- and integration-tested (real HTTP requests against the actual server,
real Host/Origin/token gating, real MCP `initialize` handshake) — see
`pnpm run test`. Verified working against a real, live Vortex install:
profile clone/switch, mod listing/filtering (a real 692-mod profile),
load-order reads, and generic action dispatch all confirmed against real
state.

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

Read tools are always available. Write tools only exist — `tools/list` won't
even show them — when `VORTEX_MCP_TOKEN` is set (see [Safety](#safety)).

| Tool                   | Access | What it does                                                                                                                                                        |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vortex_describe`      | read   | Discover live selector/action names and state-tree keys — no rebuild needed for new vortex-api surface.                                                             |
| `vortex_query`         | read   | Call a named selector, or walk the Redux state tree by path. General-purpose read.                                                                                  |
| `list_mods`            | read   | Mods for a game with friendly names and enabled state — a join `vortex_query` can't do in one call. Supports `enabledOnly`/`nameFilter`/`limit` for large modlists. |
| `list_load_order`      | read   | Current Gamebryo/LOOT plugin load order (.esp/.esm/.esl), sorted by index.                                                                                          |
| `list_categories`      | read   | A game's mod categories sorted by display order, with a mod count per category.                                                                                     |
| `switch_profile`       | write  | Switch to a different profile by id.                                                                                                                                |
| `clone_profile`        | write  | Clone a profile into a new one (on-disk directory + mod state) — Vortex's own "Clone" operation.                                                                    |
| `vortex_dispatch`      | write  | Dispatch a named, allowlisted action creator — mod/category/load-order/deployment/download actions.                                                                 |
| `backup_state`         | write  | Write a full state snapshot to Vortex's own backup folder — reproduces Vortex's un-exported backup fn.                                                              |
| `set_mods_enabled`     | write  | Enable/disable a set of mods for a profile. Does not deploy.                                                                                                        |
| `deploy_mods`          | write  | Deploy currently enabled mods for the active profile.                                                                                                               |
| `purge_mods`           | write  | Purge (undeploy) all deployed mod files for the active profile.                                                                                                     |
| `install_mod_from_url` | write  | Download and install a mod from a URL (e.g. an `nxm://` link).                                                                                                      |
| `activate_game`        | write  | Switch Vortex's active game mode.                                                                                                                                   |
| `vortex_restart`       | write  | Restart Vortex via its own graceful relaunch (Vortex's "Restart now" path) — not a hard process kill.                                                               |

`vortex_describe`/`vortex_query` deliberately replace the old one-tool-per-
selector design (`list_profiles`, `get_active_profile`) — an
[agentic-renderdoc](https://github.com/EdenLabs/agentic-renderdoc#why-this-design)-style
choice: fewer, richer read primitives over reflection on the live
`@nexusmods/vortex-api` namespace, rather than a named MCP tool (and a
rebuild) per selector. `list_mods` stays hand-written because it performs a
real join (mod ↔ profile enabled-state, friendly name via `renderModName`)
that reflection can't do in one call.

`vortex_dispatch` extends the same reflection principle to writes, but only
for the ~150 `actions` entries that are plain Redux action creators — call
it, dispatch what comes back. It's gated by a hard-coded allowlist
(`DISPATCHABLE_ACTIONS` in `vortexControl.ts`, a `Map<name, argHint>`)
covering standard mod/category/load-order/deployment/download actions,
deliberately excluding admin-level ones (game/install/download _paths_,
extensions, credentials, profile deletion) even though they're otherwise
callable the same way — the allowlist is the actual enforcement boundary,
not just documentation. Each entry's value is its real positional argument
order, read from `@nexusmods/vortex-api`'s payload field names (or, for the
three entries typed `any` there, from their actual definitions in Vortex
source) — surfaced via `vortex_describe`'s `dispatchHints` so a caller
doesn't need to go read source to use `vortex_dispatch` correctly. The
remaining hand-written write tools exist because they genuinely aren't
`actions[name](...args)` calls: `setModsEnabled` takes `api` directly and
must be awaited rather than dispatched; `deploy_mods`/`purge_mods`/
`install_mod_from_url` go through `api.events.emit` with inconsistent
callback positions per event; `clone_profile` is a filesystem copy plus a
dispatch. None of that is reachable by name-based reflection no matter how
uniform the simple case gets — the validation and orchestration in those
wrappers is the point, not boilerplate to genericize away.

## Architecture

- `src/vortexControl.ts` — `describeApi`/`querySelector`/`queryStatePath` reflect
  over `@nexusmods/vortex-api`'s live `selectors` object and the Redux state
  tree; everything else is a thin wrapper around specific selectors/actions
  (`switchProfile`, `setModsEnabled`) and Vortex's internal event bus
  (`api.events.emit`) for `deploy-mods`/`purge-mods`/`start-download`/
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
- `restartVortex` (in `vortexControl.ts`) is the one function that reaches
  outside `@nexusmods/vortex-api` — it calls `window.api.app.relaunch()`,
  Vortex's own Electron preload bridge (reachable because this extension
  shares the renderer process), which is the exact path behind Vortex's own
  "Restart now" button: graceful window close, then Vortex's normal shutdown
  sequence, then relaunch. Unlike vortex-api this isn't a published contract
  — it can change across Vortex releases without notice.

## Safety

Bound to `127.0.0.1` only; `localhostHostValidation()` / `localhostOriginValidation()`
(from `@modelcontextprotocol/node`) reject any request whose `Host`/`Origin`
hostname isn't `localhost`/`127.0.0.1`/`[::1]` — this, not the loopback bind
alone, is what stops a DNS-rebinding page from reaching the server as
same-origin.

**Writes fail closed on `VORTEX_MCP_TOKEN`.** With no token set, only the
read tools (`vortex_describe`, `vortex_query`, `list_mods`, `list_load_order`,
`list_categories`) are ever
registered — `switch_profile`/`set_mods_enabled`/`deploy_mods`/`purge_mods`/
`install_mod_from_url`/`activate_game` don't exist to call. Set
`VORTEX_MCP_TOKEN` to require `Authorization: Bearer <token>` on every
request (reads included) _and_ unlock the write tools. There is still no
per-tool authorization once a token is set — any client holding it has full
write privileges, including `purge_mods` (deletes deployed game files) and
`install_mod_from_url` (downloads and installs arbitrary content).
Acceptable for a local single-user tool; do not bind this to a non-loopback
address, and treat the token like any other local secret.

## License

GPL-3.0-only, matching Vortex core and `@nexusmods/vortex-api` (both
GPL-3.0-only with no extension-linking exception).
