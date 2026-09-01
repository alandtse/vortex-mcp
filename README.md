# vortex-mcp

A [Vortex](https://www.nexusmods.com/about/vortex/) extension that runs an
MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server inside
Vortex, so an AI agent (Claude, etc.) can list, install, enable/disable,
deploy, and purge mods, and switch profiles/games — all through one local
endpoint, no clicking through the UI.

## Status

Unit- and integration-tested (real HTTP requests against the actual server,
real Host/Origin/token gating, real MCP `initialize` handshake) — see
`pnpm run test`. Every read tool and every write tool except
`install_mod_from_url` has been live-verified against a real Vortex
install, including a full write cycle (`set_mods_enabled`, `deploy_mods`,
`purge_mods`, `vortex_dispatch`) against a disposable test profile, with a
`backup_state` snapshot taken before starting.
`install_mod_from_url` is deliberately never exercised outside unit tests
— it can trigger a blocking "choose install type" modal for ambiguous
archives, unsafe to risk unsupervised.

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

If `VORTEX_MCP_TOKEN` is set (see [Safety](#safety)), every request —
including reads — needs the header, or the connection fails outright:

```sh
claude mcp add --transport http vortex http://127.0.0.1:3701/mcp \
  -H "Authorization: Bearer <token>"
```

For a stdio-only client, bridge with the off-the-shelf `mcp-remote`:
`{ "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:3701/mcp"] }`

## Tools

Read tools are always available. Write tools only exist — `tools/list` won't
even show them — when `VORTEX_MCP_TOKEN` is set (see [Safety](#safety)).

Generated from the live server's actual `tools/list` response — see
[Keeping this table in sync](#keeping-this-table-in-sync) — rather than
hand-transcribed, so it can't silently drift from the code.

<!-- TOOLS_TABLE_START -->

| Tool                   | Access | What it does                                                                                                                                 |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `vortex_describe`      | read   | Discover the live Vortex API surface: callable selector names (for vortex_query), the subset of action names actually callable via vortex_d… |
| `vortex_query`         | read   | Read Vortex state. Two modes: `selector` calls that named vortex-api selector as `(state, ...args)` (e.g. selector='activeProfileId', or se… |
| `list_mods`            | read   | List mods for a game (defaults to the active game), with friendly names and enabled state for the active profile — a formatted join vortex_… |
| `list_load_order`      | read   | List the current Gamebryo/LOOT plugin load order (.esp/.esm/.esl), sorted by index.                                                          |
| `list_categories`      | read   | List a game's mod categories (defaults to the active game), sorted by display order, with a mod count per category — a join vortex_query ca… |
| `list_downloads`       | read   | List the download queue/history for a game (defaults to the active game): name, state, progress percent, size — a formatted view raw vortex… |
| `list_notifications`   | read   | List Vortex's current notifications (errors, warnings, info) — what Vortex itself is currently flagging as a problem, useful for diagnosing… |
| `list_mod_rules`       | read   | List a mod's dependency/conflict rules (before/after/requires/conflicts/...), resolving each reference to the target mod's friendly name wh… |
| `list_dialogs`         | read   | List Vortex's currently-open modal dialogs (e.g. a 'files changed outside Vortex' prompt that can block a deploy) — distinct from list_noti… |
| `switch_profile`       | write  | Switch Vortex to a different profile by id.                                                                                                  |
| `clone_profile`        | write  | Clone an existing profile into a new one (copies its on-disk profile directory — load order, ini tweaks — plus its mod enabled-state), the…  |
| `vortex_dispatch`      | write  | Dispatch a named, allowlisted Vortex action creator — mod metadata/rules, categories, load order, deployment settings, download bookkeeping. |
| `backup_state`         | write  | Create a full snapshot of Vortex's settings/persistent/app/user state as a JSON file in Vortex's own backup folder (%APPDATA%/vortex/temp/s… |
| `set_mods_enabled`     | write  | Enable or disable a set of mods for a profile (defaults to the active profile).                                                              |
| `deploy_mods`          | write  | Deploy currently enabled mods for the active profile.                                                                                        |
| `purge_mods`           | write  | Purge (undeploy) all deployed mod files for the active profile.                                                                              |
| `install_mod_from_url` | write  | Download and install a mod from a URL (e.g. an nxm:// link or direct download URL).                                                          |
| `activate_game`        | write  | Switch Vortex's active game mode.                                                                                                            |
| `vortex_restart`       | write  | Restart Vortex via its own graceful relaunch (same path as Vortex's 'Restart now' button): closes windows and lets Vortex's normal shutdown… |

<!-- TOOLS_TABLE_END -->

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
covering standard mod/category/load-order/deployment/download/profile
actions, deliberately excluding admin-level ones (game/install/download
_paths_, extensions, credentials) even though they're otherwise callable
the same way — the allowlist is the actual enforcement boundary, not just
documentation. `removeProfile` is the one admin-adjacent exception: it's
allowlisted specifically so `clone_profile`'s disposable test profiles can
be cleaned up again, and its dispatch hint warns to only ever call it on a
profile you created yourself. Each entry's value is its real positional argument
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

### Keeping this table in sync

The tools table above is generated, not hand-written — it comes straight
from the live server's own `tools/list` response, the same ground truth
`vortex_describe` reflects. That's a deliberate answer to how this project
already went out of sync with itself twice in one session (a stale
write-tool count, a table missing a tool that had shipped): a table
transcribed by hand can drift from the code; a table generated from the
running server's actual response cannot, by construction — the same
principle behind `vortex_query`/`vortex_dispatch` themselves.

```sh
pnpm run docs:tools          # regenerate the table (needs Vortex running with this extension loaded)
pnpm run docs:tools:check    # verify it's current; exits 1 if stale, prints what to run
```

This can't run in CI (no live Vortex instance there), so it's a local
step — after adding/changing/removing a tool, run `docs:tools` before
committing. The read/write access tier isn't part of MCP's `tools/list`
response, so it stays a small hand-maintained map inside the generator
script (`ACCESS_TIER` in `scripts/generate-readme-tools-table.mjs`) —
everything else (names, descriptions, tool count) regenerates from reality.

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
`list_categories`, `list_downloads`, `list_notifications`, `list_mod_rules`,
`list_dialogs`) are ever registered — none of the ten write tools
(`switch_profile`, `clone_profile`, `vortex_dispatch`, `backup_state`,
`set_mods_enabled`, `deploy_mods`, `purge_mods`, `install_mod_from_url`,
`activate_game`, `vortex_restart`) exist to call. Set `VORTEX_MCP_TOKEN` to
require `Authorization: Bearer <token>` on every request (reads included)
_and_ unlock the write tools. There is still no per-tool authorization once
a token is set — any client holding it has full write privileges, including
`purge_mods` (deletes deployed game files), `install_mod_from_url`
(downloads and installs arbitrary content), and `vortex_restart` (kills and
relaunches the whole app). Acceptable for a local single-user tool; do not
bind this to a non-loopback address, and treat the token like any other
local secret.

## License

GPL-3.0-only, matching Vortex core and `@nexusmods/vortex-api` (both
GPL-3.0-only with no extension-linking exception).
