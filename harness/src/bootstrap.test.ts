import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrap, captureLogin, liveDir, loginDir, readMarker, snapshotDir } from "./bootstrap";
import type { HarnessConfig } from "./config";
import { requireOAuth } from "./auth";
import { authCacheFile, launchVortex, stopStaleInstance } from "./instance";
import { ensureGameManaged, waitForGameStartup } from "./gameSetup";

vi.mock("./liveOperation", () => ({
  withLiveOperation: (
    _config: unknown,
    _name: string,
    run: (context: unknown) => Promise<unknown>,
  ) => run(undefined),
}));
vi.mock("./gameSetup", () => ({
  ensureGameManaged: vi.fn(
    async (_mcp: unknown, gameId: string, { gamePath }: { gamePath: string }) => ({
      gameId,
      gamePath,
      activated: true,
      alreadyKnown: false,
    }),
  ),
  waitForGameStartup: vi.fn(async () => true),
}));

vi.mock("./auth", () => ({
  requireOAuth: vi.fn(async () => ({ oauthPresent: true, oauthRefreshable: true })),
}));

// captureLogin stops the running instance before copying, because Vortex only
// flushes state on a clean close. Nothing is running in a unit test, so the
// stop is stubbed out; what is under test is what ends up in the snapshot.
vi.mock("./instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./instance")>()),
  stopStaleInstance: vi.fn(async () => false),
  ensureExtensionBuilt: vi.fn(async () => "unit fixture"),
  installMcpExtension: vi.fn(),
  launchVortex: vi.fn(async ({ config }: { config: HarnessConfig }) => ({
    mcp: {
      call: vi.fn(async (_tool: string, args: { path?: string[] }) =>
        args?.path?.includes("discovered") ? { path: config.gamePath } : { oauthPresent: true },
      ),
    },
    stop: vi.fn(async () => undefined),
  })),
}));

const roots: string[] = [];

function fakeConfig(): HarnessConfig {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-ai-bootstrap-"));
  roots.push(cacheDir);
  const config = {
    cacheDir,
    gameId: "fallout4",
    gamePath: "C:/Games/Fallout 4",
    apiKey: "test-key",
    target: { kind: "installed", appName: "Vortex", executable: "C:/Vortex/Vortex.exe", args: [] },
  } as unknown as HarnessConfig;
  fs.mkdirSync(liveDir(config), { recursive: true });
  fs.writeFileSync(
    path.join(liveDir(config), ".vortex-ai-snapshot.json"),
    JSON.stringify({ snapshotKey: path.basename(snapshotDir(config, "test-key")) }),
  );
  return config;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("cold game management", () => {
  beforeEach(() => {
    vi.mocked(waitForGameStartup).mockResolvedValue(true);
  });

  it("flushes the registered private path before canonical startup, waits, and leaves target args unchanged", async () => {
    const config = fakeConfig();
    const result = await bootstrap(config, { fresh: true });
    const launches = vi.mocked(launchVortex).mock.calls;
    expect(launches).toHaveLength(3);
    expect(vi.mocked(ensureGameManaged).mock.calls[0]![2].activate).toBe(false);
    const first = await vi.mocked(launchVortex).mock.results[0]!.value;
    expect(vi.mocked(first.stop).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(launchVortex).mock.invocationCallOrder[1]!,
    );
    expect(launches[1]![0].config.target.args).toEqual(["--game", "fallout4"]);
    expect(vi.mocked(waitForGameStartup).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(ensureGameManaged).mock.invocationCallOrder[1]!,
    );
    expect(config.target.args).toEqual([]);
    expect(readMarker(snapshotDir(config, "test-key"))?.gameId).toBe("fallout4");
    await result.instance.stop();
  });

  it.each(["--game=other", "--profile", "--game"])(
    "rejects conflicting %s before launching",
    async (arg) => {
      const config = fakeConfig();
      config.target.args = [arg];
      await expect(bootstrap(config, { fresh: true })).rejects.toThrow(/cannot override/);
      expect(launchVortex).not.toHaveBeenCalled();
    },
  );

  it("does not publish a snapshot or start a live session when activation fails", async () => {
    const config = fakeConfig();
    vi.mocked(waitForGameStartup).mockRejectedValueOnce(new Error("activation failed"));
    await expect(bootstrap(config, { fresh: true })).rejects.toThrow("activation failed");
    expect(launchVortex).toHaveBeenCalledTimes(2);
    expect(readMarker(snapshotDir(config, "test-key"))).toBeUndefined();
    const second = await vi.mocked(launchVortex).mock.results[1]!.value;
    expect(second.stop).toHaveBeenCalledTimes(1);
  });

  it("does not enter the normal management path or publish a snapshot before native activation finishes", async () => {
    const config = fakeConfig();
    let activate!: (value: boolean) => void;
    const pendingActivation = new Promise<boolean>((resolve) => {
      activate = resolve;
    });
    vi.mocked(waitForGameStartup).mockImplementationOnce(() => pendingActivation);
    const starting = bootstrap(config, { fresh: true });
    await vi.waitFor(() => expect(waitForGameStartup).toHaveBeenCalledTimes(1));
    expect(ensureGameManaged).toHaveBeenCalledTimes(1);
    expect(readMarker(snapshotDir(config, "test-key"))).toBeUndefined();
    activate(true);
    const result = await starting;
    expect(ensureGameManaged).toHaveBeenCalledTimes(2);
    expect(readMarker(snapshotDir(config, "test-key"))).toBeDefined();
    await result.instance.stop();
  });

  it("does not start the management phase after a failed registration-phase shutdown", async () => {
    const config = fakeConfig();
    const normalLaunch = vi.mocked(launchVortex).getMockImplementation()!;
    vi.mocked(launchVortex).mockImplementationOnce(async (options) => {
      const instance = await normalLaunch(options);
      vi.mocked(instance.stop).mockRejectedValueOnce(new Error("still running"));
      return instance;
    });
    await expect(bootstrap(config, { fresh: true })).rejects.toThrow("still running");
    expect(launchVortex).toHaveBeenCalledTimes(1);
    expect(waitForGameStartup).not.toHaveBeenCalled();
    expect(readMarker(snapshotDir(config, "test-key"))).toBeUndefined();
  });

  it("retains registration and shutdown errors and never launches the management phase", async () => {
    const config = fakeConfig();
    const original = new Error("registration failed");
    const cleanup = new Error("shutdown failed");
    vi.mocked(ensureGameManaged).mockRejectedValueOnce(original);
    vi.mocked(launchVortex).mockResolvedValueOnce({
      mcp: { call: vi.fn(async () => ({ oauthPresent: true })) },
      stop: vi.fn(async () => {
        throw cleanup;
      }),
    } as never);
    const failure = await bootstrap(config, { fresh: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original, cleanup]);
    expect((failure as Error).cause).toBe(original);
    expect(launchVortex).toHaveBeenCalledTimes(1);
    expect(readMarker(snapshotDir(config, "test-key"))).toBeUndefined();
  });

  it("rejects a game activated at a different path without correcting it or caching it", async () => {
    const config = fakeConfig();
    const normalLaunch = vi.mocked(launchVortex).getMockImplementation()!;
    vi.mocked(launchVortex)
      .mockImplementationOnce(normalLaunch)
      .mockImplementationOnce(async (options) => {
        const instance = await normalLaunch(options);
        vi.mocked(instance.mcp.call).mockResolvedValue({ path: "C:/Wrong/Real Game" });
        return instance;
      });
    await expect(bootstrap(config, { fresh: true })).rejects.toThrow(/different game path/);
    expect(ensureGameManaged).toHaveBeenCalledTimes(1);
    expect(readMarker(snapshotDir(config, "test-key"))).toBeUndefined();
  });

  it("keeps no-game bootstrap to one cold launch and one live launch", async () => {
    const config = fakeConfig();
    const result = await bootstrap(config, { fresh: true, skipGame: true });
    expect(launchVortex).toHaveBeenCalledTimes(2);
    expect(waitForGameStartup).not.toHaveBeenCalled();
    expect(ensureGameManaged).not.toHaveBeenCalled();
    expect(readMarker(snapshotDir(config, "test-key", true))?.gameSkipped).toBe(true);
    await result.instance.stop();
  });
});

describe("real copied game preservation", () => {
  it.each([false, true])(
    "preserveGameFixture=%s retains masters only when explicitly requested",
    async (preserveGameFixture) => {
      const config = fakeConfig();
      config.gamePath = path.join(config.cacheDir, "game");
      const data = path.join(config.gamePath, "Data");
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, "Skyrim.esm"), "copied game master fixture bytes");
      fs.writeFileSync(
        path.join(data, "Skyrim - Textures.bsa"),
        "copied game archive fixture bytes",
      );
      fs.writeFileSync(authCacheFile(config), "null");
      await bootstrap(config, { fresh: true, preserveGameFixture });
      expect(fs.existsSync(path.join(data, "Skyrim.esm"))).toBe(preserveGameFixture);
      expect(fs.existsSync(path.join(data, "Skyrim - Textures.bsa"))).toBe(preserveGameFixture);
      if (preserveGameFixture)
        expect(fs.readFileSync(path.join(data, "Skyrim.esm"), "utf8")).toBe(
          "copied game master fixture bytes",
        );
    },
  );
});

describe("captureLogin", () => {
  it("promotes the working directory and records that a login was captured", async () => {
    const config = fakeConfig();
    const live = liveDir(config);
    fs.mkdirSync(path.join(live, "userData"), { recursive: true });
    // Stands in for whatever Vortex wrote — the point is that it is copied
    // wholesale, never read, so the credential stays opaque to this code.
    fs.writeFileSync(path.join(live, "userData", "state.db"), "opaque-bytes");

    await captureLogin(config);

    const snapshot = snapshotDir(config, "test-key");
    expect(fs.readFileSync(path.join(snapshot, "userData", "state.db"), "utf8")).toBe(
      "opaque-bytes",
    );
    expect(readMarker(snapshot)?.loginCaptured).toBe(true);
    expect(readMarker(loginDir(config))?.loginCaptured).toBe(true);
  });

  it("replaces an earlier snapshot rather than merging into it", async () => {
    // A merge would leave files from the pre-login snapshot behind, which is
    // how a "captured" login ends up half-applied and failing much later.
    const config = fakeConfig();
    const snapshot = snapshotDir(config, "test-key");
    fs.mkdirSync(path.join(snapshot, "userData"), { recursive: true });
    fs.writeFileSync(path.join(snapshot, "userData", "stale.txt"), "from the old snapshot");

    const live = liveDir(config);
    fs.mkdirSync(path.join(live, "userData"), { recursive: true });
    fs.writeFileSync(path.join(live, "userData", "fresh.txt"), "signed in");

    await captureLogin(config);

    expect(fs.existsSync(path.join(snapshot, "userData", "fresh.txt"))).toBe(true);
    expect(fs.existsSync(path.join(snapshot, "userData", "stale.txt"))).toBe(false);
  });

  it("refuses when there is no working directory to capture", async () => {
    await expect(captureLogin(fakeConfig())).rejects.toThrow(/no working directory/i);
  });

  it("does not stop or copy an unsigned profile", async () => {
    const config = fakeConfig();
    fs.mkdirSync(path.join(liveDir(config), "userData"));
    vi.mocked(requireOAuth).mockRejectedValueOnce(new Error("OAuth setup incomplete"));
    await expect(captureLogin(config)).rejects.toThrow("OAuth setup incomplete");
    expect(stopStaleInstance).not.toHaveBeenCalled();
    expect(fs.existsSync(loginDir(config))).toBe(false);
  });

  it("preserves the previous login when clean shutdown fails", async () => {
    const config = fakeConfig();
    fs.mkdirSync(path.join(liveDir(config), "userData"));
    fs.mkdirSync(loginDir(config));
    fs.writeFileSync(path.join(loginDir(config), "sentinel"), "previous login");
    vi.mocked(stopStaleInstance).mockRejectedValueOnce(new Error("did not exit cleanly"));
    await expect(captureLogin(config)).rejects.toThrow("did not exit cleanly");
    expect(fs.readFileSync(path.join(loginDir(config), "sentinel"), "utf8")).toBe("previous login");
  });
});
