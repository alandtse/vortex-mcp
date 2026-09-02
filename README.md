# vortex-mcp

A [Vortex](https://www.nexusmods.com/about/vortex/) extension that runs an
MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server inside
Vortex, so an AI agent (Claude, etc.) can list, install, enable/disable,
deploy, and purge mods, and switch profiles/games — all through one local
endpoint, no clicking through the UI.

## Status

Unit- and integration-tested (real HTTP requests against the actual server,
real Host/Origin/token gating, real MCP `initialize` handshake) — see
`pnpm run test`. Every read tool, and `vortex_dispatch` across all four of
its fallback tiers (action creator, api.ext function, event — both
fire-and-forget and `"__CALLBACK__"`-awaited, e.g.
`action="deploy-mods", args=["__CALLBACK__"]` — and direct api method,
including the listener-registering subset paired with `poll_listener` —
registered `onStateChange` against a real state path, triggered two real
firings via `setAdvancedMode`, and confirmed `poll_listener` returned both
in order, non-destructively, with `since` correctly filtering to only
what's new), has been live-verified against a real Vortex install against
a disposable test profile, with a `backup_state` snapshot taken before
starting. `launch_game` was live-verified end to end — deploy, launch,
confirmed the real game process came up — with explicit confirmation
first, since unlike everything else here it has a visible real-world side
effect. The `start-download` event (installing a mod from a URL) is
deliberately never exercised outside unit tests — it can trigger a
blocking "choose install type" modal for ambiguous archives, unsafe to
risk unsupervised.

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
versioned zip in the same layout (dist/ + info.json) and attaches it to a
GitHub Release on every Conventional-Commit-worthy push to `main` (see
[Release process](#release-process)). No Nexus mod page exists yet — see
that section.

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
| `vortex_query`                | read   | Read Vortex state. Two modes: `selector` calls that named vortex-api selector as `(state, ...args)` (e.g. selector='activeProfileId', or se… |
| `list_profiles`               | read   | List Vortex profiles (defaults to every game; pass gameId to filter to one), with name, active status, and mod counts — a formatted join vo… |
| `list_mods`                   | read   | List mods for a game (defaults to the active game), with friendly names and enabled state for the active profile — a formatted join vortex_… |
| `list_load_order`             | read   | List the current Gamebryo/LOOT plugin load order (.esp/.esm/.esl), sorted by index.                                                          |
| `list_categories`             | read   | List a game's mod categories (defaults to the active game), sorted by display order, with a mod count per category — a join vortex_query ca… |
| `list_downloads`              | read   | List the download queue/history for a game (defaults to the active game): name, state, progress percent, size, start time — a formatted vie… |
| `list_notifications`          | read   | List Vortex's current notifications (errors, warnings, info) — what Vortex itself is currently flagging as a problem, useful for diagnosing… |
| `list_mod_rules`              | read   | List a mod's dependency/conflict rules (before/after/requires/conflicts/...), resolving each reference to the target mod's friendly name wh… |
| `find_mod_dependents`         | read   | Find every OTHER installed mod whose own rules reference this one — the reverse of list_mod_rules, which only shows rules recorded ON the m… |
| `find_mod_by_file`            | read   | Find which installed mod(s) contain a file with this name, by scanning mod staging folders on disk (no reflectable API exposes this).        |
| `list_file_conflicts`         | read   | List files provided by more than one currently-enabled mod (for the active/given profile) — the read side of conflict resolution; found by…  |
| `find_missing_masters`        | read   | Find enabled plugins whose master files aren't themselves enabled — reads each plugin's real TES4 header from the game's Data folder (the B… |
| `list_runtime_errors`         | read   | Read recent Papyrus error lines and crash log excerpts from the game's real save-data folder (Documents/My Games/<game>) — Vortex has no co… |
| `list_duplicate_mods`         | read   | Find installed mods that look like duplicates or redundant leftovers — never auto-resolved, purely informational (same 'report candidates,…  |
| `list_known_mod_conflicts`    | read   | Surfaces real 'conflicts'-type rules Vortex already has recorded on enabled mods (mod.rules — the same field list_mod_rules reads, often po… |
| `find_missing_deployed_files` | read   | Find plugins where Vortex's load-order state, what's actually deployed to the game's Data folder, and what the game's own plugins.txt says…  |
| `check_nexus_mod_updates`     | read   | Check installed Nexus-sourced mods for available updates via Vortex's own built-in integration and the user's existing Vortex login — no se… |
| `list_dialogs`                | read   | List Vortex's currently-open modal dialogs (e.g. a 'files changed outside Vortex' prompt that can block a deploy) — distinct from list_noti… |
| `switch_profile`              | write  | Switch Vortex to a different profile by id.                                                                                                  |
| `clone_profile`               | write  | Clone an existing profile into a new one (copies its on-disk profile directory — load order, ini tweaks — plus its mod enabled-state), the…  |
| `vortex_dispatch`             | write  | Dispatch a named Vortex action creator, api.ext function, event, or direct api method — tried in that order.                                 |
| `poll_listener`               | write  | Read back what a persistent listener registered via vortex_dispatch (onStateChange/onAsync/registerProtocol/registerRepositoryLookup) has c… |
| `backup_state`                | write  | Create a full snapshot of Vortex's settings/persistent/app/user state as a JSON file in Vortex's own backup folder (%APPDATA%/vortex/temp/s… |
| `set_mods_enabled`            | write  | Enable or disable a set of mods for a profile (defaults to the active profile).                                                              |
| `launch_game`                 | write  | Launch a game's configured primary tool (e.g. SKSE, or the vanilla exe if none is set) — the same operation as Vortex's own 'Play' button,…  |
| `vortex_restart`              | write  | Restart Vortex via its own graceful relaunch (same path as Vortex's 'Restart now' button): closes windows and lets Vortex's normal shutdown… |

<!-- TOOLS_TABLE_END -->

`vortex_describe`/`vortex_query` deliberately replace the old one-tool-per-
selector design (`list_profiles`, `get_active_profile`) — an
[agentic-renderdoc](https://github.com/EdenLabs/agentic-renderdoc#why-this-design)-style
choice: fewer, richer read primitives over reflection on the live
`@nexusmods/vortex-api` namespace, rather than a named MCP tool (and a
rebuild) per selector. `list_mods` stays hand-written because it performs a
real join (mod ↔ profile enabled-state, friendly name via `renderModName`)
that reflection can't do in one call.

`vortex_dispatch` extends the same reflection principle to writes, trying
four fallback tiers in order by name: (1) a Redux `actions` creator, (2) a
same-named `api.ext.*` function (Vortex's own built-in Nexus Mods
integration, plus anything a third-party extension registers the same
way), (3) a currently-registered event name, emitted via `api.events.emit`
— fire-and-forget by default, or awaited to real completion (not just
"started") when the caller passes a `"__CALLBACK__"` sentinel at the
position Vortex's own handler expects a Node-style `(err, result?) => void`
callback (e.g. `action="deploy-mods", args=["__CALLBACK__"]`), and (4) a
direct method on the `api` object itself (e.g. `translate`,
`sendNotification`, `runExecutable`). None of the four tiers is
allowlisted. The security boundary is the loopback bind + bearer token
(see [Safety](#safety)) — once an operator holds the token they already
have "full write privileges" per this project's own model, matching what a
human at Vortex's own UI can already do (change game paths, manage
extensions/credentials, delete profiles, deploy/purge mods). An earlier
version gated this behind a hand-curated allowlist excluding "admin-level"
actions — removed deliberately: it didn't protect against a meaningfully
different threat than the token already does, it blocked the trusted case
(an agent acting on the operator's own behalf) for no real gain, and it
required manual upkeep for every new safe Vortex action or event.
`ACTION_HINTS`/`EXTENSION_API_HINTS`/`EVENT_HINTS` in `vortexControl.ts`
still exist, but purely as documentation now — real positional argument
order (including the `"__CALLBACK__"` position) for the subset this
project has verified, surfaced via `vortex_describe`'s `dispatchHints`/
`extensionApiHints`/`eventHints` so a caller doesn't need to go read source
first. An action, `api.ext` function, event, or api method missing from
these maps still dispatches fine; you just don't get a pre-verified
argument order.

`vortex_query` stays genuinely read-only (two modes, `selector`/`path` —
neither can mutate anything), so it keeps working with no token at all;
`api.ext` calls moved to `vortex_dispatch` instead, since they can have
side effects. `check_nexus_mod_updates` stayed a dedicated write tool
(rather than folding into `vortex_dispatch` like `get_nexus_mod_info` did)
because it does a real join no generic dispatcher can do in one call
(resolving mod ids to full `IMod` records and filtering to Nexus-sourced
ones before calling `nexusCheckModsVersion`) — the same bar `list_mods`
already clears.

The remaining hand-written write tools exist because they do a genuine
join or bit of orchestration that name-based reflection can't do in one
call, not because their underlying operation is unreachable generically:
`setModsEnabled` takes `api` directly and must be awaited rather than
dispatched; `clone_profile` is a filesystem copy plus a dispatch;
`launch_game` resolves the active profile's configured tool through two
levels of settings state before running it. `deploy_mods`/`purge_mods`/
`install_mod_from_url`/`activate_game` used to be dedicated wrappers around
`api.events.emit` for exactly this reason (inconsistent callback positions
per event), but became fully expressible through `vortex_dispatch`'s event
fallback tier once it grew the `"__CALLBACK__"` convention, so they were
removed as dedicated tools.

A handful of `apiMethods` (`onStateChange`, `onAsync`, `registerProtocol`,
`registerRepositoryLookup` — see `vortex_describe`'s `listenerHints`)
don't perform a one-off action at all: they register a real JS function as
a persistent listener that keeps firing for the life of the Vortex
process. A function can't cross JSON-RPC, and the MCP transport here is
stateless (no session tied to a connection to push results back down
later), so `vortex_dispatch`-ing one of these substitutes the
`"__CALLBACK__"` sentinel with a real callback that appends each firing to
an in-process ring buffer (capped at 500 entries, oldest dropped — none of
these APIs expose a way to unregister, so a registered listener outlives
the call that created it) and returns a `listenerId` immediately instead
of trying to wait for or return "the result" of something that keeps
happening. `poll_listener` reads that buffer back — non-destructively, so
repeated polling with the same `since` returns the same entries, with the
returned `lastSeq` fed back in to get only what's new. This works because
the transport being stateless only means no session-per-connection, not
that the process is stateless: this extension runs inside Vortex's own
long-lived process, so the listener registry survives fine across
separate, independent tool calls — including from more than one agent at
once, since there's already no per-caller identity in this project's trust
model (see [Safety](#safety)): any holder of the token can register or
poll any listener. `withPrePost` is excluded outright rather than handled
this way — it returns a wrapped function rather than performing an action
or registering anything, which isn't serializable and does nothing until
invoked, which this dispatcher never does.

### When reflection genuinely can't reach something

Every hand-written tool and fallback tier above exists because reflection
alone can't express it — but they fall into two different categories, and
telling them apart matters for where the fix belongs:

1. **A real join or bit of orchestration reflection can't do in one call**
   (`list_mods`, `clone_profile`, `launch_game`, `check_nexus_mod_updates`
   above). The underlying operation is fully reachable through the
   published `@nexusmods/vortex-api`; the tool just does more than one
   generic call's worth of work. This is a vortex-mcp-side tool, and stays
   one.
2. **The published API genuinely doesn't expose the capability at all** —
   not "reflection is clumsy here," but "there is no `actions`/`api.ext`/
   event/apiMethod name to dispatch, published or not." The Vortex "files
   changed outside Vortex" deploy-blocking dialog is the concrete case
   that surfaced this: it isn't built on the generic `addDialog` system
   `list_dialogs` reads, and the action creators that resolve it
   (`setExternalChangeAction`, `confirmExternalChanges`) live in Vortex
   core's `mod_management` extension, never exported through
   `@nexusmods/vortex-api`. Worse, resolving it isn't even a pure Redux
   action — `confirmExternalChanges` resolves a private in-memory Promise
   captured in a module-scope closure the moment the dialog opened, so no
   amount of raw `{type, payload}` dispatching from outside that module
   could ever unblock the deploy waiting on it.

   For case 2, the fix does **not** belong in vortex-mcp — there's nothing
   here to hand-write around a capability the API doesn't have. It belongs
   in Vortex core itself, as a `context.registerAPI(...)` addition (same
   pattern as `restartVortex`'s `window.api.app.relaunch`: reaching a real
   but previously-unpublished runtime surface, not inventing one). Once
   Vortex exposes it that way, it becomes a normal `api.ext` entry —
   vortex-mcp's reflection picks it up for free via `vortex_dispatch`'s
   existing fallback tier, with **no vortex-mcp code change required**.
   `mod_management/index.ts` gained `confirmExternalChanges`/
   `setExternalChangeAction` `registerAPI` calls for exactly this reason;
   once that ships, resolving the dialog from here is just
   `vortex_dispatch({action: "confirmExternalChanges", args: [false]})`
   (optionally preceded by `setExternalChangeAction` calls to override the
   default per-file action first).

### Nexus mod search: checked, doesn't exist, not building it

Keyword search for mods on Nexus was considered and dropped — recorded
here so it isn't re-investigated. Checked at every layer that could
plausibly carry it: Vortex's own `api.ext.nexus*` surface has no search
(only `nexusGetTrendingMods`/`nexusGetLatestMods` and
`nexusSearchCollections`, which is Collections-only); the official Nexus
v3 REST API's OpenAPI schema has no search endpoint; Vortex's own in-app
Nexus browser (`browse_nexus/views/BrowseNexusPage.tsx`) searches
Collections only, same limitation; and Mod Organizer 2's Nexus
integration doesn't do API-driven mod search either — its `browserview.h`
embeds an actual browser widget pointed at the real nexusmods.com website
for search, the same "embed the website" pattern Vortex's own browser
page uses. Two independent mod managers converged on the same workaround,
which is itself evidence there's nothing to wrap: **no mod manager
checked does API-driven Nexus mod search**, because the capability
doesn't exist in Nexus's public API at all — not merely unexposed by
Vortex's wrapper.

That distinction is why case (b) above doesn't apply here: there's no
upstream capability for Vortex core to expose via `registerAPI`, so
there's nothing for vortex-mcp to reflect either. Writing a search tool
today would mean either scraping the website (fragile, outside any
published API) or calling Nexus's API directly with the raw key — the
exact `state.confidential` exposure the [Safety](#safety) section above
closes, reopened from inside vortex-mcp's own code. If Nexus ever ships a
search endpoint, the fix is the same shape as `confirmExternalChanges`:
Vortex core adds `api.ext.nexusSearchMods` (or similar) beside the
existing `nexusSearchCollections`, holding the key internally and
returning only results, and `vortex_dispatch` picks it up for free with
zero vortex-mcp changes.

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

## Release process

`.github/workflows/release.yml` follows the same pattern as the sibling
FloatingDamageNG/devbench repos: `semantic-release` reads Conventional
Commit history on every push to `main`, and — if there's anything
releasable — picks the next version, bumps it in `package.json`/`info.json`,
commits that back (`[skip ci]`), tags `vX.Y.Z`, and opens a draft GitHub
Release with the generated changelog as its body. A second job then checks
out that exact tag, runs the full `pnpm run ci` pipeline, zips `dist/` +
`info.json` into the same layout `install-plugin` uses (so unzipping it
straight into `%APPDATA%/vortex/plugins/vortex-mcp` works with no
rearranging), attaches it to the release, and promotes the release out of
draft — only after the asset exists, so a failed build leaves a hidden
draft instead of a download-less tag.

**Nexus upload has no mod page to upload to yet.** `.github/workflows/
nexus-upload.yml` wraps `alandtse/nexus-workflows`'s
`upload-nexus-official.yml` — the official `Nexus-Mods/upload-action`
(Nexus v3 API) path, rather than the `BUTR.NexusUploader`/`unex` wrapper
the sibling FloatingDamageNG/devbench repos still use; it handles its own
dry-run reporting and idempotent-reupload check internally. Its
`file_group_id` has no default — dry-run is the only mode until it's set,
and getting there is two real, sequenced steps, not one missing config
value: (1) creating a new Nexus mod page isn't exposed by any API —
checked directly against Nexus's own v3 OpenAPI schema and confirmed by
`BUTR.NexusUploader`'s own docs — so the page has to be created by hand
once on nexusmods.com; (2) this specific uploader also needs an existing
file _group_ id, minted by uploading the mod's first file once on the
website (Files tab → "API Info", or the Manage Files edit menu) — it
doesn't create the first file either. Once both exist, set
`file_group_id` in `nexus-upload.yml` and the `NEXUS_AUTO_UPLOAD=true`
repo variable (plus `UNEX_APIKEY`) to let `release.yml` upload every
subsequent version automatically.

## Safety

Bound to `127.0.0.1` only; `localhostHostValidation()` / `localhostOriginValidation()`
(from `@modelcontextprotocol/node`) reject any request whose `Host`/`Origin`
hostname isn't `localhost`/`127.0.0.1`/`[::1]` — this, not the loopback bind
alone, is what stops a DNS-rebinding page from reaching the server as
same-origin.

**Writes fail closed on `VORTEX_MCP_TOKEN`.** With no token set, only the
read tools (`vortex_describe`, `vortex_query`, `list_mods`, `list_load_order`,
`list_categories`, `list_downloads`, `list_notifications`, `list_mod_rules`,
`find_mod_by_file`, `list_file_conflicts`, `find_missing_masters`,
`list_runtime_errors`, `list_duplicate_mods`, `list_known_mod_conflicts`,
`find_missing_deployed_files`, `check_nexus_mod_updates`,
`list_dialogs`) are ever registered
— none of the eight write tools
(`switch_profile`, `clone_profile`, `vortex_dispatch`, `poll_listener`,
`backup_state`, `set_mods_enabled`, `launch_game`, `vortex_restart`) exist
to call. Set `VORTEX_MCP_TOKEN` to
require `Authorization: Bearer <token>` on every request (reads included)
_and_ unlock the write tools. There is no per-tool authorization once a
token is set — any client holding it has full write privileges, including
`vortex_restart` (kills and relaunches the whole app), and — via
`vortex_dispatch` — every Redux action, `api.ext` function, event (e.g.
`purge-mods`, which deletes deployed game files, or `start-download`,
which downloads and installs arbitrary content), and direct api method
Vortex has, including ones that touch game/install paths, extensions, and
credentials. This is deliberate, not an oversight:
the token is meant to represent the same trust a human already has at
Vortex's own UI, so there's no further curated allowlist narrowing what an
authenticated caller can do (see the `vortex_dispatch` section above for
why an earlier, more restrictive version of this was removed). Acceptable
for a local single-user tool; do not bind this to a non-loopback address,
and treat the token like any other local secret.

**One exception to "no per-tool restriction": `state.confidential` (the
Nexus API key or OAuth credential Vortex itself stores) is redacted out of
every `vortex_query` response, token or no token.** This surfaced live:
`vortex_query({selector: "apiKey"})` and `vortex_query({path:
["confidential", ...]})` both returned the real credential in plaintext,
because reflection swept up `state.confidential` the same as every other
harmless selector/path. Redaction happens in `mcpServer.ts`'s `jsonText` —
the one funnel every tool response already serializes through — by
provenance: anything sourced from the live `state.confidential` subtree
(matched structurally for objects, by value for a freshly-computed string
like `apiKey`'s return) becomes `"[redacted: state.confidential]"` before
it's ever written to the wire. Selectors that legitimately derive a
non-secret fact from that subtree (`isLoggedIn`) are unaffected — the
redaction runs on the _output_, after the selector already ran on real
state, not by handing selectors a doctored copy of `state` up front (that
was considered and rejected: it corrupts any selector that reads
`confidential` for a non-secret purpose, returning a wrong answer instead
of a visible redaction). This is a token-independent invariant, not a
tier: a human at Vortex's own UI can't read their stored credential back
out as plaintext either, so redacting it is the UI-parity floor, not a
restriction the token lifts. `vortex_dispatch` can still _write_ new
credentials (`setUserAPIKey`, `nexusRequestNexusLogin`, …) — same as a
human re-entering their key in Vortex's settings page — the boundary is
specifically on reading one back out.

## License

GPL-3.0-only, matching Vortex core and `@nexusmods/vortex-api` (both
GPL-3.0-only with no extension-linking exception).
