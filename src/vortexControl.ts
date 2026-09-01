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
  /** All of Vortex's action-creator names (informational; most are NOT directly callable). */
  actions: string[];
  /** Subset of `actions` actually callable via vortex_dispatch — see DISPATCHABLE_ACTIONS. */
  dispatchableActions: string[];
  /** Positional argument order for each dispatchableActions entry, e.g. "gameId: string, modId: string". */
  dispatchHints: Record<string, string>;
  /** Top-level keys of the Redux state tree, walkable via query({ path }). */
  stateKeys: string[];
  /**
   * Names extensions have exposed via context.registerAPI (api.ext.<name>) — Vortex core's
   * own (Nexus/Mods/Downloads helpers) plus any third-party extension that does the same.
   * Informational only: unlike `dispatchableActions`, these are arbitrary extension
   * functions with unvetted signatures and side effects, not uniform action creators, so
   * there is no generic caller for them — same reasoning DISPATCHABLE_ACTIONS excludes
   * admin-level actions. A specific one becomes a dedicated tool if it's actually needed.
   */
  extensionApis: string[];
  /** Subset of `extensionApis` actually callable via vortex_query's extApi mode — see EXTENSION_API_ALLOWLIST. */
  callableExtensionApis: string[];
  /** Positional argument order for each callableExtensionApis entry. */
  extensionApiHints: Record<string, string>;
  /**
   * Direct method names on the live IExtensionApi instance (api.foo(...)) — distinct
   * from selectors/actions/extensionApis. This is how a real capability gap got found:
   * runExecutable (launching a game/tool) is one of these, not a Redux action or an
   * api.ext export, so nothing in the other three lists would ever surface it.
   * Informational only, same reasoning as extensionApis — arbitrary signatures/side
   * effects, no uniform generic caller. A specific one becomes a dedicated tool
   * (see launch_game) once it's confirmed live, not guessed from the type declaration.
   */
  apiMethods: string[];
  /**
   * Event names api.events.emit(name, ...args) can trigger, discovered from
   * currently-registered listeners (api.events.eventNames()) rather than hardcoded —
   * the same underlying mechanism deploy_mods/purge_mods/install_mod_from_url already
   * use (deploy-mods/purge-mods/start-download), just made naturally discoverable
   * instead of requiring a source read to find the next one.
   */
  eventNames: string[];
}

export function describeApi(api: IExtensionApi): ApiDescription {
  const st = state(api);
  const apiRecord = api as unknown as Record<string, unknown>;
  return {
    selectors: Object.keys(selectors).toSorted(),
    actions: Object.keys(actions).toSorted(),
    dispatchableActions: [...DISPATCHABLE_ACTIONS.keys()].toSorted(),
    dispatchHints: Object.fromEntries(DISPATCHABLE_ACTIONS),
    stateKeys: Object.keys(st as object).toSorted(),
    extensionApis: Object.keys(api.ext ?? {}).toSorted(),
    callableExtensionApis: [...EXTENSION_API_ALLOWLIST.keys()].toSorted(),
    extensionApiHints: Object.fromEntries(EXTENSION_API_ALLOWLIST),
    apiMethods: Object.keys(apiRecord)
      .filter((key) => typeof apiRecord[key] === "function")
      .toSorted(),
    eventNames: api.events
      .eventNames()
      .filter((name): name is string => typeof name === "string")
      .toSorted(),
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

// Standard user-tooling actions only: mod metadata/rules, categories, load order,
// deployment settings, download bookkeeping, and profile lifecycle. Deliberately
// excludes anything admin-level — game/install/download *paths*, extensions
// (install/enable/remove), credentials/auth, window/network state — even though
// those are otherwise plain action creators the same reflection mechanism could
// reach. This allowlist is the actual enforcement boundary, not just a
// documentation note.
//
// removeProfile is admin-adjacent (permanently deletes the profile's on-disk
// directory, no undo) and included deliberately: it's the only way to clean up
// disposable profiles clone_profile creates for testing. Only ever call it on a
// profile you created for that purpose — never a real user profile.
//
// The value is the real positional argument order (name: type), read from
// @nexusmods/vortex-api's action-creator payload field names — or, for the three
// entries typed `any` there (setLoadOrderEntry/setFBLoadOrder/setFBLoadOrderEntry),
// from their actual definitions in Vortex source (mod_load_order/file_based_loadorder).
// Surfaced via vortex_describe's dispatchHints so a caller doesn't need to go read
// either source to use vortex_dispatch correctly.
const DISPATCHABLE_ACTIONS = new Map<string, string>([
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

/**
 * Dispatches a named, allowlisted Vortex action creator. Covers the bulk of Vortex's
 * mod-management action surface generically (new allowlisted actions become callable
 * without a rebuild), but is not a general escape hatch — see DISPATCHABLE_ACTIONS.
 */
export function dispatchAction(api: IExtensionApi, name: string, args: unknown[] = []): unknown {
  if (!DISPATCHABLE_ACTIONS.has(name)) {
    throw new Error(
      `Action not allowlisted for dispatch: ${name}. This tool covers standard mod-management ` +
        "actions only, not admin-level ones (paths, extensions, credentials).",
    );
  }
  const fn = (actions as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`Unknown action: ${name}.`);
  }
  const result = (fn as (...fnArgs: unknown[]) => unknown)(...args);
  // Most allowlisted actions are plain redux-act action creators returning {type, payload}.
  // A few (closeDialog, closeDialogs, showDialog) are thunks — plain functions taking
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

  return {
    id: newProfile.id,
    name: newProfile.name,
    gameId: newProfile.gameId,
    active: false,
  };
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

export async function deployMods(api: IExtensionApi): Promise<void> {
  await util.toPromise<void>((cb) => api.events.emit("deploy-mods", cb));
}

export async function purgeMods(api: IExtensionApi, allowFallback = false): Promise<void> {
  await util.toPromise<void>((cb) => api.events.emit("purge-mods", allowFallback, cb));
}

export async function installModFromUrl(api: IExtensionApi, url: string): Promise<string> {
  return util.toPromise<string>((cb) =>
    api.events.emit("start-download", [url], {}, undefined, cb),
  );
}

export function activateGame(api: IExtensionApi, gameId: string): void {
  const st = state(api);
  if (selectors.knownGames(st).find((g: types.IGameStored) => g.id === gameId) === undefined) {
    throw new Error(`Unknown game: ${gameId}`);
  }
  api.events.emit("activate-game", gameId);
  log("info", "[vortex-mcp] activated game", { gameId });
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
}

export function listDownloads(api: IExtensionApi, gameId?: string): DownloadSummary[] {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const files =
    (queryStatePath(api, ["persistent", "downloads", "files"]) as
      | Record<string, types.IDownload>
      | undefined) ?? {};
  return Object.values(files)
    .filter((download) => download.game.includes(targetGameId))
    .map((download) => ({
      id: download.id,
      name: download.modInfo?.name ?? download.localPath ?? download.id,
      state: download.state,
      progress:
        download.size > 0 ? Math.round(((download.received ?? 0) / download.size) * 100) : 0,
      size: download.size,
    }));
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

function stagingRootFor(api: IExtensionApi, gameId: string): string {
  const stagingRoot = queryStatePath(api, ["settings", "mods", "installPath", gameId]) as
    | string
    | undefined;
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
// more). Arbitrary signatures, no uniform shape (extensionApis is informational-only in
// vortex_describe) — same reasoning DISPATCHABLE_ACTIONS exists for Redux actions, this
// is the read-side equivalent: an explicit allowlist + one generic caller, reachable via
// vortex_query's `extApi` mode, instead of a bespoke tool per api.ext function (found the
// hard way — get_nexus_mod_info started as its own dedicated tool before being folded in
// here). Real signatures confirmed by reading Vortex's own installed app.asar bundle (its
// source map comments survive minification) rather than guessed.
const EXTENSION_API_ALLOWLIST = new Map<string, string>([
  [
    "nexusGetModInfo",
    "gameId: string, nexusModId: number — returns Partial<IModInfo>. nexusModId is the " +
      "Nexus numeric mod id, not the Vortex-internal mod id — look it up first via " +
      "vortex_query path=persistent.mods.<gameId>.<modId>.attributes.modId if you only " +
      "have the Vortex mod id.",
  ],
]);

function getExtensionApi<T>(api: IExtensionApi, name: string): T {
  const fn = (api.ext as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`${name} isn't available — the extension providing it may not be loaded.`);
  }
  return fn as T;
}

/**
 * Calls a named, allowlisted api.ext function — the read-side counterpart to
 * dispatchAction, for the same reason: most api.ext functions are simple enough
 * (scalar args, no join needed) that a bespoke tool per one would just be tool-count
 * sprawl. See EXTENSION_API_ALLOWLIST's own comment for what's covered and why.
 */
export async function callExtensionApi(
  api: IExtensionApi,
  name: string,
  args: unknown[] = [],
): Promise<unknown> {
  if (!EXTENSION_API_ALLOWLIST.has(name)) {
    throw new Error(
      `Extension API not allowlisted: ${name}. Only vetted, simple api.ext functions are ` +
        "reachable this way — a genuine join (like check_nexus_mod_updates) stays a dedicated tool.",
    );
  }
  const fn = getExtensionApi<(...fnArgs: unknown[]) => Promise<unknown>>(api, name);
  return fn(...args);
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
