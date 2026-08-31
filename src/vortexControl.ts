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
  /** Names of Vortex's dispatchable action creators (informational; not directly callable — see query). */
  actions: string[];
  /** Top-level keys of the Redux state tree, walkable via query({ path }). */
  stateKeys: string[];
}

export function describeApi(api: IExtensionApi): ApiDescription {
  const st = state(api);
  return {
    selectors: Object.keys(selectors).toSorted(),
    actions: Object.keys(actions).toSorted(),
    stateKeys: Object.keys(st as object).toSorted(),
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

export function listMods(api: IExtensionApi, gameId?: string): ModSummary[] {
  const st = state(api);
  const targetGameId = gameId ?? selectors.activeGameId(st);
  if (!targetGameId) {
    throw new Error("No active game and no gameId provided");
  }
  const profile = selectors.activeProfile(st);
  const mods: { [id: string]: IMod } = st.persistent.mods[targetGameId] ?? {};
  return Object.values(mods).map((mod) => ({
    id: mod.id,
    name: util.renderModName(mod),
    type: mod.type,
    version: mod.attributes?.version as string | undefined,
    enabled:
      profile?.gameId === targetGameId ? (profile?.modState?.[mod.id]?.enabled ?? false) : false,
  }));
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
