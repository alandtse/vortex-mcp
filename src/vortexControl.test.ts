import { describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", () => ({
  actions: {
    setNextProfile: vi.fn((id: string) => ({ type: "SET_NEXT_PROFILE", payload: id })),
    setModsEnabled: vi.fn(async () => undefined),
  },
  selectors: {
    activeProfileId: vi.fn<() => string | undefined>(),
    activeProfile: vi.fn<() => unknown>(),
    profiles: vi.fn<() => Record<string, unknown>>(),
    activeGameId: vi.fn<() => string | undefined>(),
    knownGames: vi.fn<() => Array<{ id: string }>>(),
  },
  util: {
    renderModName: vi.fn((mod: { id: string }) => mod.id),
    toPromise: vi.fn(
      (fn: (cb: (err: Error | null, result?: unknown) => void) => void) =>
        new Promise((resolve, reject) => {
          fn((err, result) => (err ? reject(err) : resolve(result)));
        }),
    ),
  },
  log: vi.fn(),
}));

import { actions, selectors } from "@nexusmods/vortex-api";
import {
  activateGame,
  deployMods,
  getActiveProfile,
  installModFromUrl,
  listMods,
  listProfiles,
  purgeMods,
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

describe("vortexControl: profiles", () => {
  it("listProfiles maps state into summaries, marking the active one", () => {
    vi.mocked(selectors.activeProfileId).mockReturnValue("p2");
    vi.mocked(selectors.profiles).mockReturnValue({
      p1: { id: "p1", name: "First", gameId: "skyrimse", modState: {}, lastActivated: 0 },
      p2: { id: "p2", name: "Second", gameId: "skyrimse", modState: {}, lastActivated: 1 },
    });

    const result = listProfiles(fakeApi());

    expect(result).toEqual([
      { id: "p1", name: "First", gameId: "skyrimse", active: false },
      { id: "p2", name: "Second", gameId: "skyrimse", active: true },
    ]);
  });

  it("getActiveProfile returns undefined when there is no active profile", () => {
    vi.mocked(selectors.activeProfile).mockReturnValue(undefined);

    expect(getActiveProfile(fakeApi())).toBeUndefined();
  });

  it("getActiveProfile returns the active profile summary", () => {
    vi.mocked(selectors.activeProfile).mockReturnValue({
      id: "p1",
      name: "First",
      gameId: "skyrimse",
      modState: {},
      lastActivated: 0,
    });

    expect(getActiveProfile(fakeApi())).toEqual({
      id: "p1",
      name: "First",
      gameId: "skyrimse",
      active: true,
    });
  });

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
