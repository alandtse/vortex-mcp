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

// Vortex's `confidential` state hive (Nexus API key, OAuth credentials, and anything
// else Vortex core itself treats as a credential — see Application.ts's registerHive
// and store.ts's own exclusion of it from backups) is the one part of the reflected
// state tree that's actually sensitive. Every other selector/path vortex_query can
// reach is harmless mod/profile/game state, so this is a targeted invariant, not a
// return to the curated allowlist this project deliberately removed for writes: it
// names no selectors and no paths, just the one structural hive Vortex core already
// marks as confidential.
const CONFIDENTIAL_REDACTED = "[redacted: state.confidential]";
// A floor on redacted string values, not just object nodes: apiKey-style selectors
// return a freshly computed string with no path a structural check could see, so the
// string itself has to be matched by value too. The floor keeps a short, benign
// string (a username, a locale code) from colliding by coincidence.
const MIN_REDACTED_STRING_LENGTH = 16;

function collectConfidentialProvenance(confidential: unknown): {
  nodes: WeakSet<object>;
  values: Set<string>;
} {
  const nodes = new WeakSet<object>();
  const values = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.length >= MIN_REDACTED_STRING_LENGTH) {
        values.add(node);
      }
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    nodes.add(node);
    for (const child of Object.values(node)) {
      visit(child);
    }
  };
  visit(confidential);
  return { nodes, values };
}

// JSON.stringify(undefined) returns the actual `undefined` value, not a string —
// a legitimate result (an unresolved vortex_query path/selector, found live: an
// MCP response's content[].text must be a string, so an ungated JSON.stringify
// crashed the whole call at the SDK's own response-schema validation instead of
// returning a clean "null"). `?? null` guarantees a real JSON string every time.
//
// Redaction happens here — the one funnel every tool response already passes
// through via JSON.stringify's own tree walk — rather than by gating individual
// selectors/paths before they run. Redacting the input state instead (e.g. handing
// selectors a state whose `confidential` node is replaced first) was considered and
// rejected: it corrupts legitimate selectors that derive a non-secret fact from that
// subtree (an isLoggedIn-shaped check), returning a wrong answer instead of a visible
// redaction. This applies to every read regardless of whether VORTEX_MCP_TOKEN is
// set — a human at Vortex's own UI can't read their stored credential back out as
// plaintext either, so redaction is the UI-parity floor, not a tier a token lifts.
function makeJsonText(api: IExtensionApi): (value: unknown) => { type: "text"; text: string } {
  return (value: unknown) => {
    const { confidential } = api.getState();
    const { nodes, values } = collectConfidentialProvenance(confidential);
    const text = JSON.stringify(
      value ?? null,
      (_key, val: unknown) => {
        if (typeof val === "object" && val !== null && nodes.has(val)) {
          return CONFIDENTIAL_REDACTED;
        }
        if (typeof val === "string" && values.has(val)) {
          return CONFIDENTIAL_REDACTED;
        }
        return val;
      },
      2,
    );
    return { type: "text", text };
  };
}

function registerReadTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
  server.registerTool(
    "vortex_describe",
    {
      description:
        "Discover the live Vortex API surface: callable selector names (for vortex_query), " +
        "every action/api.ext function/event/api method name dispatchable via vortex_dispatch " +
        "(`actions`/`extensionApis`/`eventNames`/`apiMethods` — all of these are callable, no " +
        "allowlist; the loopback bind + bearer token is the real security boundary), with real " +
        "positional argument order for the ones this project has verified (`dispatchHints`/" +
        "`extensionApiHints`/`eventHints`/`listenerHints`, e.g. dispatchHints.setModEnabled = " +
        '"profileId: string, modId: string, enable: boolean" — missing from these maps just ' +
        "means no pre-verified arg order, not that it's unavailable; eventHints/listenerHints " +
        'also document the "__CALLBACK__" sentinel position for the few events/apiMethods ' +
        "that need one — a listenerHints entry means that apiMethod registers a persistent " +
        "listener instead of performing a one-off action; see poll_listener), and top-level " +
        "Redux state keys (for vortex_query's path mode, includes state added by any loaded " +
        "extension, not just core Vortex). Reflects whatever Vortex is actually running right " +
        "now — new selectors/actions/events/state show up here without an extension rebuild.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.describeApi(api))],
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
        "available. Genuinely read-only (can't mutate anything) — for calling an api.ext " +
        "function (which can have side effects), use vortex_dispatch instead. Anything sourced " +
        "from state.confidential (the stored Nexus API key/OAuth credential) comes back as " +
        '"[redacted: state.confidential]" — this is unconditional, not something the write ' +
        "token lifts; a selector that only derives a non-secret fact from that subtree (e.g. " +
        "isLoggedIn) is unaffected.",
      inputSchema: z.object({
        selector: z.string().optional(),
        args: z.array(z.unknown()).optional(),
        path: z.array(z.string()).optional(),
      }),
    },
    async ({ selector, args, path }) => {
      if (selector !== undefined) {
        return { content: [jsonText(control.querySelector(api, selector, args))] };
      }
      if (path !== undefined) {
        return { content: [jsonText(control.queryStatePath(api, path))] };
      }
      throw new Error("Provide either `selector` or `path`.");
    },
  );

  server.registerTool(
    "list_profiles",
    {
      description:
        "List Vortex profiles (defaults to every game; pass gameId to filter to one), with " +
        "name, active status, and mod counts — a formatted join vortex_query can't do in one " +
        "call: the raw path (persistent.profiles) dumps every profile's full per-mod enabled " +
        "state, which can run past 500K characters and blow the response limit on a large " +
        "modlist (found live). Sorted most-recently-activated first.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Filter to profiles for this game id"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(control.listProfiles(api, gameId))],
    }),
  );

  server.registerTool(
    "list_mods",
    {
      description:
        "List mods for a game (defaults to the active game), with friendly names and enabled " +
        "state for the active profile — a formatted join vortex_query can't do in one call. " +
        "A large modlist (hundreds of mods) can exceed the client's response size limit; use " +
        "enabledOnly/nameFilter/limit to narrow the result rather than requesting everything.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        enabledOnly: z.boolean().optional().describe("Only include currently-enabled mods"),
        nameFilter: z.string().optional().describe("Case-insensitive substring match on mod name"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the number of results returned"),
      }),
    },
    async ({ gameId, enabledOnly, nameFilter, limit }) => ({
      content: [jsonText(control.listMods(api, gameId, { enabledOnly, nameFilter, limit }))],
    }),
  );

  server.registerTool(
    "list_load_order",
    {
      description:
        "List the current Gamebryo/LOOT plugin load order (.esp/.esm/.esl), sorted by index. " +
        "Only available for games using plugin-based load ordering (e.g. Skyrim, Fallout) — " +
        "throws for games that don't have one active.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.listLoadOrder(api))],
    }),
  );

  server.registerTool(
    "list_categories",
    {
      description:
        "List a game's mod categories (defaults to the active game), sorted by display order, " +
        "with a mod count per category — a join vortex_query can't do in one call.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(control.listCategories(api, gameId))],
    }),
  );

  server.registerTool(
    "list_downloads",
    {
      description:
        "List the download queue/history for a game (defaults to the active game): name, " +
        "state, progress percent, size, start time — a formatted view raw vortex_query " +
        "selectors (downloadsForGame/activeDownloads) don't give you in one call. Defaults " +
        "to every state except 'finished' (found live: a real download history can run " +
        "hundreds of entries deep and blow the response size limit if you dump it all — " +
        "what's usually wanted is what's active/stuck/failed, not the archive). Pass " +
        "states=['finished'] (optionally alongside others) to include completed downloads; " +
        "use limit to cap results, most-recently-started first.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        states: z
          .array(z.string())
          .optional()
          .describe(
            "Only these download states (init/started/paused/finalizing/finished/failed/" +
              "redirect); omit for every state except 'finished'",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the number of results, most-recently-started first"),
      }),
    },
    async ({ gameId, states, limit }) => ({
      content: [jsonText(control.listDownloads(api, gameId, { states, limit }))],
    }),
  );

  server.registerTool(
    "list_notifications",
    {
      description:
        "List Vortex's current notifications (errors, warnings, info) — what Vortex itself " +
        "is currently flagging as a problem, useful for diagnosing 'mod is enabled but " +
        "doesn't work'-class issues.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.listNotifications(api))],
    }),
  );

  server.registerTool(
    "list_mod_rules",
    {
      description:
        "List a mod's dependency/conflict rules (before/after/requires/conflicts/...), " +
        "resolving each reference to the target mod's friendly name when it's installed — " +
        "a join vortex_query can't do in one call.",
      inputSchema: z.object({
        modId: z.string().describe("Mod id (query list_mods to find one)"),
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ modId, gameId }) => ({
      content: [jsonText(control.listModRules(api, modId, gameId))],
    }),
  );

  server.registerTool(
    "find_mod_by_file",
    {
      description:
        "Find which installed mod(s) contain a file with this name, by scanning mod " +
        "staging folders on disk (no reflectable API exposes this). Scans only enabled " +
        "mods by default — fast; pass includeDisabled to search every installed mod " +
        "instead (much slower for a large modlist, but useful for an orphaned/leftover " +
        "file whose owning mod isn't currently enabled).",
      inputSchema: z.object({
        filename: z.string().describe("Bare file name to search for, e.g. 'texture.dds'"),
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        includeDisabled: z
          .boolean()
          .optional()
          .describe("Search every installed mod, not just enabled ones (slower)"),
      }),
    },
    async ({ filename, gameId, includeDisabled }) => ({
      content: [jsonText(await control.findModByFile(api, filename, { gameId, includeDisabled }))],
    }),
  );

  server.registerTool(
    "list_file_conflicts",
    {
      description:
        "List files provided by more than one currently-enabled mod (for the active/given " +
        "profile) — the read side of conflict resolution; found by scanning mod staging " +
        "folders on disk, no reflectable API exposes this. Each entry's `risk` is a coarse " +
        "file-type hint (high: plugins/scripts/archives, medium: interface/config, low: " +
        "everything else, e.g. meshes/textures) — not a winner. Doesn't report a winner — " +
        "Vortex's actual resolution depends on deploy/rule order in ways not safe to " +
        "reimplement here. Resolve a conflict via vortex_dispatch: setFileOverride to pick " +
        "a winning mod for specific files, or addModRule with type 'before'/'after' to " +
        "control deploy order between two mods.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        nameFilter: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on the conflicting file's path"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the number of results returned"),
      }),
    },
    async ({ gameId, nameFilter, limit }) => ({
      content: [jsonText(await control.listFileConflicts(api, { gameId, nameFilter, limit }))],
    }),
  );

  server.registerTool(
    "find_missing_masters",
    {
      description:
        "Find enabled plugins whose master files aren't themselves enabled — reads each " +
        "plugin's real TES4 header from the game's Data folder (the Bethesda plugin " +
        "format's own binary spec, not Vortex-specific), since Vortex doesn't expose a " +
        "resolved-masters selector. A very common real troubleshooting need (a patch " +
        "enabled without its base mod).",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(await control.findMissingMasters(api, gameId))],
    }),
  );

  server.registerTool(
    "list_runtime_errors",
    {
      description:
        "Read recent Papyrus error lines and crash log excerpts from the game's real " +
        "save-data folder (Documents/My Games/<game>) — Vortex has no concept of game " +
        "runtime logs, this is pure filesystem reading. Doesn't try to parse or explain " +
        "crash log internals (format varies by crash-logging mod) — surfaces the raw " +
        "excerpt for you to reason about. Each entry's `mentionedFiles` lists any .esp/" +
        ".esm/.esl/.dll/.pex filenames spotted in the text — pass one to find_mod_by_file " +
        "to resolve which mod it belongs to. Only supports games with a verified save-data " +
        "folder name (currently skyrimse, skyrimvr) — throws clearly for anything else.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        maxCrashLogs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap how many recent crash logs to include (default 3)"),
      }),
    },
    async ({ gameId, maxCrashLogs }) => ({
      content: [jsonText(await control.listRuntimeErrors(api, { gameId, maxCrashLogs }))],
    }),
  );

  server.registerTool(
    "list_duplicate_mods",
    {
      description:
        "Find installed mods that look like duplicates or redundant leftovers — never " +
        "auto-resolved, purely informational (same 'report candidates, don't decide' " +
        "stance as list_file_conflicts). Two checks: more than one installed mod sharing " +
        "the same Nexus mod id (metadata-only, cheap), and mods whose entire file set is " +
        "contained in another mod's (usually an old/redundant version left installed). " +
        "Scans only enabled mods by default — fast; includeDisabled searches every " +
        "installed mod instead (much slower for a large modlist).",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        includeDisabled: z
          .boolean()
          .optional()
          .describe("Search every installed mod, not just enabled ones (slower)"),
      }),
    },
    async ({ gameId, includeDisabled }) => ({
      content: [jsonText(await control.listDuplicateMods(api, { gameId, includeDisabled }))],
    }),
  );

  server.registerTool(
    "list_known_mod_conflicts",
    {
      description:
        "Surfaces real 'conflicts'-type rules Vortex already has recorded on enabled mods " +
        "(mod.rules — the same field list_mod_rules reads, often populated from Nexus mod " +
        "page metadata or added by the user). Genuine Vortex data, not invented " +
        "compatibility knowledge — `targetEnabled` tells you whether the conflicting mod " +
        "is actually active right now.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(control.listKnownModConflicts(api, gameId))],
    }),
  );

  server.registerTool(
    "find_missing_deployed_files",
    {
      description:
        "Find plugins where Vortex's load-order state, what's actually deployed to the " +
        "game's Data folder, and what the game's own plugins.txt says is active all " +
        "disagree — reads both real files directly rather than trusting Vortex's " +
        "in-memory state alone, since a deploy can silently partially fail. " +
        "`activeInPluginsTxt` is `null` when the plugin isn't listed there at all — " +
        "normal for game/DLC masters, which the engine activates implicitly without an " +
        "entry, so that's never itself a discrepancy. No verdict about which source is " +
        "'right'. Only supports games with a verified save-data folder name (currently " +
        "skyrimse, skyrimvr).",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => ({
      content: [jsonText(await control.findMissingDeployedFiles(api, gameId))],
    }),
  );

  server.registerTool(
    "check_nexus_mod_updates",
    {
      description:
        "Check installed Nexus-sourced mods for available updates via Vortex's own " +
        "built-in integration and the user's existing Vortex login — no separate API " +
        "key. Kept as a dedicated tool (unlike get-mod-info, now folded into " +
        "vortex_query's extApi mode) because it does a real join vortex_query can't do " +
        "in one call: resolving mod ids to full IMod records and filtering to Nexus-" +
        "sourced ones before calling the underlying api.ext function. Defaults to every " +
        "installed mod with source 'nexus'; pass modIds to check a specific subset. " +
        "Consumes the user's real Nexus API request quota — don't call this in a loop. " +
        "WARNING: the no-args (check everything) form makes one real network call per " +
        "mod through Vortex's own nexusCheckModsVersion and has been observed to exceed " +
        "a 300s MCP call timeout on a 50+ mod list, with no partial results if it times " +
        "out — for anything beyond a small collection, prefer passing modIds for a " +
        "bounded, fast check (confirmed near-instant on 3 mods) rather than the full scan.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
        modIds: z
          .array(z.string())
          .optional()
          .describe("Vortex mod ids to check; defaults to every installed Nexus-sourced mod"),
      }),
    },
    async ({ gameId, modIds }) => ({
      content: [jsonText(await control.checkNexusModUpdates(api, gameId, modIds))],
    }),
  );

  server.registerTool(
    "list_dialogs",
    {
      description:
        "List Vortex's currently-open modal dialogs (e.g. a 'files changed outside " +
        "Vortex' prompt that can block a deploy) — distinct from list_notifications' " +
        "toast notifications. Each entry's `actions` array is the exact set of labels " +
        "closeDialog's actionKey must match (via vortex_dispatch) — read this before " +
        "responding, never guess a choice.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [jsonText(control.listDialogs(api))],
    }),
  );
}

function registerWriteTools(server: McpServer, api: IExtensionApi): void {
  const jsonText = makeJsonText(api);
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
    "clone_profile",
    {
      description:
        "Clone an existing profile into a new one (copies its on-disk profile directory " +
        "— load order, ini tweaks — plus its mod enabled-state), the same operation as " +
        "Vortex's own 'Clone' button. Only ever reads the source profile; never modifies it " +
        "or switches the active profile.",
      inputSchema: z.object({
        sourceProfileId: z
          .string()
          .describe("Profile id to clone (query selector='profiles' to list)"),
        name: z
          .string()
          .optional()
          .describe("Name for the new profile; defaults to '<source> (clone)'"),
      }),
    },
    async ({ sourceProfileId, name }) => {
      const cloned = await control.cloneProfile(api, sourceProfileId, name);
      return { content: [jsonText(cloned)] };
    },
  );

  server.registerTool(
    "vortex_dispatch",
    {
      description:
        "Dispatch a named Vortex action creator, api.ext function, event, or direct api " +
        "method — tried in that order. (1) Redux action creator (e.g. action='setModEnabled'). " +
        "(2) api.ext function (e.g. action='nexusGetModInfo'). (3) a currently-registered " +
        "event name, emitted via api.events.emit — most fire-and-forget by default; pass " +
        '"__CALLBACK__" as one of the args at the position Vortex\'s own handler expects a ' +
        "Node-style (err, result?) => void callback and vortex_dispatch will await real " +
        "completion instead (e.g. action='deploy-mods', args=['__CALLBACK__'] resolves once " +
        "deployment actually finishes, not just once it started). (4) a direct method on the " +
        "api object itself (e.g. action='sendNotification') — a small subset of these " +
        "(onStateChange, onAsync, registerProtocol, registerRepositoryLookup; see " +
        "vortex_describe's `listenerHints`) register a persistent listener instead of " +
        'performing a one-off action: pass "__CALLBACK__" the same way, and this returns a ' +
        "listenerId immediately rather than waiting for anything — poll what it's captured " +
        "with poll_listener. Not allowlisted: everything in vortex_describe's `actions`/" +
        "`extensionApis`/`eventNames`/`apiMethods` lists is callable this way once you hold " +
        "the write-tier token — that token, not a curated list, is the actual security " +
        "boundary, matching what a human at Vortex's own UI can already do. Use " +
        "vortex_describe's `dispatchHints`/`extensionApiHints`/`eventHints`/`listenerHints` " +
        "for the real argument order (incl. the __CALLBACK__ position) where this project has " +
        "verified one; for anything else, check Vortex's source or test carefully with a " +
        "state read before/after.",
      inputSchema: z.object({
        action: z.string().describe("Action creator, api.ext function, event, or api method name"),
        args: z
          .array(z.unknown())
          .optional()
          .describe(
            "Positional arguments for the action creator/function/event/method " +
              '(include "__CALLBACK__" at the callback position to await a callback-based ' +
              "event, or to register a persistent listener)",
          ),
      }),
    },
    async ({ action, args }) => {
      const dispatched = await control.dispatchAction(api, action, args);
      return { content: [jsonText(dispatched)] };
    },
  );

  server.registerTool(
    "poll_listener",
    {
      description:
        "Read back what a persistent listener registered via vortex_dispatch (onStateChange/" +
        "onAsync/registerProtocol/registerRepositoryLookup) has captured. Non-destructive — " +
        "repeated polling with the same `since` returns the same entries; the listener's own " +
        "ring buffer (capped at 500 firings, oldest dropped) is what bounds memory, not " +
        "draining on read. Pass back the returned `lastSeq` as the next call's `since` to get " +
        "only what's arrived since. Listeners don't survive a Vortex restart.",
      inputSchema: z.object({
        listenerId: z
          .string()
          .describe("Id returned by the vortex_dispatch call that registered it"),
        since: z
          .number()
          .int()
          .optional()
          .default(0)
          .describe("Only return entries after this seq (e.g. a previous call's lastSeq)"),
      }),
    },
    async ({ listenerId, since }) => ({
      content: [jsonText(control.pollListener(listenerId, since))],
    }),
  );

  server.registerTool(
    "backup_state",
    {
      description:
        "Create a full snapshot of Vortex's settings/persistent/app/user state as a JSON file " +
        "in Vortex's own backup folder (%APPDATA%/vortex/temp/state_backups_full) — the same " +
        "data Vortex's own manual/hourly backups capture, reproduced from the published API " +
        "since the backup function itself isn't exported. Pure read + file write; does not " +
        "touch Vortex's live state.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe("Label included in the backup filename; defaults to 'mcp'"),
      }),
    },
    async ({ name }) => {
      const backupPath = await control.backupState(api, name);
      return { content: [{ type: "text", text: `Backup written to ${backupPath}` }] };
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
    "launch_game",
    {
      description:
        "Launch a game's configured primary tool (e.g. SKSE, or the vanilla exe if none " +
        "is set) — the same operation as Vortex's own 'Play' button, including its " +
        "suggestDeploy check, which can surface a blocking dialog (see list_dialogs/" +
        "vortex_dispatch's closeDialog) if files changed outside Vortex since the last " +
        "deploy. Throws if the game has no primary tool configured.",
      inputSchema: z.object({
        gameId: z.string().optional().describe("Game id; defaults to the active game"),
      }),
    },
    async ({ gameId }) => {
      await control.launchGame(api, gameId);
      return { content: [{ type: "text", text: `Launched ${gameId ?? "active game"}` }] };
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
