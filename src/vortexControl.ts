import path from "node:path";
import crypto from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";

import { actions, selectors, util, fs, log, types } from "@nexusmods/vortex-api";

type IExtensionApi = types.IExtensionApi;
type IMod = types.IMod;
type IProfile = types.IProfile;

// Not part of @nexusmods/vortex-api — window.api is Vortex's own Electron preload
// bridge (contextBridge), reachable because this extension shares the renderer
// process. Unlike vortex-api this isn't a published contract Nexus Mods commits to
// keeping stable; it can change across Vortex releases without warning.
declare const window: { api?: { app?: { relaunch: (args?: string[]) => void } } };

/**
 * Restarts Vortex via its own graceful relaunch path (the same one behind Vortex's
 * "Restart now" button): closes windows and lets Vortex's normal shutdown sequence
 * (finalize in-progress operations, flush its database) run before actually quitting.
 * Not a hard process kill.
 */
export function restartVortex(): void {
  const relaunch = window.api?.app?.relaunch;
  if (relaunch === undefined) {
    throw new Error("window.api.app.relaunch is unavailable (unexpected Vortex preload shape)");
  }
  relaunch();
}

// Matches store.ts's FULL_BACKUP_PATH constant (not exported from @nexusmods/vortex-api),
// so a backup taken here lands in the same folder as Vortex's own manual/hourly backups.
const FULL_BACKUP_PATH = "state_backups_full";

/**
 * Writes a full snapshot of Vortex's settings/persistent/app/user state to Vortex's own
 * backup folder, reproducing store.ts's createFullStateBackup (not exported from
 * @nexusmods/vortex-api) from public pieces only: no session/extension persistors, no
 * credentials — the same fields Vortex's own backup captures.
 */
export async function backupState(api: IExtensionApi, name = "mcp"): Promise<string> {
  const st = state(api) as unknown as Record<string, unknown>;
  const backup = {
    settings: st.settings,
    persistent: st.persistent,
    app: st.app,
    user: st.user,
  };
  const serialized = JSON.stringify(backup, undefined, 2);

  const basePath = path.join(util.getVortexPath("userData"), "temp", FULL_BACKUP_PATH);
  const backupFilePath = path.join(basePath, `${name}-${Date.now()}.json`);

  await fs.ensureDirWritableAsync(basePath, () => Promise.resolve());
  await util.writeFileAtomic(backupFilePath, serialized);

  log("info", "[vortex-mcp] state backup created", {
    path: backupFilePath,
    size: serialized.length,
  });
  return backupFilePath;
}

export interface ModSummary {
  id: string;
  name: string;
  type: string;
  version?: string;
  enabled: boolean;
}

function state(api: IExtensionApi): types.IState {
  if (api.store === undefined) {
    throw new Error("Vortex store not initialized yet");
  }
  return api.store.getState() as types.IState;
}

function store(api: IExtensionApi) {
  if (api.store === undefined) {
    throw new Error("Vortex store not initialized yet");
  }
  return api.store;
}

export interface ApiDescription {
  /** Names callable via query({ selector, args }) — each is (state, ...args) => value. */
  selectors: string[];
  /**
   * Notes for the selectors this project has verified are easy to reach for and get
   * wrong — same "documentation, not a gate" role as dispatchHints. A selector missing
   * here is still fully callable; you just don't get a pre-verified caveat.
   */
  selectorHints: Record<string, string>;
  /**
   * All of Vortex's action-creator names — every one of these is dispatchable via
   * vortex_dispatch. The loopback bind + bearer token is the actual security boundary
   * (matches what a human at Vortex's own UI can already do); there is no further
   * per-action allowlist on top of that.
   */
  actions: string[];
  /**
   * Real positional argument order for the actions this project has bothered to verify
   * against Vortex's own source/behavior, e.g. "gameId: string, modId: string" — pure
   * documentation to save you a source-read, not a list of what's callable (see `actions`
   * for that — everything there works). An action missing here still dispatches fine;
   * you just don't get a pre-verified argument order.
   */
  dispatchHints: Record<string, string>;
  /** Top-level keys of the Redux state tree, walkable via query({ path }). */
  stateKeys: string[];
  /**
   * Names extensions have exposed via context.registerAPI (api.ext.<name>) — Vortex core's
   * own (Nexus/Mods/Downloads helpers) plus any third-party extension that does the same.
   * All of these are callable via vortex_dispatch too (same token boundary as `actions`) —
   * arbitrary signatures, so there's no uniform arg format to validate against, but nothing
   * here is specially blocked.
   */
  extensionApis: string[];
  /** Positional argument order for the extensionApis entries this project has verified — same caveat as dispatchHints. */
  extensionApiHints: Record<string, string>;
  /**
   * Direct method names on the live IExtensionApi instance (api.foo(...)) — distinct
   * from selectors/actions/extensionApis. This is how a real capability gap got found:
   * runExecutable (launching a game/tool) is one of these, not a Redux action or an
   * api.ext export, so nothing in the other three lists would ever surface it. All of
   * these are dispatchable via vortex_dispatch too (same token boundary) — a few are
   * UI-only pickers (selectDir/selectFile/selectExecutable); the ones that register a
   * persistent listener (onStateChange, onAsync, registerProtocol,
   * registerRepositoryLookup) go through a listenerId + poll_listener flow instead of
   * returning a normal result — see listenerHints. withPrePost returns a wrapped
   * function and isn't usefully dispatchable at all (see dispatchAction's error for it).
   */
  apiMethods: string[];
  /**
   * Event names api.events.emit(name, ...args) can trigger, discovered from
   * currently-registered listeners (api.events.eventNames()) rather than hardcoded. All
   * of these are dispatchable via vortex_dispatch too — see eventHints for the
   * CALLBACK_SENTINEL convention needed to await actual completion on the few that use a
   * callback, rather than just firing.
   */
  eventNames: string[];
  /** Positional argument order (incl. CALLBACK_SENTINEL position) for the eventNames entries this project has verified. */
  eventHints: Record<string, string>;
  /**
   * Positional argument order (incl. CALLBACK_SENTINEL position) for the apiMethods that
   * register a persistent listener instead of returning a normal result — dispatching
   * one of these returns { listenerId }; read what it's captured via poll_listener.
   */
  listenerHints: Record<string, string>;
}

export function describeApi(api: IExtensionApi): ApiDescription {
  const st = state(api);
  const apiRecord = api as unknown as Record<string, unknown>;
  return {
    selectors: Object.keys(selectors).toSorted(),
    selectorHints: Object.fromEntries(SELECTOR_HINTS),
    actions: Object.keys(actions).toSorted(),
    dispatchHints: Object.fromEntries(ACTION_HINTS),
    stateKeys: Object.keys(st as object).toSorted(),
    extensionApis: Object.keys(api.ext ?? {}).toSorted(),
    extensionApiHints: Object.fromEntries(EXTENSION_API_HINTS),
    apiMethods: Object.keys(apiRecord)
      .filter((key) => typeof apiRecord[key] === "function")
      .toSorted(),
    eventNames: api.events
      .eventNames()
      .filter((name): name is string => typeof name === "string")
      .toSorted(),
    eventHints: Object.fromEntries(EVENT_HINTS),
    listenerHints: Object.fromEntries(
      Object.entries(LISTENER_SPECS).map(([name, spec]) => [name, spec.hint]),
    ),
  };
}

export function querySelector(api: IExtensionApi, name: string, args: unknown[] = []): unknown {
  const fn = (selectors as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`Unknown selector: ${name}. Call describeApi() for the available list.`);
  }
  return (fn as (...fnArgs: unknown[]) => unknown)(state(api), ...args);
}

export function queryStatePath(api: IExtensionApi, statePath: string[]): unknown {
  let value: unknown = state(api);
  for (const key of statePath) {
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

// Pure documentation, same "verified subset, not a gate" shape as ACTION_HINTS below —
// a selector missing here still queries fine, you just don't get a pre-verified caveat.
const SELECTOR_HINTS = new Map<string, string>([
  [
    "knownGames",
    "Vortex's full static game catalog (~5000 entries, every game Vortex ships support " +
      "for) — found live to run past 60K characters and blow the response size limit. " +
      'For "what games are actually installed/discovered" (almost always what\'s wanted), ' +
      "use selector='discovered' instead — far smaller, real install paths only.",
  ],
]);

// NOT an allowlist — every one of Vortex's ~150 action creators is dispatchable via
// vortex_dispatch (see dispatchAction below). This map is pure documentation: the real
// positional argument order (name: type) for the actions this project has actually
// verified, read from @nexusmods/vortex-api's action-creator payload field names — or,
// for the three entries typed `any` there (setLoadOrderEntry/setFBLoadOrder/
// setFBLoadOrderEntry), from their actual definitions in Vortex source
// (mod_load_order/file_based_loadorder). Surfaced via vortex_describe's dispatchHints so
// a caller doesn't need to go read source first for these; an action missing here still
// works via vortex_dispatch, you just don't get a pre-verified argument order.
//
// The security boundary is the loopback bind + bearer token (see mcpServer.ts) — once an
// operator holds the token they already have "full write privileges" per this project's
// own documented model, matching what a human at Vortex's own UI can already do. An
// earlier version of this file gated vortex_dispatch behind this map's key set, excluding
// "admin-level" actions (paths, extensions, credentials) — removed deliberately: it was a
// second, hand-maintained boundary that didn't protect against a meaningfully different
// threat than the token already does, required manual upkeep for every new safe Vortex
// action, and blocked the trusted case (an agent acting on the operator's own behalf) for
// no real gain against an adversarial one (who'd already have full access via the token).
const ACTION_HINTS = new Map<string, string>([
  ["addMod", "gameId: string, mod: IMod"],
  ["addMods", "gameId: string, mods: IMod[]"],
  ["addModRule", "gameId: string, modId: string, rule: IModRule"],
  ["clearModRules", "gameId: string, modId: string"],
  ["removeMod", "gameId: string, modId: string"],
  [
    "removeModRule",
    "gameId: string, modId: string, rule: IModRule " +
      "(must deep-match the stored rule exactly, incl. reducer-added fields like " +
      "reference.idHint that addModRule fills in even if you didn't pass one — " +
      "read the rule back via list_mod_rules/vortex_query first)",
  ],
  ["setModAttribute", "gameId: string, modId: string, attribute: string, value: any"],
  ["setModAttributes", "gameId: string, modId: string, attributes: Record<string, any>"],
  ["setModArchiveId", "gameId: string, modId: string, archiveId: string"],
  ["setModEnabled", "profileId: string, modId: string, enable: boolean"],
  ["setModInstallationPath", "gameId: string, modId: string, installPath: string"],
  ["setModState", "gameId: string, modId: string, modState: ModState"],
  ["setModType", "gameId: string, modId: string, type: string"],
  ["setCategory", "gameId: string, id: string, category: ICategory"],
  [
    "setCategoryOrder",
    "gameId: string, categoryIds: string[] (the full ordered id list, not just the ones " +
      "you're moving — re-numbers every category's `order` field 0-indexed by array " +
      "position on every call. Dispatching the original id list back restores the same " +
      "relative order but not necessarily the original absolute `order` numbers.)",
  ],
  ["removeCategory", "gameId: string, id: string"],
  ["renameCategory", "gameId: string, categoryId: string, name: string"],
  ["loadCategories", "gameId: string, gameCategories: ICategoryDictionary"],
  ["updateCategories", "gameId: string, gameCategories: ICategoryDictionary"],
  ["setFileOverride", "gameId: string, modId: string, files: string[]"],
  ["setINITweakEnabled", "gameId: string, modId: string, tweak: string, enabled: boolean"],
  ["setLoadOrder", "id: string, order: unknown[]"],
  ["setLoadOrderEntry", "profileId: string, modId: string, loEntry: ILoadOrderEntry"],
  ["setFBLoadOrder", "profileId: string, loadOrder: LoadOrder"],
  ["setFBLoadOrderEntry", "profileId: string, loEntry: ILoadOrderEntry"],
  [
    "setPendingPluginSort",
    "profileId: string, collectionId: string, time: number " +
      "(dispatches cleanly but is a no-op unless the Collections extension is active — " +
      "verify the effect actually landed rather than trusting the dispatch response alone)",
  ],
  ["clearPendingPluginSort", "profileId: string"],
  [
    "removeProfile",
    "profileId: string " +
      "(permanently deletes the profile's on-disk directory — no undo. Only ever call " +
      "this on a profile you created yourself, e.g. via clone_profile, for testing.)",
  ],
  ["setActivator", "gameId: string, activatorId: string"],
  ["setAutoDeployment", "deploy: boolean"],
  ["setCleanupOnDeploy", "cleanup: boolean"],
  ["setConfirmPurge", "confirm: boolean"],
  ["setDeploymentNecessary", "gameId: string, required: boolean"],
  ["setDownloadModInfo", "id: string, key: string, value: any"],
  ["setDownloadHash", "id: string, fileMD5: string"],
  ["mergeDownloadModInfo", "id: string, value: any"],
  ["pauseDownload", "id: string, paused: boolean"],
  ["removeDownload", "id: string"],
  ["removeDownloadSilent", "id: string"],
  ["setDownloadInstalled", "id: string, gameId: string, modId: string"],
  ["setDownloadInterrupted", "id: string, realReceived: number"],
  [
    "closeDialog",
    "id: string, actionKey?: string, input?: unknown " +
      "(actionKey must be one of the dialog's own `actions` labels — read via list_dialogs " +
      "first, never guess; input is only meaningful for a dialog with checkboxes/input " +
      "fields, e.g. { checkbox-id: true } or { input-id: 'value' })",
  ],
  [
    "closeDialogs",
    "ids: string[], actionKey?: string, input?: unknown (same semantics as closeDialog, " +
      "applied to multiple dialogs at once)",
  ],
  [
    "showDialog",
    "type: 'success'|'info'|'error'|'question', title: string, content: IDialogContent " +
      "(e.g. { message: 'text' }), actions: {label: string, default?: boolean}[], id?: string",
  ],
]);

// Positional args for an event dispatched through the `events` fallback below can
// include this literal string at the exact position where Vortex's own event handler
// expects a Node-style (err, result?) callback — e.g. api.events.emit("deploy-mods", cb).
// dispatchAction replaces it with a real callback and returns a promise that resolves/
// rejects with whatever that callback receives, so the caller actually waits for
// completion instead of just firing the event. Omit it entirely for a fire-and-forget
// event (most of them — no callback convention at all).
const CALLBACK_SENTINEL = "__CALLBACK__";

// Real positional argument order (including the exact CALLBACK_SENTINEL position, for
// the ones that use it) for the events this project has verified — same "documentation,
// not a gate" role as ACTION_HINTS/EXTENSION_API_HINTS. Confirmed by what deploy_mods/
// purge_mods/install_mod_from_url/activate_game (removed as dedicated tools once this
// generic mechanism could fully express them) used to call directly.
const EVENT_HINTS = new Map<string, string>([
  [
    "deploy-mods",
    '"__CALLBACK__" — no other args. Resolves once deployment actually finishes ' +
      "(not just once it started).",
  ],
  [
    "purge-mods",
    'allowFallback: boolean, "__CALLBACK__" — resolves once the purge actually finishes.',
  ],
  [
    "start-download",
    'urls: string[] (e.g. ["nxm://..."]), modInfo: object (e.g. {}), unused: null, ' +
      '"__CALLBACK__" — resolves to the new download id. Can trigger a blocking ' +
      '"choose install type" modal for ambiguous archives if the caller doesn\'t await ' +
      "completion carefully — see list_dialogs/closeDialog.",
  ],
  [
    "activate-game",
    "gameId: string — fire-and-forget, no callback (omit the sentinel entirely). Vortex " +
      "validates the id itself; an unknown gameId silently no-ops rather than throwing.",
  ],
]);

async function dispatchEvent(api: IExtensionApi, name: string, args: unknown[]): Promise<unknown> {
  const callbackIndex = args.indexOf(CALLBACK_SENTINEL);
  if (callbackIndex === -1) {
    api.events.emit(name, ...args);
    return { emitted: name };
  }
  return new Promise((resolve, reject) => {
    const realArgs = [...args];
    realArgs[callbackIndex] = (err: unknown, result?: unknown) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } else {
        resolve(result);
      }
    };
    api.events.emit(name, ...realArgs);
  });
}

// A handful of apiMethods don't perform an action — they register a real JS function as
// a persistent listener (fires repeatedly, for the life of the Vortex process; none of
// these expose a way to unregister). A function can't cross JSON-RPC, so — same
// CALLBACK_SENTINEL convention as events — dispatchAction substitutes a real callback
// that appends each firing to an in-process ring buffer and returns a listenerId
// immediately, rather than trying to wait for or return "the result" of something that
// keeps happening. Poll accumulated firings via poll_listener. `returns` is what the
// substituted callback itself must hand back to satisfy the real API's contract (most
// want nothing back; registerRepositoryLookup's callback must resolve to a lookup
// result array, so ours always resolves empty since we're only capturing args here).
const LISTENER_SPECS: Record<
  string,
  { returns: "void" | "promiseUndefined" | "promiseArray"; hint: string }
> = {
  onStateChange: {
    returns: "void",
    hint: 'path: string[], "__CALLBACK__" — fires with (previous, current) on every change to the given state path.',
  },
  onAsync: {
    returns: "promiseUndefined",
    hint: 'eventName: string, "__CALLBACK__" — fires with the event\'s own args each time eventName is emitted via emitAndAwait.',
  },
  registerProtocol: {
    returns: "void",
    hint: 'protocol: string, def: boolean, "__CALLBACK__" — fires with (url, install) when this protocol (e.g. an nxm:// link) is invoked.',
  },
  registerRepositoryLookup: {
    returns: "promiseArray",
    hint:
      'repositoryId: string, preferOverMD5: boolean, "__CALLBACK__" — fires with the lookup id ' +
      "when Vortex needs mod metadata for this repository; the real API expects the callback to " +
      "resolve to lookup results, so ours always resolves [] (only args are captured here).",
  },
};

const MAX_CONCURRENT_LISTENERS = 20;
const MAX_BUFFER_ENTRIES_PER_LISTENER = 500;

interface ListenerEntry {
  seq: number;
  args: unknown[];
  receivedAt: number;
}

interface ListenerRecord {
  name: string;
  buffer: ListenerEntry[];
  nextSeq: number;
}

// Module-level, not per-request: the MCP transport is stateless (no session tied to a
// connection), but this extension runs inside Vortex's own long-lived process, so state
// here survives across separate tool calls just fine — that's what makes register-then-
// poll possible at all.
const listeners = new Map<string, ListenerRecord>();

function registerListener(
  api: IExtensionApi,
  name: string,
  args: unknown[],
): { listenerId: string } {
  const spec = LISTENER_SPECS[name];
  const callbackIndex = args.indexOf(CALLBACK_SENTINEL);
  if (callbackIndex === -1) {
    throw new Error(
      `${name} registers a persistent listener and needs the "__CALLBACK__" sentinel in args ` +
        "at the callback position — see vortex_describe's listenerHints.",
    );
  }
  if (listeners.size >= MAX_CONCURRENT_LISTENERS) {
    throw new Error(
      `Too many active listeners (${MAX_CONCURRENT_LISTENERS} max) — none of these apiMethods ` +
        "support unregistering, so restart Vortex to clear them before registering more.",
    );
  }

  const listenerId = crypto.randomUUID();
  const record: ListenerRecord = { name, buffer: [], nextSeq: 1 };
  listeners.set(listenerId, record);

  const callback = (...callArgs: unknown[]): unknown => {
    record.buffer.push({ seq: record.nextSeq++, args: callArgs, receivedAt: Date.now() });
    if (record.buffer.length > MAX_BUFFER_ENTRIES_PER_LISTENER) {
      record.buffer.shift();
    }
    switch (spec.returns) {
      case "promiseUndefined":
        return Promise.resolve(undefined);
      case "promiseArray":
        return Promise.resolve([]);
      default:
        return undefined;
    }
  };

  const realArgs = [...args];
  realArgs[callbackIndex] = callback;

  const apiFn = (api as unknown as Record<string, unknown>)[name];
  (apiFn as (...fnArgs: unknown[]) => unknown).apply(api, realArgs);

  return { listenerId };
}

/**
 * Reads back what a listener registered via dispatchAction has captured since `since`
 * (a previously-returned `lastSeq`, or 0 for everything still buffered). Non-destructive
 * — repeated polling with the same `since` returns the same entries — the ring buffer
 * itself is what bounds memory, not draining on read.
 */
export function pollListener(
  listenerId: string,
  since = 0,
): { entries: ListenerEntry[]; lastSeq: number } {
  const record = listeners.get(listenerId);
  if (record === undefined) {
    throw new Error(
      `Unknown listenerId: ${listenerId}. It may have never existed, or Vortex restarted — ` +
        "listeners don't survive a restart.",
    );
  }
  const entries = record.buffer.filter((entry) => entry.seq > since);
  return { entries, lastSeq: entries.length > 0 ? entries[entries.length - 1].seq : since };
}

/**
 * Dispatches a named Vortex action creator, api.ext function, event, or direct api
 * method — checked in that order. Not allowlisted: everything vortex_describe reflects
 * is reachable this way, once the caller holds the write-tier bearer token (see
 * ACTION_HINTS's comment for why that token, not a second curated list, is the actual
 * security boundary). Events need the CALLBACK_SENTINEL convention to await actual
 * completion rather than just firing; the small set of apiMethods in LISTENER_SPECS use
 * the same convention to register a persistent listener instead (see registerListener).
 */
export async function dispatchAction(
  api: IExtensionApi,
  name: string,
  args: unknown[] = [],
): Promise<unknown> {
  const fn = (actions as Record<string, unknown>)[name];
  if (typeof fn === "function") {
    const result = (fn as (...fnArgs: unknown[]) => unknown)(...args);
    // Most actions are plain redux-act action creators returning {type, payload}. A few
    // (closeDialog, closeDialogs, showDialog) are thunks — plain functions taking
    // (dispatch, getState) — since Vortex uses redux-thunk middleware, dispatching the
    // function itself (not a {type} object) is the correct call; there's no natural
    // {type, payload} to report back for these, so the response just confirms what ran.
    if (typeof result === "function") {
      store(api).dispatch(result as (...fnArgs: unknown[]) => unknown);
      return { dispatched: name, thunk: true };
    }
    if (
      result === null ||
      typeof result !== "object" ||
      typeof (result as { type?: unknown }).type !== "string"
    ) {
      throw new Error(`${name} did not return a dispatchable action object.`);
    }
    store(api).dispatch(result as { type: string });
    return result;
  }

  const extFn = ((api.ext ?? {}) as unknown as Record<string, unknown>)[name];
  if (typeof extFn === "function") {
    return (extFn as (...fnArgs: unknown[]) => unknown)(...args);
  }

  if (api.events.eventNames().includes(name)) {
    return dispatchEvent(api, name, args);
  }

  if (name in LISTENER_SPECS) {
    return registerListener(api, name, args);
  }

  if (name === "withPrePost") {
    throw new Error(
      "withPrePost returns a wrapped function rather than performing an action or " +
        "registering a listener — it can't be usefully dispatched over MCP (the returned " +
        "function isn't JSON-serializable, and nothing happens until it's invoked, which " +
        "this dispatcher never does).",
    );
  }

  const apiFn = (api as unknown as Record<string, unknown>)[name];
  if (typeof apiFn === "function") {
    return (apiFn as (...fnArgs: unknown[]) => unknown).apply(api, args);
  }

  throw new Error(
    `Unknown action, api.ext function, event, or api method: ${name}. Check vortex_describe's ` +
      "actions/extensionApis/eventNames/apiMethods lists.",
  );
}

export function switchProfile(api: IExtensionApi, profileId: string): void {
  const st = state(api);
  if (selectors.profiles(st)[profileId] === undefined) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  store(api).dispatch(actions.setNextProfile(profileId));
}

export interface ProfileSummary {
  id: string;
  name: string;
  gameId: string;
  active: boolean;
  modCount: number;
  enabledModCount: number;
  lastActivated: number;
}

function summarizeProfile(profile: IProfile, activeProfileId: string | undefined): ProfileSummary {
  const modStates = Object.values(profile.modState ?? {});
  return {
    id: profile.id,
    name: profile.name,
    gameId: profile.gameId,
    active: profile.id === activeProfileId,
    modCount: modStates.length,
    enabledModCount: modStates.filter((m) => m.enabled).length,
    lastActivated: profile.lastActivated,
  };
}

/**
 * Lists profiles (defaults to every game; pass gameId to filter to one) with name,
 * active status, and mod counts — the join vortex_query can't do in one call without
 * dumping the full per-profile modState (persistent.profiles.<id> can run past 500K
 * characters for a large modlist, found live). Sorted most-recently-activated first.
 */
export function listProfiles(api: IExtensionApi, gameId?: string): ProfileSummary[] {
  const st = state(api);
  const activeProfileId = selectors.activeProfileId(st);
  const all = Object.values(selectors.profiles(st)) as IProfile[];
  return all
    .filter((p) => p.pendingRemove !== true)
    .filter((p) => gameId === undefined || p.gameId === gameId)
    .map((p) => summarizeProfile(p, activeProfileId))
    .toSorted((a, b) => b.lastActivated - a.lastActivated);
}

// Mirrors profile_management/util/manage.ts's profilePath — not exported from
// @nexusmods/vortex-api, so reconstructed from the (exported) getVortexPath helper.
function profilePath(profile: IProfile): string {
  return path.join(util.getVortexPath("userData"), profile.gameId, "profiles", profile.id);
}

/**
 * Clones an existing profile: copies its on-disk profile directory (load order,
 * ini tweaks, etc.) to a new profile id, then registers the new profile — the
 * same two steps Vortex's own "Clone" button performs (ProfileView.tsx's
 * onCloneProfile). The source profile is only ever read, never modified.
 */
export async function cloneProfile(
  api: IExtensionApi,
  sourceProfileId: string,
  name?: string,
): Promise<ProfileSummary> {
  const st = state(api);
  const source = selectors.profiles(st)[sourceProfileId];
  if (source === undefined) {
    throw new Error(`Unknown profile: ${sourceProfileId}`);
  }

  const newProfile: IProfile = {
    ...source,
    id: crypto.randomBytes(6).toString("base64url"),
    name: name ?? `${source.name} (clone)`,
  };

  await fs.ensureDirAsync(profilePath(source));
  await fs.copyAsync(profilePath(source), profilePath(newProfile));
  store(api).dispatch(actions.setProfile(newProfile));

  return summarizeProfile(newProfile, selectors.activeProfileId(st));
}

export interface ListModsOptions {
  /** Only include mods currently enabled for the profile. Default false (all mods). */
  enabledOnly?: boolean;
  /** Case-insensitive substring match against the rendered mod name. */
  nameFilter?: string;
  /** Cap the number of results (applied after filtering). Default unlimited. */
  limit?: number;
}

export function listMods(
  api: IExtensionApi,
  gameId?: string,
  options: ListModsOptions = {},
): ModSummary[] {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const profile = selectors.activeProfile(st);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const nameFilterLower = options.nameFilter?.toLowerCase();

  const summaries = Object.values(mods)
    .map((mod) => ({
      id: mod.id,
      name: util.renderModName(mod),
      type: mod.type,
      version: mod.attributes?.version as string | undefined,
      enabled:
        profile?.gameId === targetGameId ? (profile?.modState?.[mod.id]?.enabled ?? false) : false,
    }))
    .filter((mod) => !options.enabledOnly || mod.enabled)
    .filter(
      (mod) => nameFilterLower === undefined || mod.name.toLowerCase().includes(nameFilterLower),
    );

  return options.limit !== undefined ? summaries.slice(0, options.limit) : summaries;
}

export interface CategorySummary {
  id: string;
  name: string;
  order: number;
  parentCategory?: string;
  modCount: number;
}

/**
 * Lists a game's mod categories with a mod count per category — a join
 * state.persistent.categories[gameId] alone can't do, same reasoning as list_mods.
 */
export function listCategories(api: IExtensionApi, gameId?: string): CategorySummary[] {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const categories =
    (queryStatePath(api, ["persistent", "categories", targetGameId]) as
      | Record<string, { name: string; order: number; parentCategory?: string }>
      | undefined) ?? {};
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const modCounts = new Map<string, number>();
  for (const mod of Object.values(mods)) {
    const category = mod.attributes?.category;
    if (category === undefined) {
      continue;
    }
    const key = String(category);
    modCounts.set(key, (modCounts.get(key) ?? 0) + 1);
  }

  return Object.entries(categories)
    .map(([id, cat]) => ({
      id,
      name: cat.name,
      order: cat.order,
      parentCategory: cat.parentCategory,
      modCount: modCounts.get(id) ?? 0,
    }))
    .toSorted((a, b) => a.order - b.order);
}

export interface LoadOrderEntry {
  plugin: string;
  index: number;
  enabled: boolean;
}

/**
 * Reads the current Gamebryo/LOOT plugin load order from state.loadOrder — a top-level
 * key added at runtime by the gamebryo-plugin-management extension, not present in
 * @nexusmods/vortex-api's published IState (discovered live via vortex_describe, not
 * from the type declarations). Games using file_based_loadorder instead (no .esp/.esm
 * plugins) won't have this key; this throws rather than silently returning nothing.
 */
export function listLoadOrder(api: IExtensionApi): LoadOrderEntry[] {
  const raw = queryStatePath(api, ["loadOrder"]) as
    | Record<string, { loadOrder: number; enabled?: boolean }>
    | undefined;
  if (raw === undefined || Object.keys(raw).length === 0) {
    throw new Error(
      "No plugin load order available (state.loadOrder is empty or missing) — this game may " +
        "use a different load-order system (e.g. file_based_loadorder), or none is active.",
    );
  }
  return Object.entries(raw)
    .map(([plugin, entry]) => ({ plugin, index: entry.loadOrder, enabled: entry.enabled ?? true }))
    .toSorted((a, b) => a.index - b.index);
}

export async function setModsEnabled(
  api: IExtensionApi,
  modIds: string[],
  enabled: boolean,
  profileId?: string,
): Promise<void> {
  const st = state(api);
  const targetProfileId = profileId ?? selectors.activeProfileId(st);
  if (!targetProfileId) {
    throw new Error("No active profile and no profileId provided");
  }
  await actions.setModsEnabled(api, targetProfileId, modIds, enabled);
}

interface DiscoveredTool {
  path: string;
  parameters?: string[];
  workingDirectory?: string;
  shell?: boolean;
  detach?: boolean;
}

/**
 * Launches a game's configured primary tool (e.g. SKSE for Skyrim, or the vanilla exe
 * if no script extender is set) via api.runExecutable — the one genuinely missing piece
 * of standard Vortex usage this server didn't cover, because runExecutable is a direct
 * IExtensionApi method (found via vortex_describe's apiMethods, not a Redux action or an
 * emitted event — nothing else in the reflected surface would have shown it).
 *
 * The primary-tool resolution (settings.interface.primaryTool[gameId] ->
 * settings.gameMode.discovered[gameId].tools[toolId]) was found the same way this
 * project always resolves an undocumented state shape: by reading real live state,
 * not guessing from types — there's no selector that does this lookup for us.
 * suggestDeploy: true mirrors Vortex's own "Play" button, which is what actually
 * surfaces the "files changed outside Vortex" prompt list_dialogs/closeDialog exist for.
 */
export async function launchGame(api: IExtensionApi, gameId?: string): Promise<void> {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const toolId = queryStatePath(api, ["settings", "interface", "primaryTool", targetGameId]) as
    | string
    | undefined;
  if (toolId === undefined) {
    throw new Error(
      `No primary tool configured for ${targetGameId} (settings.interface.primaryTool). ` +
        "Set one in Vortex's Tools page first.",
    );
  }
  const tool = queryStatePath(api, [
    "settings",
    "gameMode",
    "discovered",
    targetGameId,
    "tools",
    toolId,
  ]) as DiscoveredTool | undefined;
  if (tool === undefined) {
    throw new Error(`Primary tool '${toolId}' for ${targetGameId} is not in discovered tools.`);
  }
  await api.runExecutable(tool.path, tool.parameters ?? [], {
    cwd: tool.workingDirectory,
    shell: tool.shell ?? false,
    detach: tool.detach ?? true,
    suggestDeploy: true,
  });
  log("info", "[vortex-mcp] launched game", { gameId: targetGameId, toolId, path: tool.path });
}

export interface DownloadSummary {
  id: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  startTime: number;
}

export interface ListDownloadsOptions {
  /**
   * Only include downloads in one of these states ("init"/"started"/"paused"/
   * "finalizing"/"finished"/"failed"/"redirect"). Default: every state except
   * "finished" — found live that an unfiltered dump of a real download history
   * (932 entries, 921 of them long-finished) blows the response size limit;
   * what's actually being asked for is almost always "what's active/stuck/
   * failed", not the archive. Pass states: ["finished"] (or include it
   * alongside others) to see completed downloads too.
   */
  states?: string[];
  /** Cap the number of results, most-recently-started first. Default unlimited. */
  limit?: number;
}

export function listDownloads(
  api: IExtensionApi,
  gameId?: string,
  options: ListDownloadsOptions = {},
): DownloadSummary[] {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const files =
    (queryStatePath(api, ["persistent", "downloads", "files"]) as
      | Record<string, types.IDownload>
      | undefined) ?? {};
  const stateFilter = new Set(options.states ?? []);
  const summaries = Object.values(files)
    .filter((download) => download.game.includes(targetGameId))
    .filter((download) =>
      options.states === undefined
        ? download.state !== "finished"
        : stateFilter.has(download.state),
    )
    .toSorted((a, b) => b.startTime - a.startTime)
    .map((download) => ({
      id: download.id,
      name: download.modInfo?.name ?? download.localPath ?? download.id,
      state: download.state,
      progress:
        download.size > 0 ? Math.round(((download.received ?? 0) / download.size) * 100) : 0,
      size: download.size,
      startTime: download.startTime,
    }));
  return options.limit !== undefined ? summaries.slice(0, options.limit) : summaries;
}

export interface NotificationSummary {
  id?: string;
  type: string;
  title?: string;
  message: string;
}

export function listNotifications(api: IExtensionApi): NotificationSummary[] {
  const st = state(api);
  const notifications = selectors.notifications(st) as types.INotification[];
  return notifications.map((n) => ({ id: n.id, type: n.type, title: n.title, message: n.message }));
}

export interface DialogSummary {
  id: string;
  type: string;
  title: string;
  /** Flattened from content.message/text/bbcode/md/htmlText, whichever is set. */
  message?: string;
  /** The exact labels closeDialog's `actionKey` must match — read this, don't guess. */
  actions: string[];
  defaultAction?: string;
  checkboxes?: { id: string; text?: string; value: boolean }[];
  input?: { id: string; label?: string; value?: string }[];
}

/**
 * Lists Vortex's currently-open modal dialogs (context.api.showDialog), e.g. the
 * "files changed outside Vortex" prompt that can block a deploy. Distinct from
 * list_notifications' toast notifications — same INotificationState slice
 * (state.session.notifications), different field (`dialogs`, confirmed live: not
 * documented anywhere as a state path, only found by tracing IDialog's declared
 * home through @nexusmods/vortex-api's types). Use closeDialog via vortex_dispatch
 * to respond, picking one of this dialog's own `actions` labels.
 */
export function listDialogs(api: IExtensionApi): DialogSummary[] {
  const dialogs =
    (queryStatePath(api, ["session", "notifications", "dialogs"]) as types.IDialog[] | undefined) ??
    [];
  return dialogs.map((d) => {
    const content = d.content as {
      message?: string;
      text?: string;
      bbcode?: string;
      md?: string;
      htmlText?: string;
      checkboxes?: { id: string; text?: string; value: boolean }[];
      input?: { id: string; label?: string; value?: string }[];
    };
    return {
      id: d.id,
      type: d.type,
      title: d.title,
      message: content.message ?? content.text ?? content.bbcode ?? content.md ?? content.htmlText,
      actions: d.actions,
      defaultAction: d.defaultAction,
      checkboxes: content.checkboxes,
      input: content.input,
    };
  });
}

export interface ModRuleSummary {
  type: string;
  targetId: string;
  /** Friendly name of the referenced mod, when it's installed and resolvable. */
  targetName?: string;
  versionMatch?: string;
}

/**
 * Lists a mod's dependency/conflict rules (before/after/requires/conflicts/...),
 * resolving each reference to the target mod's friendly name when it's installed
 * — a join raw reflection can't do, same reasoning as list_mods/list_categories.
 * Real data, not speculative: 184 of 692 mods in the live test profile have rules.
 */
export function listModRules(api: IExtensionApi, modId: string, gameId?: string): ModRuleSummary[] {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const mod = mods[modId];
  if (mod === undefined) {
    throw new Error(`Unknown mod: ${modId}`);
  }
  // IModRule extends an IRule base that isn't fully resolved in the published
  // .d.ts (`type` on the rule, `versionMatch` on the reference are both real at
  // runtime — confirmed against live state — but absent from the exported type).
  type RealModRule = {
    type: string;
    reference: { id?: string; idHint?: string; versionMatch?: string };
  };
  return (mod.rules ?? []).map((ruleTyped) => {
    const rule = ruleTyped as unknown as RealModRule;
    const targetId = rule.reference.id ?? rule.reference.idHint ?? "(unresolved reference)";
    const targetMod = mods[targetId];
    return {
      type: rule.type,
      targetId,
      targetName: targetMod !== undefined ? util.renderModName(targetMod) : undefined,
      versionMatch: rule.reference.versionMatch,
    };
  });
}

// Vortex doesn't expose a selector or reflectable API for "which mod owns this file" or
// "which mods conflict on which files" — the closest event names found via vortex_describe
// (get-mod-files, update-conflicts-and-rules) are undocumented internal conventions with
// unknown argument shapes, not safe to guess blindly on a live install. Both questions are
// answerable directly from data we already have though: each mod's on-disk staging folder
// (settings.mods.installPath[gameId] + mod.installationPath) is real, present state — so
// these two functions answer both by scanning the filesystem themselves, the same kind of
// join list_mods/list_categories/list_mod_rules already do that reflection alone can't.

async function listModFiles(stagingRoot: string, installationPath: string): Promise<string[]> {
  const modDir = path.join(stagingRoot, installationPath);
  let entries: string[];
  try {
    entries = (await readdir(modDir, { recursive: true })) as string[];
  } catch {
    return [];
  }
  const files: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const entryStat = await stat(path.join(modDir, entry));
        if (entryStat.isFile()) {
          files.push(entry);
        }
      } catch {
        // File removed mid-scan or a broken symlink — skip it.
      }
    }),
  );
  return files;
}

// settings.mods.installPath[gameId] is a raw, unresolved template (e.g. "E:\Vortex
// Mods\{game}" — found live, "{game}"/"{userdata}"/"{username}" placeholders via the
// string-template package) — reading it directly, as this used to, silently produced a
// staging root that doesn't exist on disk, so every scan under it (findModByFile among
// others) failed closed with an empty result instead of an error. installPathForGame
// resolves the placeholders the same way Vortex's own mod-install code does.
function stagingRootFor(api: IExtensionApi, gameId: string): string {
  const stagingRoot = selectors.installPathForGame(state(api), gameId) as string | undefined;
  if (stagingRoot === undefined) {
    throw new Error(`No mod staging path configured for ${gameId}`);
  }
  return stagingRoot;
}

export interface ModFileMatch {
  modId: string;
  modName: string;
  relativePath: string;
  enabled: boolean;
}

/**
 * Finds which installed mod(s) contain a file with this name, by scanning mod staging
 * folders on disk (see the note above listModFiles). Scans only enabled mods by default —
 * fast (tens of mods); pass includeDisabled to search every installed mod instead, which
 * is much slower (a real profile can have hundreds) but useful for hunting down an
 * orphaned or leftover file whose owning mod isn't currently enabled.
 */
export async function findModByFile(
  api: IExtensionApi,
  filename: string,
  options: { gameId?: string; includeDisabled?: boolean } = {},
): Promise<ModFileMatch[]> {
  const st = state(api);
  const targetGameId = options.gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const stagingRoot = stagingRootFor(api, targetGameId);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const profile = selectors.activeProfile(st);
  const isEnabled = (modId: string): boolean =>
    profile?.gameId === targetGameId ? (profile?.modState?.[modId]?.enabled ?? false) : false;

  const candidates = Object.values(mods).filter(
    (mod) => options.includeDisabled === true || isEnabled(mod.id),
  );
  const needle = filename.toLowerCase();
  const matches: ModFileMatch[] = [];
  await Promise.all(
    candidates.map(async (mod) => {
      const files = await listModFiles(stagingRoot, mod.installationPath);
      for (const relPath of files) {
        if (path.basename(relPath).toLowerCase() === needle) {
          matches.push({
            modId: mod.id,
            modName: util.renderModName(mod),
            relativePath: relPath,
            enabled: isEnabled(mod.id),
          });
        }
      }
    }),
  );
  return matches;
}

export type FileConflictRisk = "high" | "medium" | "low";

export interface FileConflictEntry {
  /** Relative path (lowercased) within the deployed mod folder that more than one enabled mod provides. */
  file: string;
  mods: { id: string; name: string }[];
  /**
   * A coarse hint for how much a conflict on this file type usually matters — scripts/
   * plugins/archives (high) can affect runtime behavior and quest logic; interface/config
   * (medium) can break menus and generated patch outputs; everything else (low, e.g.
   * meshes/textures) is usually cosmetic. Purely a file-extension classification, not a
   * judgment about THIS specific conflict — still doesn't say who wins or what to do.
   */
  risk: FileConflictRisk;
}

const HIGH_RISK_EXTENSIONS = new Set([".esp", ".esm", ".esl", ".dll", ".pex", ".bsa", ".ba2"]);
const MEDIUM_RISK_EXTENSIONS = new Set([".ini", ".json", ".xml", ".txt", ".swf", ".gfx"]);

function fileConflictRisk(relPath: string): FileConflictRisk {
  const ext = path.extname(relPath).toLowerCase();
  if (HIGH_RISK_EXTENSIONS.has(ext)) {
    return "high";
  }
  if (MEDIUM_RISK_EXTENSIONS.has(ext)) {
    return "medium";
  }
  return "low";
}

/**
 * Finds files provided by more than one currently-enabled mod (for the active/given
 * profile) — the read side of conflict resolution; the write side already exists via
 * vortex_dispatch (setFileOverride to pick a winner, addModRule with type "before"/"after"
 * to control load/deploy order). Deliberately doesn't report a "winner": Vortex's actual
 * resolution depends on deploy/rule order in ways not safe to reimplement here — this
 * just tells you what needs resolving. `risk` is a coarse file-type hint (scripts/plugins
 * matter more than textures), not a resolution.
 */
export async function listFileConflicts(
  api: IExtensionApi,
  options: { gameId?: string; nameFilter?: string; limit?: number } = {},
): Promise<FileConflictEntry[]> {
  const st = state(api);
  const targetGameId = options.gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const stagingRoot = stagingRootFor(api, targetGameId);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const profile = selectors.activeProfile(st);
  const enabledMods =
    profile?.gameId === targetGameId
      ? Object.values(mods).filter((mod) => profile?.modState?.[mod.id]?.enabled === true)
      : [];

  const owners = new Map<string, { id: string; name: string }[]>();
  await Promise.all(
    enabledMods.map(async (mod) => {
      const files = await listModFiles(stagingRoot, mod.installationPath);
      for (const relPath of files) {
        const key = relPath.toLowerCase();
        const list = owners.get(key) ?? [];
        list.push({ id: mod.id, name: util.renderModName(mod) });
        owners.set(key, list);
      }
    }),
  );

  const nameFilterLower = options.nameFilter?.toLowerCase();
  const entries: FileConflictEntry[] = [];
  for (const [file, ownerList] of owners) {
    if (ownerList.length < 2) {
      continue;
    }
    if (nameFilterLower !== undefined && !file.includes(nameFilterLower)) {
      continue;
    }
    entries.push({ file, mods: ownerList, risk: fileConflictRisk(file) });
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  return options.limit !== undefined ? entries.slice(0, options.limit) : entries;
}

// Reads a plugin's (.esp/.esm/.esl) master list straight from its TES4 header — the
// Bethesda plugin format is a fixed, unchanging binary spec (not Vortex-specific), so
// this is safe to implement directly rather than guessing at Vortex behavior. Record
// header: 4-byte type, 4-byte data size (uint32 LE), 16 more header bytes, then that
// many bytes of subrecords (4-byte type, 2-byte size (uint16 LE), data). MAST
// subrecords hold a null-terminated master filename.
async function readPluginMasters(filePath: string): Promise<string[]> {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(24);
    const { bytesRead } = await handle.read(head, 0, 24, 0);
    if (bytesRead < 24 || head.toString("ascii", 0, 4) !== "TES4") {
      return [];
    }
    const dataSize = head.readUInt32LE(4);
    const data = Buffer.alloc(dataSize);
    await handle.read(data, 0, dataSize, 24);
    const masters: string[] = [];
    let offset = 0;
    while (offset + 6 <= data.length) {
      const type = data.toString("ascii", offset, offset + 4);
      const size = data.readUInt16LE(offset + 4);
      const fieldStart = offset + 6;
      if (fieldStart + size > data.length) {
        break;
      }
      if (type === "MAST") {
        let end = fieldStart;
        while (end < fieldStart + size && data[end] !== 0) {
          end++;
        }
        masters.push(data.toString("ascii", fieldStart, end));
      }
      offset = fieldStart + size;
    }
    return masters;
  } finally {
    await handle.close();
  }
}

export interface MissingMastersEntry {
  plugin: string;
  missingMasters: string[];
}

/**
 * Finds enabled plugins whose master files aren't themselves enabled — reads each
 * plugin's real TES4 header from the game's Data folder rather than trusting any
 * Vortex-side bookkeeping, since Vortex doesn't expose a "resolved masters" selector.
 * A very common real troubleshooting need (a patch enabled without its base mod).
 */
export async function findMissingMasters(
  api: IExtensionApi,
  gameId?: string,
): Promise<MissingMastersEntry[]> {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const gamePath = queryStatePath(api, [
    "settings",
    "gameMode",
    "discovered",
    targetGameId,
    "path",
  ]) as string | undefined;
  if (gamePath === undefined) {
    throw new Error(`Game ${targetGameId} is not discovered (no installation path known).`);
  }
  const dataDir = path.join(gamePath, "Data");
  const loadOrder = listLoadOrder(api);
  const enabledPlugins = loadOrder.filter((entry) => entry.enabled).map((entry) => entry.plugin);
  const enabledSet = new Set(enabledPlugins.map((plugin) => plugin.toLowerCase()));

  const results: MissingMastersEntry[] = [];
  await Promise.all(
    enabledPlugins.map(async (plugin) => {
      const masters = await readPluginMasters(path.join(dataDir, plugin)).catch(() => []);
      const missing = masters.filter((master) => !enabledSet.has(master.toLowerCase()));
      if (missing.length > 0) {
        results.push({ plugin, missingMasters: missing });
      }
    }),
  );
  results.sort((a, b) => a.plugin.localeCompare(b.plugin));
  return results;
}

// Vortex doesn't track game logs at all (Papyrus/SKSE/crash logs are the game engine's
// own output, not Vortex state) — these live at a fixed, well-known Bethesda-games
// location: Documents/My Games/<game>. Only games this project has actually verified the
// folder name for are listed — deliberately not guessed for anything else (see the
// clear error below for an unsupported gameId).
const MY_GAMES_FOLDER: Record<string, string> = {
  skyrimse: "Skyrim Special Edition",
  skyrimvr: "Skyrim VR",
};

const MENTIONED_FILE_PATTERN = /\S+\.(?:esp|esm|esl|dll|pex)\b/gi;

function extractMentionedFiles(text: string): string[] {
  const matches = text.match(MENTIONED_FILE_PATTERN) ?? [];
  return [...new Set(matches.map((match) => match.trim()))];
}

export interface RuntimeErrorEntry {
  source: "papyrus" | "crash";
  file: string;
  mtime: string;
  excerpt: string;
  /** .esp/.esm/.esl/.dll/.pex filenames spotted in the text — pass one to find_mod_by_file to resolve. */
  mentionedFiles: string[];
}

/**
 * Reads recent Papyrus error lines and crash log excerpts from the game's real save-data
 * folder (Documents/My Games/<game>) — pure filesystem reading, since Vortex has no
 * concept of game runtime logs. Doesn't try to parse or explain crash log internals
 * (format varies by crash-logging mod) — just surfaces the raw excerpt for the caller
 * to reason about, and lists any mod-ish filenames mentioned so find_mod_by_file can
 * resolve them.
 */
export async function listRuntimeErrors(
  api: IExtensionApi,
  options: { gameId?: string; maxCrashLogs?: number } = {},
): Promise<RuntimeErrorEntry[]> {
  const st = state(api);
  const targetGameId = options.gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const myGamesFolder = MY_GAMES_FOLDER[targetGameId];
  if (myGamesFolder === undefined) {
    throw new Error(
      `Don't know the save-data folder name for ${targetGameId}. Supported: ` +
        Object.keys(MY_GAMES_FOLDER).join(", "),
    );
  }
  const documentsPath = util.getVortexPath("documents");
  const gameDocsRoot = path.join(documentsPath, "My Games", myGamesFolder);

  const entries: RuntimeErrorEntry[] = [];

  const papyrusPath = path.join(gameDocsRoot, "Logs", "Script", "Papyrus.0.log");
  try {
    const content = await readFile(papyrusPath, "utf8");
    const papyrusStat = await stat(papyrusPath);
    const errorLines = content.split(/\r?\n/).filter((line) => /error/i.test(line));
    for (const line of errorLines.slice(-50)) {
      entries.push({
        source: "papyrus",
        file: papyrusPath,
        mtime: papyrusStat.mtime.toISOString(),
        excerpt: line.trim(),
        mentionedFiles: extractMentionedFiles(line),
      });
    }
  } catch {
    // No Papyrus log yet — nothing to report from this source.
  }

  const skseDir = path.join(gameDocsRoot, "SKSE");
  try {
    const files = await readdir(skseDir);
    const crashFiles = files.filter((file) => /^crash-.*\.log$/i.test(file));
    const withStats = await Promise.all(
      crashFiles.map(async (file) => ({ file, fileStat: await stat(path.join(skseDir, file)) })),
    );
    withStats.sort((a, b) => b.fileStat.mtimeMs - a.fileStat.mtimeMs);
    const maxCrashLogs = options.maxCrashLogs ?? 3;
    for (const { file, fileStat } of withStats.slice(0, maxCrashLogs)) {
      const fullPath = path.join(skseDir, file);
      const content = await readFile(fullPath, "utf8");
      const excerpt = content.split(/\r?\n/).slice(0, 15).join("\n");
      entries.push({
        source: "crash",
        file: fullPath,
        mtime: fileStat.mtime.toISOString(),
        excerpt,
        mentionedFiles: extractMentionedFiles(excerpt),
      });
    }
  } catch {
    // No SKSE folder / no crash logs — nothing to report from this source.
  }

  return entries;
}

export type DuplicateModReason = "same-nexus-id" | "file-subset";

export interface DuplicateModGroup {
  reason: DuplicateModReason;
  mods: { id: string; name: string }[];
  detail: string;
}

/**
 * Finds installed mods that look like duplicates or redundant leftovers — never
 * auto-resolved, purely informational (same "report candidates, don't decide" stance as
 * list_file_conflicts). Two independent checks:
 *  - same-nexus-id: more than one installed mod sharing the same Nexus mod.attributes.modId
 *    (metadata-only, cheap, runs across the full candidate set).
 *  - file-subset: mod B's entire file set is contained in mod A's — usually an old/
 *    redundant version left installed. O(n^2) file-set comparisons, so scanning every
 *    installed mod (includeDisabled) can be slow for a large modlist; enabled-only (the
 *    default) is fast.
 */
export async function listDuplicateMods(
  api: IExtensionApi,
  options: { gameId?: string; includeDisabled?: boolean } = {},
): Promise<DuplicateModGroup[]> {
  const st = state(api);
  const targetGameId = options.gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const stagingRoot = stagingRootFor(api, targetGameId);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const profile = selectors.activeProfile(st);
  const isEnabled = (modId: string): boolean =>
    profile?.gameId === targetGameId ? (profile?.modState?.[modId]?.enabled ?? false) : false;
  const candidates = Object.values(mods).filter(
    (mod) => options.includeDisabled === true || isEnabled(mod.id),
  );

  const groups: DuplicateModGroup[] = [];

  const byNexusId = new Map<string, IMod[]>();
  for (const mod of candidates) {
    const attrs = mod.attributes as { source?: string; modId?: string | number } | undefined;
    if (attrs?.source !== "nexus" || attrs.modId === undefined) {
      continue;
    }
    const key = String(attrs.modId);
    const list = byNexusId.get(key) ?? [];
    list.push(mod);
    byNexusId.set(key, list);
  }
  for (const [nexusId, modsForId] of byNexusId) {
    if (modsForId.length > 1) {
      groups.push({
        reason: "same-nexus-id",
        mods: modsForId.map((mod) => ({ id: mod.id, name: util.renderModName(mod) })),
        detail: `Nexus mod id ${nexusId} installed ${modsForId.length} times`,
      });
    }
  }

  const fileSets = new Map<string, Set<string>>();
  await Promise.all(
    candidates.map(async (mod) => {
      const files = await listModFiles(stagingRoot, mod.installationPath);
      fileSets.set(mod.id, new Set(files.map((file) => file.toLowerCase())));
    }),
  );
  for (const outer of candidates) {
    for (const inner of candidates) {
      if (outer.id === inner.id) {
        continue;
      }
      const outerFiles = fileSets.get(outer.id);
      const innerFiles = fileSets.get(inner.id);
      if (
        outerFiles === undefined ||
        innerFiles === undefined ||
        innerFiles.size === 0 ||
        innerFiles.size >= outerFiles.size
      ) {
        continue;
      }
      const isSubset = [...innerFiles].every((file) => outerFiles.has(file));
      if (isSubset) {
        groups.push({
          reason: "file-subset",
          mods: [
            { id: outer.id, name: util.renderModName(outer) },
            { id: inner.id, name: util.renderModName(inner) },
          ],
          detail: `${util.renderModName(inner)}'s files are all present in ${util.renderModName(outer)}`,
        });
      }
    }
  }

  return groups;
}

export interface KnownModConflictMatch {
  modId: string;
  modName: string;
  targetId: string;
  /** Name of the conflicting mod, only set when that mod is also currently installed. */
  targetName?: string;
  /** True when the conflicting mod is both installed AND currently enabled — an active conflict. */
  targetEnabled: boolean;
}

/**
 * Surfaces real "conflicts"-type rules Vortex already has recorded on installed mods
 * (mod.rules — the same field list_mod_rules reads, often populated from Nexus mod page
 * metadata or added by the user) for the currently-enabled mod set. This is genuine
 * Vortex data, not invented domain knowledge — deliberately does NOT hardcode any
 * mod-compatibility facts of its own.
 */
export function listKnownModConflicts(
  api: IExtensionApi,
  gameId?: string,
): KnownModConflictMatch[] {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const profile = selectors.activeProfile(st);
  const isEnabled = (modId: string): boolean =>
    profile?.gameId === targetGameId ? (profile?.modState?.[modId]?.enabled ?? false) : false;
  const enabledMods = Object.values(mods).filter((mod) => isEnabled(mod.id));

  type RealModRule = { type: string; reference: { id?: string; idHint?: string } };
  const matches: KnownModConflictMatch[] = [];
  for (const mod of enabledMods) {
    const rules = (mod.rules ?? []) as unknown as RealModRule[];
    for (const rule of rules) {
      if (rule.type !== "conflicts") {
        continue;
      }
      const targetId = rule.reference.id ?? rule.reference.idHint ?? "(unresolved reference)";
      const targetMod = mods[targetId];
      matches.push({
        modId: mod.id,
        modName: util.renderModName(mod),
        targetId,
        targetName: targetMod !== undefined ? util.renderModName(targetMod) : undefined,
        targetEnabled: isEnabled(targetId),
      });
    }
  }
  return matches;
}

export interface DeploymentDiscrepancy {
  plugin: string;
  /** Whether Vortex's active-profile load order has this plugin enabled. */
  vortexEnabled: boolean;
  /** Whether the plugin file actually exists in the game's Data folder. */
  existsInDataFolder: boolean;
  /**
   * Whether the game's own plugins.txt marks this plugin active (the "*" prefix).
   * `null` when the plugin isn't listed in plugins.txt at all — confirmed live: game/DLC
   * masters (Skyrim.esm, Update.esm, ...) are activated implicitly by the engine and
   * never appear there, so "not listed" must NOT be treated as "inactive" or every
   * master would show as a permanent false discrepancy. (A plain JS `undefined` here
   * would be silently dropped by JSON.stringify on an object property — unlike the
   * top-level jsonText() case, this needs an explicit null to stay visible on the wire.)
   */
  activeInPluginsTxt: boolean | null;
}

/**
 * Finds plugins where Vortex's load-order state, what's actually deployed to the game's
 * Data folder, and what the game's own plugins.txt says is active all disagree — reads
 * both real files directly rather than trusting Vortex's in-memory state alone, since a
 * deploy can silently partially fail. plugins.txt lives under LOCALAPPDATA (confirmed
 * live — NOT Documents/My Games, an initial guess that was wrong), in a folder matching
 * MY_GAMES_FOLDER's name. Reports raw discrepancies only, no verdict about which source
 * is "right" — matches list_file_conflicts' stance. Only supports games with a verified
 * save-data folder name (see MY_GAMES_FOLDER).
 */
export async function findMissingDeployedFiles(
  api: IExtensionApi,
  gameId?: string,
): Promise<DeploymentDiscrepancy[]> {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const myGamesFolder = MY_GAMES_FOLDER[targetGameId];
  if (myGamesFolder === undefined) {
    throw new Error(
      `Don't know the save-data folder name for ${targetGameId}. Supported: ` +
        Object.keys(MY_GAMES_FOLDER).join(", "),
    );
  }
  const gamePath = queryStatePath(api, [
    "settings",
    "gameMode",
    "discovered",
    targetGameId,
    "path",
  ]) as string | undefined;
  if (gamePath === undefined) {
    throw new Error(`Game ${targetGameId} is not discovered (no installation path known).`);
  }
  const dataDir = path.join(gamePath, "Data");
  const localAppData = util.getVortexPath("localAppData");
  const pluginsTxtPath = path.join(localAppData, myGamesFolder, "plugins.txt");

  const pluginsTxtActive = new Map<string, { active: boolean; displayName: string }>();
  try {
    const content = await readFile(pluginsTxtPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }
      const active = line.startsWith("*");
      const plugin = active ? line.slice(1) : line;
      pluginsTxtActive.set(plugin.toLowerCase(), { active, displayName: plugin });
    }
  } catch {
    // No plugins.txt yet (never deployed/launched) — every plugin is treated as not listed.
  }

  const loadOrder = listLoadOrder(api);
  const loadOrderByLower = new Map(loadOrder.map((entry) => [entry.plugin.toLowerCase(), entry]));
  const pluginKeysLower = new Set([...loadOrderByLower.keys(), ...pluginsTxtActive.keys()]);

  const discrepancies: DeploymentDiscrepancy[] = [];
  await Promise.all(
    [...pluginKeysLower].map(async (key) => {
      const loadOrderEntry = loadOrderByLower.get(key);
      const txtEntry = pluginsTxtActive.get(key);
      const plugin = loadOrderEntry?.plugin ?? txtEntry?.displayName ?? key;
      const vortexEnabled = loadOrderEntry?.enabled ?? false;
      const activeInPluginsTxt = txtEntry?.active ?? null;
      const existsInDataFolder = await stat(path.join(dataDir, plugin))
        .then((s) => s.isFile())
        .catch(() => false);
      const mismatch =
        vortexEnabled !== existsInDataFolder ||
        (activeInPluginsTxt !== null &&
          (vortexEnabled !== activeInPluginsTxt || existsInDataFolder !== activeInPluginsTxt));
      if (mismatch) {
        discrepancies.push({ plugin, vortexEnabled, existsInDataFolder, activeInPluginsTxt });
      }
    }),
  );
  discrepancies.sort((a, b) => a.plugin.localeCompare(b.plugin));
  return discrepancies;
}

// api.ext.* — Vortex's own built-in extension APIs (Nexus Mods integration, using the
// user's existing Vortex login, no separate API key needed; other extensions can add
// more). Not an allowlist — see ACTION_HINTS's comment for why (the token is the real
// boundary); this map is pure documentation for the arg order of the ones this project
// has verified. Real signatures confirmed by reading Vortex's own installed app.asar
// bundle (its source map comments survive minification) rather than guessed.
const EXTENSION_API_HINTS = new Map<string, string>([
  [
    "nexusGetModInfo",
    "gameId: string, nexusModId: number — returns Partial<IModInfo>. nexusModId is the " +
      "Nexus numeric mod id, not the Vortex-internal mod id — look it up first via " +
      "vortex_query path=persistent.mods.<gameId>.<modId>.attributes.modId if you only " +
      "have the Vortex mod id.",
  ],
]);

function getExtensionApi<T>(api: IExtensionApi, name: string): T {
  const fn = ((api.ext ?? {}) as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`${name} isn't available — the extension providing it may not be loaded.`);
  }
  return fn as T;
}

export interface ModUpdateCheckResult {
  checkedCount: number;
  /** Vortex-internal mod ids that have an update available on Nexus. */
  updatedModIds: string[];
}

/**
 * Checks installed Nexus-sourced mods for available updates via Vortex's own built-in
 * integration and the user's existing Vortex login — no separate API key. Defaults to
 * every installed mod with source "nexus"; pass modIds to check a specific subset.
 * Consumes the user's real Nexus API request quota — don't call this in a loop.
 */
export async function checkNexusModUpdates(
  api: IExtensionApi,
  gameId?: string,
  modIds?: string[],
): Promise<ModUpdateCheckResult> {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  const targetMods = (modIds ?? Object.keys(mods))
    .map((id) => mods[id])
    .filter(
      (mod): mod is IMod =>
        mod !== undefined &&
        (mod.attributes as { source?: string } | undefined)?.source === "nexus",
    );
  const fn = getExtensionApi<
    (gameId: string, mods: IMod[], forceFull?: boolean) => Promise<string[]>
  >(api, "nexusCheckModsVersion");
  const updatedModIds = await fn(targetGameId, targetMods, false);
  return { checkedCount: targetMods.length, updatedModIds };
}
