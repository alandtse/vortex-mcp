# vortex-mcp

A [Vortex](https://www.nexusmods.com/about/vortex/) extension that runs an
MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server inside
Vortex, so an AI agent (Claude, etc.) can list, install, enable/disable,
deploy, and purge mods, and switch profiles/games — all through one local
endpoint, no clicking through the UI.

Source: https://github.com/alandtse/vortex-mcp · License:
[GPL-3.0](LICENSE.md) · Nexus:
https://www.nexusmods.com/games/site/mods/2263

## Status

Unit- and integration-tested — see `pnpm run test`. Every read tool and
every `vortex_dispatch` fallback tier has been verified against a real
Vortex install on a disposable test profile, with a `backup_state` snapshot
taken first. `launch_game` was verified end to end (deploy, launch, real
game process came up) since unlike everything else here it has a visible
real-world side effect. The `start-download` event (installing a mod from a
URL) is never exercised outside unit tests — it can trigger a blocking
"choose install type" modal for ambiguous archives, unsafe to risk
unsupervised.

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
(override with `VORTEX_MCP_PORT`). `install-plugin` is a straight directory
copy for local development; `.github/workflows/release.yml` builds a
versioned zip in the same layout and attaches it to a GitHub Release on
every Conventional-Commit-worthy push to `main` (see
[Release process](#release-process)).

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

| Tool                          | Access | What it does                                                                                                                                 |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `vortex_describe`             | read   | Discover the live Vortex API surface: callable selector names (for vortex_query, with known caveats in `selectorHints`, e.g. selectorHints.… |
| `scan_extension_actions`      | read   | Discover real dispatchable Redux action type strings — and, where recoverable, their payload shape — by scanning every installed extension'… |
| `vortex_query`                | read   | Read Vortex state. Two modes: `selector` calls that named vortex-api selector as `(state, ...args)` (e.g. selector='activeProfileId', or se… |
| `list_profiles`               | read   | List Vortex profiles (defaults to every game; pass gameId to filter to one), with name, active status, and mod counts — a formatted join vo… |
| `list_mods`                   | read   | List mods for a game (defaults to the active game), with friendly names and enabled state for the active profile — a formatted join vortex_… |
| `list_load_order`             | read   | List the current Gamebryo/LOOT plugin load order (.esp/.esm/.esl), sorted by index.                                                          |
| `get_plugin_details`          | read   | Get the same rich per-plugin info Vortex's own Plugins tab shows — master list, LOOT messages/warnings, dirty-edit status (ITM/UDR), group,… |
| `list_categories`             | read   | List a game's mod categories (defaults to the active game), sorted by display order, with a mod count per category — a join vortex_query ca… |
| `list_downloads`              | read   | List the download queue/history for a game (defaults to the active game): name, state, progress percent, size, start time, installedModId —… |
| `find_stale_downloads`        | read   | Group downloads that came from the SAME Nexus mod page (not the same field list_downloads' installedModId reads — this groups by the Nexus…  |
| `list_notifications`          | read   | List Vortex's current notifications (errors, warnings, info) — what Vortex itself is currently flagging as a problem, useful for diagnosing… |
| `list_mod_rules`              | read   | List a mod's dependency/conflict rules (before/after/requires/conflicts/...), resolving each reference to the target mod's friendly name wh… |
| `find_mod_dependents`         | read   | Find every OTHER installed mod whose own rules reference this one — the reverse of list_mod_rules, which only shows rules recorded ON the m… |
| `find_mod_by_file`            | read   | Find which installed mod(s) contain a file with this name, by scanning mod staging folders on disk (no reflectable API exposes this).        |
| `list_file_conflicts`         | read   | List files provided by more than one currently-enabled mod (for the active/given profile) — the read side of conflict resolution; found by…  |
| `find_missing_masters`        | read   | Find enabled plugins whose master files aren't themselves enabled — reads each plugin's real TES4 header from the game's Data folder (the B… |
| `list_runtime_errors`         | read   | Read recent Papyrus error lines and crash log excerpts from the game's real save-data folder (Documents/My Games/<game>) — Vortex has no co… |
| `list_duplicate_mods`         | read   | Find installed mods that look like duplicates or redundant leftovers — never auto-resolved, purely informational (same 'report candidates,…  |
| `find_stale_mods`             | read   | List DISABLED mods for a profile (defaults to the active one), sorted oldest-disabled first — candidates for actually removing rather than…  |
| `list_known_mod_conflicts`    | read   | Surfaces real 'conflicts'-type rules Vortex already has recorded on enabled mods (mod.rules — the same field list_mod_rules reads, often po… |
| `list_unsolved_conflicts`     | read   | List file conflicts between enabled mods that have NO rule resolving them yet — the read side of Vortex's own conflict-resolution ('Set Rul… |
| `find_missing_deployed_files` | read   | Find plugins where Vortex's load-order state, what's actually deployed to the game's Data folder, and what the game's own plugins.txt says…  |
| `find_orphaned_files`         | read   | Find files Vortex's own deployment manifest (<Data>/vortex.deployment.json — the same bookkeeping Vortex reads for its own Purge) still att… |
| `check_nexus_mod_updates`     | read   | Check installed Nexus-sourced mods for available updates via Vortex's own built-in integration and the user's existing Vortex login — no se… |
| `list_dialogs`                | read   | List Vortex's currently-open GENERIC modal dialogs (showDialog-based — most confirmation/question/error prompts) — distinct from list_notif… |
| `list_external_changes`       | read   | List pending 'external changes' Vortex detected (a deployed file differs from what Vortex itself put there) that are BLOCKING an in-progres… |
| `switch_profile`              | write  | Switch Vortex to a different profile by id (query list_profiles to find one).                                                                |
| `clone_profile`               | write  | Clone an existing profile into a new one (copies its on-disk profile directory — load order, ini tweaks — plus its mod enabled-state), the…  |
| `vortex_dispatch`             | write  | Dispatch a named Vortex action creator, api.ext function, event, or direct api method — tried in that order.                                 |
| `poll_listener`               | write  | Read back what a persistent listener registered via vortex_dispatch (onStateChange/onAsync/registerProtocol/registerRepositoryLookup) has c… |
| `backup_state`                | write  | Create a full snapshot of Vortex's settings/persistent/app/user state as a JSON file in Vortex's own backup folder (%APPDATA%/vortex/temp/s… |
| `set_mods_enabled`            | write  | Enable or disable a set of mods for a profile (defaults to the active profile).                                                              |
| `launch_game`                 | write  | Launch a game's configured primary tool (e.g. SKSE, or the vanilla exe if none is set) — the same operation as Vortex's own 'Play' button,…  |
| `vortex_restart`              | write  | Restart Vortex via its own graceful relaunch (same path as Vortex's 'Restart now' button): closes windows and lets Vortex's normal shutdown… |

<!-- TOOLS_TABLE_END -->

`vortex_describe`/`vortex_query` replace one-tool-per-selector design in
favor of fewer, richer read primitives over reflection on the live
`@nexusmods/vortex-api` namespace, rather than a named MCP tool (and a
rebuild) per selector. `list_mods` stays hand-written because it performs a
real join (mod ↔ profile enabled-state, friendly name via `renderModName`)
that reflection can't do in one call.

`vortex_dispatch` extends the same principle to writes, trying five
fallback tiers in order by name: (1) a Redux `actions` creator, (2) a
same-named `api.ext.*` function, (3) a currently-registered event name via
`api.events.emit` — fire-and-forget by default, or awaited to real
completion when the caller passes a `"__CALLBACK__"` sentinel at the
position Vortex's own handler expects a Node-style `(err, result?) => void`
callback (e.g. `action="deploy-mods", args=["__CALLBACK__"]`), (4) a direct
method on the `api` object itself (e.g. `translate`, `sendNotification`,
`runExecutable`), and (5) a literal `"type:<TYPE>"` prefix, dispatching a
raw `{type, payload}` Redux action directly. None of the five tiers is
allowlisted — the security boundary is the loopback bind + bearer token
(see [Safety](#safety)); once an operator holds the token they already have
full write privileges, matching what a human at Vortex's own UI can do.
`ACTION_HINTS`/`EXTENSION_API_HINTS`/`EVENT_HINTS` in `vortexControl.ts`
document real positional argument order for the subset this project has
verified, surfaced via `vortex_describe`'s `dispatchHints`/
`extensionApiHints`/`eventHints`. An action/function/event/method missing
from these maps still dispatches fine; you just don't get a pre-verified
argument order.

Most action creators defined _inside_ an extension's own module (as opposed
to Vortex core) are never re-exported through `@nexusmods/vortex-api`, so
they're invisible to `vortex_describe`'s `actions` list entirely.
`scan_extension_actions` closes that gap by scanning every installed
extension's own compiled JS on disk (bundled + user-installed, both plain
files) for `createAction(TYPE, prepareFn)` call sites, recovering the real
type string and the prepare-function's payload shape — key names and
argument order survive minification even when parameter names get mangled,
since a minifier can't rewrite an object literal's keys without breaking
the payload contract. This is shape only, not reducer _behavior_: a
recovered shape like `{tutorialId, isOpen}` doesn't guarantee a field
always does what its name implies — verify with a state read before/after
your first real dispatch of anything newly discovered.

`vortex_query` stays genuinely read-only (`selector`/`path` modes, neither
can mutate anything), so it keeps working with no token at all; `api.ext`
calls go through `vortex_dispatch` instead, since they can have side
effects. `check_nexus_mod_updates` stays a dedicated write tool because it
does a real join no generic dispatcher can do in one call (resolving mod
ids to full `IMod` records and filtering to Nexus-sourced ones before
calling `nexusCheckModsVersion`).

The remaining hand-written write tools exist because they do a genuine join
or bit of orchestration that name-based reflection can't do in one call:
`setModsEnabled` takes `api` directly and must be awaited rather than
dispatched; `clone_profile` is a filesystem copy plus a dispatch;
`launch_game` resolves the active profile's configured tool through two
levels of settings state before running it.

A handful of `apiMethods` (`onStateChange`, `onAsync`, `registerProtocol`,
`registerRepositoryLookup` — see `vortex_describe`'s `listenerHints`) don't
perform a one-off action: they register a real JS function as a persistent
listener that keeps firing for the life of the Vortex process. A function
can't cross JSON-RPC and the MCP transport here is stateless, so
`vortex_dispatch`-ing one of these substitutes the `"__CALLBACK__"`
sentinel with a real callback that appends each firing to an in-process
ring buffer (capped at 500 entries, oldest dropped) and returns a
`listenerId` immediately. `poll_listener` reads that buffer back
non-destructively — repeated polling with the same `since` returns the
same entries, with the returned `lastSeq` fed back in to get only what's
new. This works across separate tool calls, including from more than one
agent at once, since there's no per-caller identity in this project's trust
model: any holder of the token can register or poll any listener.
`withPrePost` is excluded outright — it returns a wrapped function rather
than performing an action, which isn't serializable.

### When reflection can't reach something

A capability falls into one of three cases:

1. **A real join or orchestration reflection can't do in one call**
   (`list_mods`, `clone_profile`, `launch_game`,
   `check_nexus_mod_updates`). The underlying operation is fully reachable
   through `@nexusmods/vortex-api`; the tool just does more than one
   generic call's worth of work. Stays a vortex-mcp-side tool.
2. **A real Redux action exists, just not published through
   `@nexusmods/vortex-api`** — the common case for anything defined inside
   an extension's own module. `scan_extension_actions` + tier (5) closes
   this generically: no vortex-mcp code change needed per action.
3. **The capability isn't a plain Redux action at all.** The Vortex "files
   changed outside Vortex" deploy-blocking dialog is the concrete case: it
   resolves a private in-memory Promise captured in a module-scope closure,
   so no amount of raw dispatching from outside that module can reach it.
   The fix belongs in Vortex core, as a `context.registerAPI(...)`
   addition — once exposed that way, it becomes a normal `api.ext` entry
   and `vortex_dispatch` picks it up for free, no vortex-mcp code change
   required. `mod_management/index.ts` gained
   `confirmExternalChanges`/`setExternalChangeAction` `registerAPI` calls
   for exactly this reason.

Nexus mod search falls into the same non-reachable category, for a
different reason: it was evaluated across every layer that could
plausibly carry it (Vortex's `api.ext.nexus*` surface, the official Nexus
v3 REST API, Vortex's own in-app browser, Mod Organizer 2's integration)
and none of them expose it — the capability doesn't exist in Nexus's
public API at all, so there's no upstream surface for Vortex core to
expose via `registerAPI` either. Writing a search tool today would mean
scraping the website or calling Nexus's API directly with the raw key,
reopening the `state.confidential` exposure the [Safety](#safety) section
closes. If Nexus ever ships a search endpoint, the fix is the same shape
as `confirmExternalChanges`.

### Keeping this table in sync

The tools table above is generated from the live server's own `tools/list`
response, the same ground truth `vortex_describe` reflects, so it can't
drift from the code the way a hand-transcribed table can.

```sh
pnpm run docs:tools          # regenerate the table (needs Vortex running with this extension loaded)
pnpm run docs:tools:check    # verify it's current; exits 1 if stale, prints what to run
```

This can't run in CI (no live Vortex instance there), so it's a local step
— after adding/changing/removing a tool, run `docs:tools` before
committing. The read/write access tier isn't part of MCP's `tools/list`
response, so it stays a small hand-maintained map inside the generator
script (`ACCESS_TIER` in `scripts/generate-readme-tools-table.mjs`).

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
  Vortex's own Electron preload bridge, the exact path behind Vortex's own
  "Restart now" button. Unlike vortex-api this isn't a published contract —
  it can change across Vortex releases without notice.

## Release process

`.github/workflows/release.yml`: `semantic-release` reads Conventional
Commit history on every push to `main`, and — if there's anything
releasable — picks the next version, bumps it in `package.json`/`info.json`,
commits that back (`[skip ci]`), tags `vX.Y.Z`, and opens a draft GitHub
Release with the generated changelog as its body. A second job then checks
out that exact tag, runs the full `pnpm run ci` pipeline, zips `dist/` +
`info.json` into the same layout `install-plugin` uses, attaches it to the
release, and promotes the release out of draft — only after the asset
exists, so a failed build leaves a hidden draft instead of a
download-less tag.

`.github/workflows/nexus-upload.yml` wraps `alandtse/nexus-workflows`'s
`upload-nexus-official.yml` (the official `Nexus-Mods/upload-action`, Nexus
v3 API). The mod page (`nexus_mod_id` 2263) and file group (`file_group_id` 7907967) both exist and are set as the workflow's defaults. Dry-run stays
the default until the `NEXUS_AUTO_UPLOAD=true` repo variable (plus
`UNEX_APIKEY`) is set, letting `release.yml` upload every subsequent
version automatically.

## Safety

Bound to `127.0.0.1` only; `localhostHostValidation()` / `localhostOriginValidation()`
(from `@modelcontextprotocol/node`) reject any request whose `Host`/`Origin`
hostname isn't `localhost`/`127.0.0.1`/`[::1]` — this, not the loopback bind
alone, is what stops a DNS-rebinding page from reaching the server as
same-origin.

**Writes fail closed on `VORTEX_MCP_TOKEN`.** With no token set, only the
read tools — every tool marked `read` in the [Tools](#tools) table above —
are ever registered; none of the eight write tools (`switch_profile`,
`clone_profile`, `vortex_dispatch`, `poll_listener`, `backup_state`,
`set_mods_enabled`, `launch_game`, `vortex_restart`) exist to call. Set
`VORTEX_MCP_TOKEN` to require `Authorization: Bearer <token>` on every
request (reads included) _and_ unlock the write tools. There is no
per-tool authorization once a token is set — any client holding it has
full write privileges, including `vortex_restart` (kills and relaunches
the whole app), and — via `vortex_dispatch` — every Redux action,
`api.ext` function, event, and direct api method Vortex has, including
ones that touch game/install paths, extensions, and credentials. This is
deliberate: the token represents the same trust a human already has at
Vortex's own UI. Acceptable for a local single-user tool; do not bind this
to a non-loopback address, and treat the token like any other local
secret.

**One exception to "no per-tool restriction": `state.confidential` (the
Nexus API key or OAuth credential Vortex itself stores) is redacted out of
every `vortex_query` response, token or no token.** Redaction happens in
`mcpServer.ts`'s `jsonText` — the one funnel every tool response already
serializes through — by provenance: anything sourced from the live
`state.confidential` subtree (matched structurally for objects, by value
for a freshly-computed string like `apiKey`'s return) becomes
`"[redacted: state.confidential]"` before it's ever written to the wire.
Selectors that legitimately derive a non-secret fact from that subtree
(`isLoggedIn`) are unaffected — the redaction runs on the _output_, after
the selector already ran on real state. This is a token-independent
invariant: a human at Vortex's own UI can't read their stored credential
back out as plaintext either. `vortex_dispatch` can still _write_ new
credentials (`setUserAPIKey`, `nexusRequestNexusLogin`, …) — the boundary
is specifically on reading one back out.

**Writes can optionally guard against a stale assumption about what's
currently active.** `switch_profile`, `set_mods_enabled`, `launch_game`,
and `vortex_dispatch` all accept optional
`expectedActiveProfileId`/`expectedActiveGameId` params; when set, the
write throws immediately — before touching anything — if the live active
profile/game no longer matches what the caller last observed, instead of
silently proceeding against whatever's active now. Opt-in and additive:
omit them and behavior is unchanged.

## License

GPL-3.0-only, matching Vortex core and `@nexusmods/vortex-api` (both
GPL-3.0-only with no extension-linking exception).
