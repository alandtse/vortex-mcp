import path from "node:path";
import crypto from "node:crypto";

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
}

export function describeApi(api: IExtensionApi): ApiDescription {
  const st = state(api);
  return {
    selectors: Object.keys(selectors).toSorted(),
    actions: Object.keys(actions).toSorted(),
    dispatchableActions: [...DISPATCHABLE_ACTIONS].toSorted(),
    stateKeys: Object.keys(st as object).toSorted(),
    extensionApis: Object.keys(api.ext ?? {}).toSorted(),
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
// deployment settings, and download bookkeeping. Deliberately excludes anything
// admin-level — game/install/download *paths*, extensions (install/enable/remove),
// credentials/auth, profile deletion, window/network state — even though those are
// otherwise plain action creators the same reflection mechanism could reach. This
// allowlist is the actual enforcement boundary, not just a documentation note.
const DISPATCHABLE_ACTIONS = new Set([
  "addMod",
  "addMods",
  "addModRule",
  "clearModRules",
  "removeMod",
  "removeModRule",
  "setModAttribute",
  "setModAttributes",
  "setModArchiveId",
  "setModEnabled",
  "setModInstallationPath",
  "setModState",
  "setModType",
  "setCategory",
  "setCategoryOrder",
  "removeCategory",
  "renameCategory",
  "loadCategories",
  "updateCategories",
  "setFileOverride",
  "setINITweakEnabled",
  "setLoadOrder",
  "setLoadOrderEntry",
  "setFBLoadOrder",
  "setFBLoadOrderEntry",
  "setPendingPluginSort",
  "clearPendingPluginSort",
  "setActivator",
  "setAutoDeployment",
  "setCleanupOnDeploy",
  "setConfirmPurge",
  "setDeploymentNecessary",
  "setDownloadModInfo",
  "setDownloadHash",
  "mergeDownloadModInfo",
  "pauseDownload",
  "removeDownload",
  "removeDownloadSilent",
  "setDownloadInstalled",
  "setDownloadInterrupted",
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
        "actions only, not admin-level ones (paths, extensions, credentials, profile deletion).",
    );
  }
  const fn = (actions as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`Unknown action: ${name}.`);
  }
  const result = (fn as (...fnArgs: unknown[]) => unknown)(...args);
  if (
    result === null ||
    typeof result !== "object" ||
    typeof (result as { type?: unknown }).type !== "string"
  ) {
    throw new Error(`${name} did not return a dispatchable action object.`);
  }
  store(api).dispatch(result);
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

export function deployMods(api: IExtensionApi): Promise<void> {
  return util.toPromise<void>((cb) => api.events.emit("deploy-mods", cb));
}

export function purgeMods(api: IExtensionApi, allowFallback = false): Promise<void> {
  return util.toPromise<void>((cb) => api.events.emit("purge-mods", allowFallback, cb));
}

export function installModFromUrl(api: IExtensionApi, url: string): Promise<string> {
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
