import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", () => ({
  actions: {
    setNextProfile: vi.fn((id: string) => ({ type: "SET_NEXT_PROFILE", payload: id })),
    setModsEnabled: vi.fn(async () => undefined),
    setProfile: vi.fn((profile: unknown) => ({ type: "SET_PROFILE", payload: profile })),
    setLoadOrder: vi.fn((order: unknown) => ({ type: "SET_LOAD_ORDER", payload: order })),
    setGamePath: vi.fn((gamePath: unknown) => ({ type: "SET_GAME_PATH", payload: gamePath })),
    removeProfile: vi.fn((profileId: string) => ({ type: "REMOVE_PROFILE", payload: profileId })),
    closeDialog: vi.fn(
      (id: string, actionKey?: string) => (dispatch: (a: unknown) => void) =>
        dispatch({ type: "CLOSE_DIALOG_THUNK_RAN", id, actionKey }),
    ),
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
  findMissingMasters,
  findModByFile,
  installModFromUrl,
  launchGame,
  listCategories,
  listDialogs,
  listDownloads,
  listDuplicateMods,
  listFileConflicts,
  listKnownModConflicts,
  listLoadOrder,
  listModRules,
  listMods,
  listNotifications,
  listRuntimeErrors,
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
    events: { emit: overrides.emit ?? vi.fn(), on: vi.fn(), eventNames: vi.fn(() => []) },
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

  it("describeApi surfaces api's own direct methods (apiMethods) and registered event names", () => {
    const api = fakeApi();
    (api as unknown as { runExecutable: () => void; translate: () => void }).runExecutable = () =>
      undefined;
    (api as unknown as { runExecutable: () => void; translate: () => void }).translate = () =>
      undefined;
    (api as unknown as { events: { eventNames: () => string[] } }).events.eventNames = () => [
      "deploy-mods",
      "purge-mods",
    ];

    const result = describeApi(api);

    expect(result.apiMethods).toEqual(expect.arrayContaining(["runExecutable", "translate"]));
    expect(result.eventNames).toEqual(["deploy-mods", "purge-mods"]);
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

  it("launchGame resolves the primary tool via settings.interface/gameMode.discovered and runs it", async () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: {
        interface: { primaryTool: { skyrimse: "skse64" } },
        gameMode: {
          discovered: {
            skyrimse: {
              tools: {
                skse64: { path: "C:\\Games\\Skyrim\\skse64_loader.exe" },
              },
            },
          },
        },
      },
    });
    const runExecutable = vi.fn(async () => undefined);
    (api as unknown as { runExecutable: typeof runExecutable }).runExecutable = runExecutable;

    await launchGame(api);

    expect(runExecutable).toHaveBeenCalledWith("C:\\Games\\Skyrim\\skse64_loader.exe", [], {
      cwd: undefined,
      shell: false,
      detach: true,
      suggestDeploy: true,
    });
  });

  it("launchGame throws when the game has no primary tool configured", async () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { interface: { primaryTool: {} }, gameMode: { discovered: {} } },
    });

    await expect(launchGame(api, "skyrimse")).rejects.toThrow(/No primary tool configured/);
  });

  it("launchGame throws when the configured primary tool isn't in discovered tools", async () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: {
        interface: { primaryTool: { skyrimse: "skse64" } },
        gameMode: { discovered: { skyrimse: { tools: {} } } },
      },
    });

    await expect(launchGame(api, "skyrimse")).rejects.toThrow(/not in discovered tools/);
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

  it("allows removeProfile (the one admin-adjacent exception, for cleaning up clone_profile output)", () => {
    const dispatch = vi.fn();

    const result = dispatchAction(fakeApi({ dispatch }), "removeProfile", ["clone-id"]);

    expect(actions.removeProfile).toHaveBeenCalledWith("clone-id");
    expect(result).toEqual({ type: "REMOVE_PROFILE", payload: "clone-id" });
  });

  it("dispatches a thunk-returning action (closeDialog) directly, not as a {type} object", () => {
    const dispatch = vi.fn();

    const result = dispatchAction(fakeApi({ dispatch }), "closeDialog", ["d1", "Ignore"]);

    expect(actions.closeDialog).toHaveBeenCalledWith("d1", "Ignore");
    // The thunk itself was handed to dispatch (redux-thunk middleware's job to run it) —
    // simulate that here to confirm it's the real thunk, not something pre-invoked.
    expect(dispatch).toHaveBeenCalledWith(expect.any(Function));
    const thunk = dispatch.mock.calls[0][0] as (fn: (a: unknown) => void) => void;
    const innerDispatch = vi.fn();
    thunk(innerDispatch);
    expect(innerDispatch).toHaveBeenCalledWith({
      type: "CLOSE_DIALOG_THUNK_RAN",
      id: "d1",
      actionKey: "Ignore",
    });
    expect(result).toEqual({ dispatched: "closeDialog", thunk: true });
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

  it("treats a missing `received` as 0 progress instead of NaN (seen live on some entries)", () => {
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
              localPath: "mod1.zip",
            },
          },
        },
      },
    });

    expect(listDownloads(api)).toEqual([
      { id: "d1", name: "mod1.zip", state: "finished", progress: 0, size: 200 },
    ]);
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

describe("vortexControl: listDialogs", () => {
  it("flattens a dialog's content and surfaces the exact action labels to pick from", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      session: {
        notifications: {
          dialogs: [
            {
              id: "d1",
              type: "question",
              title: "Files changed",
              content: { message: "Some files changed outside Vortex." },
              actions: ["Ignore", "Keep changes"],
              defaultAction: "Ignore",
            },
          ],
        },
      },
    });

    expect(listDialogs(api)).toEqual([
      {
        id: "d1",
        type: "question",
        title: "Files changed",
        message: "Some files changed outside Vortex.",
        actions: ["Ignore", "Keep changes"],
        defaultAction: "Ignore",
        checkboxes: undefined,
        input: undefined,
      },
    ]);
  });

  it("returns an empty array when no dialog is open", () => {
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      session: { notifications: { dialogs: [] } },
    });

    expect(listDialogs(api)).toEqual([]);
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

describe("vortexControl: findModByFile / listFileConflicts", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeModFile(modFolder: string, relPath: string): Promise<void> {
    const full = path.join(tempRoot, modFolder, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "x");
  }

  function apiWithMods(
    mods: Record<string, unknown>,
    modState: Record<string, { enabled: boolean }>,
  ) {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({ gameId: "skyrimse", modState } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { mods: { installPath: { skyrimse: tempRoot } } },
      persistent: { mods: { skyrimse: mods } },
    });
    return api;
  }

  it("findModByFile matches by basename across enabled mods only, by default", async () => {
    await writeModFile("ModA", path.join("meshes", "foo.nif"));
    await writeModFile("ModB", "unrelated.txt");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: false } },
    );

    expect(await findModByFile(api, "foo.nif")).toEqual([
      {
        modId: "modA",
        modName: "modA",
        relativePath: path.join("meshes", "foo.nif"),
        enabled: true,
      },
    ]);
  });

  it("findModByFile with includeDisabled also searches disabled mods", async () => {
    await writeModFile("ModC", "foo.nif");
    const api = apiWithMods(
      { modC: { id: "modC", installationPath: "ModC" } },
      { modC: { enabled: false } },
    );

    expect(await findModByFile(api, "foo.nif")).toEqual([]);
    expect(await findModByFile(api, "foo.nif", { includeDisabled: true })).toEqual([
      { modId: "modC", modName: "modC", relativePath: "foo.nif", enabled: false },
    ]);
  });

  it("listFileConflicts reports files provided by more than one enabled mod, not unique ones", async () => {
    await writeModFile("ModA", path.join("scripts", "shared.pex"));
    await writeModFile("ModB", path.join("scripts", "shared.pex"));
    await writeModFile("ModB", "onlyInB.txt");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    const conflicts = await listFileConflicts(api);

    expect(conflicts).toEqual([
      {
        file: path.join("scripts", "shared.pex").toLowerCase(),
        mods: expect.arrayContaining([
          { id: "modA", name: "modA" },
          { id: "modB", name: "modB" },
        ]),
        risk: "high",
      },
    ]);
  });

  it("listFileConflicts classifies risk by file type without picking a winner", async () => {
    await writeModFile("ModA", "plugin.esp");
    await writeModFile("ModB", "plugin.esp");
    await writeModFile("ModA", "settings.ini");
    await writeModFile("ModB", "settings.ini");
    await writeModFile("ModA", "texture.dds");
    await writeModFile("ModB", "texture.dds");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    const conflicts = await listFileConflicts(api);
    const riskByFile = Object.fromEntries(conflicts.map((c) => [c.file, c.risk]));

    expect(riskByFile).toEqual({
      "plugin.esp": "high",
      "settings.ini": "medium",
      "texture.dds": "low",
    });
  });

  it("listFileConflicts ignores a disabled mod's files entirely", async () => {
    await writeModFile("ModA", "shared.esp");
    await writeModFile("ModB", "shared.esp");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: false } },
    );

    expect(await listFileConflicts(api)).toEqual([]);
  });
});

function buildTES4Buffer(masters: string[]): Buffer {
  const subrecords = masters.map((master) => {
    const nameBuf = Buffer.from(`${master}\0`, "ascii");
    const sizeBuf = Buffer.alloc(2);
    sizeBuf.writeUInt16LE(nameBuf.length, 0);
    return Buffer.concat([Buffer.from("MAST", "ascii"), sizeBuf, nameBuf]);
  });
  const data = Buffer.concat(subrecords);
  const header = Buffer.alloc(24);
  header.write("TES4", 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

describe("vortexControl: findMissingMasters", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-plugins-"));
    await mkdir(path.join(tempRoot, "Data"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writePlugin(name: string, masters: string[]): Promise<void> {
    await writeFile(path.join(tempRoot, "Data", name), buildTES4Buffer(masters));
  }

  function apiWithLoadOrder(loadOrder: Record<string, { loadOrder: number; enabled: boolean }>) {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { gameMode: { discovered: { skyrimse: { path: tempRoot } } } },
      loadOrder,
    });
    return api;
  }

  it("finds a plugin whose master isn't enabled, by reading its real TES4 header", async () => {
    await writePlugin("Skyrim.esm", []);
    await writePlugin("Patch.esp", ["Skyrim.esm", "MissingMod.esm"]);
    const api = apiWithLoadOrder({
      "Skyrim.esm": { loadOrder: 0, enabled: true },
      "Patch.esp": { loadOrder: 1, enabled: true },
    });

    expect(await findMissingMasters(api)).toEqual([
      { plugin: "Patch.esp", missingMasters: ["MissingMod.esm"] },
    ]);
  });

  it("returns nothing when every master is enabled", async () => {
    await writePlugin("Skyrim.esm", []);
    await writePlugin("Patch.esp", ["Skyrim.esm"]);
    const api = apiWithLoadOrder({
      "Skyrim.esm": { loadOrder: 0, enabled: true },
      "Patch.esp": { loadOrder: 1, enabled: true },
    });

    expect(await findMissingMasters(api)).toEqual([]);
  });

  it("throws when the game isn't discovered", async () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { gameMode: { discovered: {} } },
      loadOrder: {},
    });

    await expect(findMissingMasters(api)).rejects.toThrow(/not discovered/);
  });
});

describe("vortexControl: listRuntimeErrors", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-docs-"));
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(util.getVortexPath).mockReturnValue(tempRoot);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("reads Papyrus error lines and extracts mentioned mod files", async () => {
    const papyrusDir = path.join(tempRoot, "My Games", "Skyrim Special Edition", "Logs", "Script");
    await mkdir(papyrusDir, { recursive: true });
    await writeFile(
      path.join(papyrusDir, "Papyrus.0.log"),
      [
        "[08/31/2026 - 20:50:04PM] Papyrus log opened",
        "[08/31/2026 - 20:50:10PM] error: Cannot call GetActorValue() on a None object, aka SomeMod.esp",
        "[08/31/2026 - 20:50:15PM] all good here",
      ].join("\r\n"),
    );

    const entries = await listRuntimeErrors(fakeApi());

    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("papyrus");
    expect(entries[0]?.excerpt).toContain("Cannot call GetActorValue");
    expect(entries[0]?.mentionedFiles).toEqual(["SomeMod.esp"]);
  });

  it("returns the newest crash logs first, capped by maxCrashLogs", async () => {
    const skseDir = path.join(tempRoot, "My Games", "Skyrim Special Edition", "SKSE");
    await mkdir(skseDir, { recursive: true });
    await writeFile(path.join(skseDir, "crash-2026-01-01-00-00-00.log"), "old crash\nline2");
    await writeFile(path.join(skseDir, "crash-2026-06-01-00-00-00.log"), "newer crash\nline2");
    // Make the mtimes unambiguous regardless of write speed.
    const old = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-06-01T00:00:00Z");
    await Promise.all([
      utimes(path.join(skseDir, "crash-2026-01-01-00-00-00.log"), old, old),
      utimes(path.join(skseDir, "crash-2026-06-01-00-00-00.log"), newer, newer),
    ]);

    const entries = await listRuntimeErrors(fakeApi(), { maxCrashLogs: 1 });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("crash");
    expect(entries[0]?.excerpt).toContain("newer crash");
  });

  it("returns an empty array when no logs exist yet, without throwing", async () => {
    expect(await listRuntimeErrors(fakeApi())).toEqual([]);
  });

  it("throws a clear error for a game with no verified save-data folder", async () => {
    await expect(listRuntimeErrors(fakeApi(), { gameId: "someUnknownGame" })).rejects.toThrow(
      /Don't know the save-data folder/,
    );
  });
});

describe("vortexControl: listDuplicateMods", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "vortex-mcp-test-dup-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeModFile(modFolder: string, relPath: string): Promise<void> {
    const full = path.join(tempRoot, modFolder, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "x");
  }

  function apiWithMods(
    mods: Record<string, unknown>,
    modState: Record<string, { enabled: boolean }>,
  ) {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({ gameId: "skyrimse", modState } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      settings: { mods: { installPath: { skyrimse: tempRoot } } },
      persistent: { mods: { skyrimse: mods } },
    });
    return api;
  }

  it("flags more than one installed mod sharing the same Nexus mod id", async () => {
    await writeModFile("ModA", "a.esp");
    await writeModFile("ModB", "b.esp");
    const api = apiWithMods(
      {
        modA: {
          id: "modA",
          installationPath: "ModA",
          attributes: { source: "nexus", modId: 12345 },
        },
        modB: {
          id: "modB",
          installationPath: "ModB",
          attributes: { source: "nexus", modId: 12345 },
        },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    const groups = await listDuplicateMods(api);

    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "same-nexus-id",
          mods: expect.arrayContaining([
            { id: "modA", name: "modA" },
            { id: "modB", name: "modB" },
          ]),
        }),
      ]),
    );
  });

  it("does not flag mods with different Nexus ids or non-Nexus sources", async () => {
    await writeModFile("ModA", "a.esp");
    await writeModFile("ModB", "b.esp");
    const api = apiWithMods(
      {
        modA: {
          id: "modA",
          installationPath: "ModA",
          attributes: { source: "nexus", modId: 111 },
        },
        modB: { id: "modB", installationPath: "ModB", attributes: { source: "manual" } },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    expect(await listDuplicateMods(api)).toEqual([]);
  });

  it("flags a mod whose entire file set is a subset of a larger mod's", async () => {
    await writeModFile("BigMod", "meshes/a.nif");
    await writeModFile("BigMod", "textures/a.dds");
    await writeModFile("BigMod", "plugin.esp");
    await writeModFile("OldVersion", "meshes/a.nif");
    const api = apiWithMods(
      {
        bigMod: { id: "bigMod", installationPath: "BigMod" },
        oldVersion: { id: "oldVersion", installationPath: "OldVersion" },
      },
      { bigMod: { enabled: true }, oldVersion: { enabled: true } },
    );

    const groups = await listDuplicateMods(api);

    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "file-subset",
          mods: [
            { id: "bigMod", name: "bigMod" },
            { id: "oldVersion", name: "oldVersion" },
          ],
        }),
      ]),
    );
  });

  it("does not flag mods with disjoint file sets", async () => {
    await writeModFile("ModA", "unique-a.esp");
    await writeModFile("ModB", "unique-b.esp");
    const api = apiWithMods(
      {
        modA: { id: "modA", installationPath: "ModA" },
        modB: { id: "modB", installationPath: "ModB" },
      },
      { modA: { enabled: true }, modB: { enabled: true } },
    );

    expect(await listDuplicateMods(api)).toEqual([]);
  });
});

describe("vortexControl: listKnownModConflicts", () => {
  it("surfaces a real 'conflicts' rule between two enabled mods", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: { modA: { enabled: true }, modB: { enabled: true } },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [{ type: "conflicts", reference: { id: "modB" } }],
            },
            modB: { id: "modB", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listKnownModConflicts(api)).toEqual([
      { modId: "modA", modName: "modA", targetId: "modB", targetName: "modB", targetEnabled: true },
    ]);
  });

  it("reports targetEnabled: false when the conflicting mod is installed but disabled", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: { modA: { enabled: true }, modB: { enabled: false } },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [{ type: "conflicts", reference: { id: "modB" } }],
            },
            modB: { id: "modB", type: "", installationPath: "" },
          },
        },
      },
    });

    expect(listKnownModConflicts(api)).toEqual([
      {
        modId: "modA",
        modName: "modA",
        targetId: "modB",
        targetName: "modB",
        targetEnabled: false,
      },
    ]);
  });

  it("ignores non-conflicts rule types and disabled source mods", () => {
    vi.mocked(selectors.activeGameId).mockReturnValue("skyrimse");
    vi.mocked(selectors.activeProfile).mockReturnValue({
      gameId: "skyrimse",
      modState: { modA: { enabled: false }, modB: { enabled: true } },
    } as never);
    const api = fakeApi();
    (api as unknown as { store: { getState: () => unknown } }).store.getState = () => ({
      persistent: {
        mods: {
          skyrimse: {
            modA: {
              id: "modA",
              type: "",
              installationPath: "",
              rules: [{ type: "conflicts", reference: { id: "modB" } }],
            },
            modB: {
              id: "modB",
              type: "",
              installationPath: "",
              rules: [{ type: "before", reference: { id: "modA" } }],
            },
          },
        },
      },
    });

    expect(listKnownModConflicts(api)).toEqual([]);
  });
});
