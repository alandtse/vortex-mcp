import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", () => ({
  actions: {
    setNextProfile: vi.fn((id: string) => ({ type: "SET_NEXT_PROFILE", payload: id })),
    setModsEnabled: vi.fn(async () => undefined),
    setProfile: vi.fn((profile: unknown) => ({ type: "SET_PROFILE", payload: profile })),
    setLoadOrder: vi.fn((order: unknown) => ({ type: "SET_LOAD_ORDER", payload: order })),
    setGamePath: vi.fn((gamePath: unknown) => ({ type: "SET_GAME_PATH", payload: gamePath })),
  },
  selectors: {
    activeProfileId: vi.fn<() => string | undefined>(),
    activeProfile: vi.fn<() => unknown>(),
    profiles: vi.fn<() => Record<string, unknown>>(),
    activeGameId: vi.fn<() => string | undefined>(),
    knownGames: vi.fn<() => Array<{ id: string }>>(),
    notifications: vi.fn<() => unknown[]>(),
  },
  util: {
    renderModName: vi.fn((mod: { id: string }) => mod.id),
    getVortexPath: vi.fn(() => "C:\\fake\\userData"),
    writeFileAtomic: vi.fn(async () => undefined),
    toPromise: vi.fn(
      (fn: (cb: (err: Error | null, result?: unknown) => void) => void) =>
        new Promise((resolve, reject) => {
          fn((err, result) => (err ? reject(err) : resolve(result)));
        }),
    ),
  },
  fs: {
    ensureDirAsync: vi.fn(async () => undefined),
    ensureDirWritableAsync: vi.fn(async () => undefined),
    copyAsync: vi.fn(async () => undefined),
  },
  log: vi.fn(),
}));

import { actions, fs, selectors, util } from "@nexusmods/vortex-api";
import {
  activateGame,
  backupState,
  cloneProfile,
  deployMods,
  describeApi,
  dispatchAction,
  installModFromUrl,
  listCategories,
  listDownloads,
  listLoadOrder,
  listModRules,
  listMods,
  listNotifications,
  purgeMods,
  queryStatePath,
  querySelector,
  restartVortex,
  setModsEnabled,
  switchProfile,
} from "./vortexControl";

function fakeApi(
  overrides: Partial<{
    dispatch: (a: unknown) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches EventEmitter.emit's own (...args: any[]) signature
    emit: (...args: any[]) => void;
  }> = {},
) {
  return {
    store: {
      getState: () => ({}),
      dispatch: overrides.dispatch ?? vi.fn(),
    },
    events: { emit: overrides.emit ?? vi.fn(), on: vi.fn() },
  } as never;
}

describe("vortexControl: reflection", () => {
  it("describeApi lists the live selector/action/state-key names", () => {
    vi.mocked(selectors.activeProfileId).mockReturnValue("p1");

    const result = describeApi(fakeApi());

    expect(result.selectors).toContain("activeProfileId");
    expect(result.selectors).toContain("profiles");
    expect(result.actions).toContain("setNextProfile");
    expect(result.stateKeys).toEqual([]);
    expect(result.dispatchableActions).toContain("setLoadOrder");
    expect(result.dispatchableActions).not.toContain("setNextProfile");
    expect(result.dispatchHints.setModEnabled).toBe(
      "profileId: string, modId: string, enable: boolean",
    );
    expect(result.dispatchHints).not.toHaveProperty("setNextProfile");
    expect(result.extensionApis).toEqual([]);
  });

  it("describeApi surfaces api.ext names as extensionApis without exposing the functions", () => {
    const api = fakeApi();
    (api as unknown as { ext: Record<string, unknown> }).ext = {
      someExtensionHelper: () => undefined,
    };

    expect(describeApi(api).extensionApis).toEqual(["someExtensionHelper"]);
  });

  it("querySelector calls the named selector with state and extra args", () => {
    vi.mocked(selectors.profiles).mockReturnValue({ p1: { id: "p1" } as never });

    expect(querySelector(fakeApi(), "profiles")).toEqual({ p1: { id: "p1" } });
  });

  it("querySelector throws for an unknown selector name", () => {
    expect(() => querySelector(fakeApi(), "notARealSelector")).toThrow(/Unknown selector/);
  });

  it("queryStatePath walks the state tree by key", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: { modA: { id: "modA" } } } },
    });

    expect(queryStatePath(api, ["persistent", "mods", "skyrimse", "modA"])).toEqual({
      id: "modA",
    });
  });

  it("queryStatePath returns undefined for a path that doesn't resolve", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({});

    expect(queryStatePath(api, ["nope", "deeper"])).toBeUndefined();
  });
});

describe("vortexControl: profiles", () => {
  it("switchProfile rejects unknown profile ids without dispatching", () => {
    vi.mocked(selectors.profiles).mockReturnValue({});
    const dispatch = vi.fn();

    expect(() => switchProfile(fakeApi({ dispatch }), "missing")).toThrow(/Unknown profile/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("switchProfile dispatches setNextProfile for a known profile", () => {
    vi.mocked(selectors.profiles).mockReturnValue({
      p1: { id: "p1", name: "First", gameId: "skyrimse", modState: {}, lastActivated: 0 },
    });
    const dispatch = vi.fn();

    switchProfile(fakeApi({ dispatch }), "p1");

    expect(actions.setNextProfile).toHaveBeenCalledWith("p1");
    expect(dispatch).toHaveBeenCalled();
  });

  it("cloneProfile rejects an unknown source profile without touching disk", async () => {
    vi.mocked(selectors.profiles).mockReturnValue({});

    await expect(cloneProfile(fakeApi(), "missing")).rejects.toThrow(/Unknown profile/);
    expect(fs.copyAsync).not.toHaveBeenCalled();
  });

  it("cloneProfile copies the source profile dir and dispatches setProfile with a new id", async () => {
    const source = {
      id: "p1",
      name: "AE 1.7",
      gameId: "skyrimse",
      modState: { modA: { enabled: true, enabledTime: 0 } },
      lastActivated: 0,
    };
    vi.mocked(selectors.profiles).mockReturnValue({ p1: source });
    const dispatch = vi.fn();

    const result = await cloneProfile(fakeApi({ dispatch }), "p1");

    expect(result.id).not.toBe("p1");
    expect(result.name).toBe("AE 1.7 (clone)");
    expect(result.gameId).toBe("skyrimse");
    expect(result.active).toBe(false);
    expect(fs.copyAsync).toHaveBeenCalledWith(
      expect.stringContaining(path.join("skyrimse", "profiles", "p1")),
      expect.stringContaining(path.join("skyrimse", "profiles", result.id)),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SET_PROFILE",
        payload: expect.objectContaining({
          id: result.id,
          name: "AE 1.7 (clone)",
          modState: source.modState,
        }),
      }),
    );
  });

  it("cloneProfile accepts an explicit name", async () => {
    vi.mocked(selectors.profiles).mockReturnValue({
      p1: { id: "p1", name: "AE 1.7", gameId: "skyrimse", modState: {}, lastActivated: 0 },
    });

    const result = await cloneProfile(fakeApi(), "p1", "MCP test");

    expect(result.name).toBe("MCP test");
  });
});

describe("vortexControl: mods", () => {
  it("listMods reads the active game's mods and marks enabled state from the active profile", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      id: "p1",
      name: "First",
      gameId: "skyrimse",
      modState: { modA: { enabled: true, enabledTime: 0 } },
      lastActivated: 0,
    });

    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              state: "installed",
              type: "",
              installationPath: "",
              attributes: { version: "1.0" },
            },
            modB: { id: "modB", state: "installed", type: "", installationPath: "" },
          },
        },
      },
    });

    const result = listMods(api);

    expect(result).toEqual([
      { id: "modA", name: "modA", type: "", version: "1.0", enabled: true },
      { id: "modB", name: "modB", type: "", version: undefined, enabled: false },
    ]);
  });

  it("listMods throws when there is no active game and none was provided", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("");

    expect(() => listMods(fakeApi())).toThrow(/No active game/);
  });

  it("listMods filters by enabledOnly, nameFilter, and limit", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      id: "p1",
      name: "First",
      gameId: "skyrimse",
      modState: {
        modA: { enabled: true, enabledTime: 0 },
        modC: { enabled: true, enabledTime: 0 },
      },
      lastActivated: 0,
    });

    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: { id: "modA", state: "installed", type: "", installationPath: "" },
            modB: { id: "modB", state: "installed", type: "", installationPath: "" },
            modC: { id: "modC", state: "installed", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listMods(api, undefined, { enabledOnly: true })).toEqual([
      { id: "modA", name: "modA", type: "", version: undefined, enabled: true },
      { id: "modC", name: "modC", type: "", version: undefined, enabled: true },
    ]);
    expect(listMods(api, undefined, { nameFilter: "MODB" })).toEqual([
      { id: "modB", name: "modB", type: "", version: undefined, enabled: false },
    ]);
    expect(listMods(api, undefined, { limit: 1 })).toHaveLength(1);
  });

  it("setModsEnabled uses an explicit profileId over the active one", async () => {
    await setModsEnabled(fakeApi(), ["modA"], false, "p-explicit");

    expect(actions.setModsEnabled).toHaveBeenCalledWith(
      expect.anything(),
      "p-explicit",
      ["modA"],
      false,
    );
  });

  it("setModsEnabled throws when there is no active profile and none was provided", async () => {
    vi.mocked(selectors.activeProfileId).mockReturnValue(undefined);

    await expect(setModsEnabled(fakeApi(), ["modA"], true)).rejects.toThrow(/No active profile/);
  });
});

describe("vortexControl: listLoadOrder", () => {
  it("sorts plugins by index and defaults enabled to true when absent", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      loadOrder: {
        "update.esm": { loadOrder: 1 },
        "skyrim.esm": { loadOrder: 0 },
        "mymod.esp": { loadOrder: 2, enabled: false },
      },
    });

    expect(listLoadOrder(api)).toEqual([
      { plugin: "skyrim.esm", index: 0, enabled: true },
      { plugin: "update.esm", index: 1, enabled: true },
      { plugin: "mymod.esp", index: 2, enabled: false },
    ]);
  });

  it("throws when there is no load order data", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({});

    expect(() => listLoadOrder(api)).toThrow(/No plugin load order/);
  });
});

describe("vortexControl: listCategories", () => {
  it("sorts by order and joins mod counts per category", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        categories: {
          skyrimse: {
            "20": { name: "Skyrim Special Edition", order: 1 },
            "22": { name: "Buildings", order: 2, parentCategory: "20" },
          },
        },
        mods: {
          skyrimse: {
            modA: { id: "modA", type: "", installationPath: "", attributes: { category: "22" } },
            modB: { id: "modB", type: "", installationPath: "", attributes: { category: "22" } },
            modC: { id: "modC", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listCategories(api)).toEqual([
      {
        id: "20",
        name: "Skyrim Special Edition",
        order: 1,
        parentCategory: undefined,
        modCount: 0,
      },
      { id: "22", name: "Buildings", order: 2, parentCategory: "20", modCount: 2 },
    ]);
  });

  it("throws when there is no active game and none was provided", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("");

    expect(() => listCategories(fakeApi())).toThrow(/No active game/);
  });

  it("returns an empty list when the game has no categories", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { categories: {}, mods: {} },
    });

    expect(listCategories(api)).toEqual([]);
  });
});

describe("vortexControl: deploy/purge/install", () => {
  it("deployMods resolves when the deploy-mods callback reports no error", async () => {
    const emit = vi.fn((event: string, cb: (err: Error | null) => void) => {
      expect(event).toBe("deploy-mods");
      cb(null);
    });

    await expect(deployMods(fakeApi({ emit }))).resolves.toBeUndefined();
  });

  it("deployMods rejects when the deploy-mods callback reports an error", async () => {
    const emit = vi.fn((_event: string, cb: (err: Error | null) => void) => cb(new Error("boom")));

    await expect(deployMods(fakeApi({ emit }))).rejects.toThrow("boom");
  });

  it("purgeMods passes allowFallback through to the purge-mods event", async () => {
    const emit = vi.fn((event: string, allowFallback: boolean, cb: (err: Error | null) => void) => {
      expect(event).toBe("purge-mods");
      expect(allowFallback).toBe(true);
      cb(null);
    });

    await expect(purgeMods(fakeApi({ emit }), true)).resolves.toBeUndefined();
  });

  it("installModFromUrl resolves with the download id from start-download", async () => {
    const emit = vi.fn(
      (
        event: string,
        urls: string[],
        _modInfo: unknown,
        _fileName: unknown,
        cb: (err: Error | null, id?: string) => void,
      ) => {
        expect(event).toBe("start-download");
        expect(urls).toEqual(["https://example.com/mod.zip"]);
        cb(null, "download-42");
      },
    );

    await expect(installModFromUrl(fakeApi({ emit }), "https://example.com/mod.zip")).resolves.toBe(
      "download-42",
    );
  });
});

describe("vortexControl: games", () => {
  it("activateGame throws for an unknown game id without emitting", () => {
    vi.mocked(selectors.knownGames).mockReturnValue([{ id: "skyrimse" } as never]);
    const emit = vi.fn();

    expect(() => activateGame(fakeApi({ emit }), "unknown-game")).toThrow(/Unknown game/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("activateGame emits activate-game for a known game id", () => {
    vi.mocked(selectors.knownGames).mockReturnValue([{ id: "skyrimse" } as never]);
    const emit = vi.fn();

    activateGame(fakeApi({ emit }), "skyrimse");

    expect(emit).toHaveBeenCalledWith("activate-game", "skyrimse");
  });
});

describe("vortexControl: restart", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("restartVortex calls window.api.app.relaunch", () => {
    const relaunch = vi.fn();
    (globalThis as { window?: unknown }).window = { api: { app: { relaunch } } };

    restartVortex();

    expect(relaunch).toHaveBeenCalled();
  });

  it("restartVortex throws when the preload bridge is unavailable", () => {
    (globalThis as { window?: unknown }).window = {};

    expect(() => restartVortex()).toThrow(/window.api.app.relaunch/);
  });
});

describe("vortexControl: dispatchAction", () => {
  it("dispatches an allowlisted action and returns it", () => {
    const dispatch = vi.fn();

    const result = dispatchAction(fakeApi({ dispatch }), "setLoadOrder", [["modA", "modB"]]);

    expect(actions.setLoadOrder).toHaveBeenCalledWith(["modA", "modB"]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_LOAD_ORDER",
      payload: ["modA", "modB"],
    });
    expect(result).toEqual({ type: "SET_LOAD_ORDER", payload: ["modA", "modB"] });
  });

  it("rejects an admin-level action even though it's a plain action creator", () => {
    const dispatch = vi.fn();

    expect(() => dispatchAction(fakeApi({ dispatch }), "setGamePath", ["C:\\Games"])).toThrow(
      /not allowlisted/,
    );
    expect(actions.setGamePath).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects an unknown action name", () => {
    expect(() => dispatchAction(fakeApi(), "totallyMadeUp")).toThrow(/not allowlisted/);
  });
});

describe("vortexControl: backupState", () => {
  it("writes a snapshot of settings/persistent/app/user state to Vortex's backup folder", async () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { s: 1 },
      persistent: { p: 1 },
      app: { a: 1 },
      user: { u: 1 },
      session: { secret: "never backed up" },
    });

    const backupPath = await backupState(api, "test");

    expect(backupPath).toContain(path.join("temp", "state_backups_full"));
    expect(backupPath).toContain("test-");
    expect(fs.ensureDirWritableAsync).toHaveBeenCalled();
    const written = vi.mocked(util.writeFileAtomic).mock.calls[0];
    expect(written[0]).toBe(backupPath);
    const parsed = JSON.parse(written[1] as string);
    expect(parsed).toEqual({
      settings: { s: 1 },
      persistent: { p: 1 },
      app: { a: 1 },
      user: { u: 1 },
    });
  });
});

describe("vortexControl: listDownloads", () => {
  it("filters downloads by game and computes progress percent", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        downloads: {
          files: {
            d1: {
              id: "d1",
              game: ["skyrimse"],
              state: "finished",
              size: 200,
              received: 200,
              modInfo: { name: "Cool Mod" },
            },
            d2: {
              id: "d2",
              game: ["fallout4"],
              state: "finished",
              size: 100,
              received: 100,
            },
            d3: {
              id: "d3",
              game: ["skyrimse"],
              state: "downloading",
              size: 400,
              received: 100,
              localPath: "mod3.zip",
            },
          },
        },
      },
    });

    expect(listDownloads(api)).toEqual([
      { id: "d1", name: "Cool Mod", state: "finished", progress: 100, size: 200 },
      { id: "d3", name: "mod3.zip", state: "downloading", progress: 25, size: 400 },
    ]);
  });

  it("throws when there is no active game and none was provided", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("");

    expect(() => listDownloads(fakeApi())).toThrow(/No active game/);
  });
});

describe("vortexControl: listNotifications", () => {
  it("maps notifications to their summary fields", () => {
    vi.mocked(selectors.notifications).mockReturnValue([
      { id: "n1", type: "error", title: "Deployment failed", message: "Permission denied" },
      { type: "info", message: "No title here" },
    ]);

    expect(listNotifications(fakeApi())).toEqual([
      { id: "n1", type: "error", title: "Deployment failed", message: "Permission denied" },
      { id: undefined, type: "info", title: undefined, message: "No title here" },
    ]);
  });
});

describe("vortexControl: listModRules", () => {
  it("resolves rule references to friendly names when the target mod is installed", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [
                { type: "after", reference: { id: "modB", versionMatch: "*" } },
                { type: "before", reference: { idHint: "unknown-mod" } },
              ],
            },
            modB: { id: "modB", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listModRules(api, "modA")).toEqual([
      { type: "after", targetId: "modB", targetName: "modB", versionMatch: "*" },
      { type: "before", targetId: "unknown-mod", targetName: undefined, versionMatch: undefined },
    ]);
  });

  it("throws for an unknown mod id", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: { mods: { skyrimse: {} } },
    });

    expect(() => listModRules(api, "missing")).toThrow(/Unknown mod/);
  });
});
