import { actions, selectors, util, log, types } from "@nexusmods/vortex-api";

type IExtensionApi = types.IExtensionApi;
type IProfile = types.IProfile;
type IMod = types.IMod;

export interface ModSummary {
  id: string;
  name: string;
  type: string;
  version?: string;
  enabled: boolean;
}

export interface ProfileSummary {
  id: string;
  name: string;
  gameId: string;
  active: boolean;
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

export function listProfiles(api: IExtensionApi): ProfileSummary[] {
  const st = state(api);
  const activeId = selectors.activeProfileId(st);
  return Object.values(selectors.profiles(st)).map((profile: IProfile) => ({
    id: profile.id,
    name: profile.name,
    gameId: profile.gameId,
    active: profile.id === activeId,
  }));
}

export function getActiveProfile(api: IExtensionApi): ProfileSummary | undefined {
  const st = state(api);
  const profile = selectors.activeProfile(st);
  if (!profile) {
    return undefined;
  }
  return { id: profile.id, name: profile.name, gameId: profile.gameId, active: true };
}

export function switchProfile(api: IExtensionApi, profileId: string): void {
  const st = state(api);
  if (selectors.profiles(st)[profileId] === undefined) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  store(api).dispatch(actions.setNextProfile(profileId));
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
