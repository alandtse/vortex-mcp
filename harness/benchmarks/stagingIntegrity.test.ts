import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BenchmarkSession } from "./session";
import type { RunManifest } from "./types";
import type { HarnessConfig } from "../src/config";
import type { VortexInstance } from "../src/instance";
import type { RendererHandle } from "../src/cdp";

// Only the recorder is replaced: these cases test sample acceptance, not native phase timings.
vi.mock("./collectionEvents", async (original) => ({
  ...(await original<typeof import("./collectionEvents")>()),
  CollectionRecorder: class {
    phases = [];
    exclusions = [];
    async start() {}
    markAdd() {}
    async stop() {}
  },
}));

const base = path.resolve("harness/.artifacts/benchmark-unit-fixtures");
const roots: string[] = [];
afterEach(() => {
  vi.doUnmock("../src/collections");
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== base || !path.basename(root).startsWith("staging-integrity-"))
      throw new Error("Invalid fixture cleanup target");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "staging-integrity-"));
  roots.push(root);
  const staging = path.join(root, "staging"),
    downloads = path.join(root, "downloads");
  const game = path.join(root, "game");
  for (const folder of ["collection", "member"])
    fs.mkdirSync(path.join(staging, folder), { recursive: true });
  fs.mkdirSync(downloads);
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "game.exe"), "unit game bytes");
  fs.writeFileSync(path.join(staging, "member", "file.txt"), "unit installed member bytes");
  const archive = path.join(downloads, "member.zip");
  fs.writeFileSync(archive, "unit cache bytes; not a genuine mod archive");
  const records: Record<
    string,
    { state: string; installationPath?: string; [key: string]: unknown }
  > = {
    collection: {
      state: "installed",
      type: "collection",
      installationPath: "collection",
      attributes: { collectionSlug: "fixture", revisionNumber: 2 },
      rules: [{ type: "requires" }],
    },
    member: { state: "installed", installationPath: "member" },
  };
  const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
    if (tool === "vortex_dispatch") {
      delete records[(args.args as string[])[1]!];
      return;
    }
    if (tool === "collection_status")
      return [{ collectionModId: "collection", required: 1, satisfied: 1, complete: true }];
    if (args.selector) return args.selector === "installPathForGame" ? staging : downloads;
    const keys = args.path as string[];
    if (keys.at(-1) === "collection") return records.collection;
    if (keys.at(-1) === "needToDeploy") return { skyrimse: false };
    if (keys.includes("downloads"))
      return {
        archive: { state: "finished", localPath: "member.zip", size: fs.statSync(archive).size },
      };
    return records;
  });
  vi.doMock("../src/collections", () => ({
    resolveCollection: async () => ({ modCount: 2 }),
    parseCollectionRef: () => ({ gameId: "skyrimse", slug: "fixture", revision: 2 }),
    installCollection: async (
      _mcp: unknown,
      _url: string,
      options: { verifyCompletion: (id: string, timeout: number) => Promise<void> },
    ) => {
      await options.verifyCompletion("collection", 500);
      return { modId: "collection", complete: true, modCount: 1, expectedModCount: 1 };
    },
  }));
  const page = {
    evaluate: vi.fn(async (source: unknown) =>
      typeof source === "string" && source.includes("return {tasks:data.tasks")
        ? { tasks: [], frames: [], inputs: [] }
        : typeof source === "string" && source.includes("return data.intervals")
          ? []
          : {
              collectionModId: "collection",
              viewVisible: true,
              driver: { step: "review", installDone: true, postprocessing: false },
              progress: { visible: false, statuses: {} },
            },
    ),
  };
  const manifest: RunManifest = {
    profile: {
      hardware: "unit fixture",
      storage: "unit fixture",
      bandwidth: "no network",
      account: "anonymous",
      osSecurity: "unit fixture",
      vortexBuild: "mocked native state",
    },
    collection: {
      url: "nxm://skyrimspecialedition/collections/fixture/revisions/2",
      engine: "Creation",
      gameId: "skyrimse",
      authCache: path.join(root, "unused-auth.json"),
      gameFixture: game,
      allowGameFixtureCopy: true,
      expectedMods: 2,
      ready: { gameFiles: ["game.exe"], equals: true },
    },
  };
  const session = new BenchmarkSession(
    { cacheDir: root, gamePath: game, gameId: "skyrimse" } as HarnessConfig,
    { mcp: { call } } as unknown as VortexInstance,
    { page } as unknown as RendererHandle,
    manifest,
    "real",
  );
  return { root, staging, archive, records, call, session };
}

it.each(["missing", "file", "escape", "no-path", "linked"])(
  "warm preparation refuses invalid staging before purge or metadata removal: %s",
  async (invalid) => {
    const h = fixture();
    const folder = path.join(h.staging, "member");
    fs.rmSync(folder, { recursive: true });
    if (invalid === "file") fs.writeFileSync(folder, "not a directory");
    if (invalid === "escape") h.records.member!.installationPath = "../game";
    if (invalid === "no-path") delete h.records.member!.installationPath;
    if (invalid === "linked") fs.symlinkSync(path.join(h.root, "game"), folder, "junction");
    const add = vi.spyOn(h.session, "addCollection").mockResolvedValue(undefined);
    const purge = vi.spyOn(h.session, "purge").mockResolvedValue(undefined);
    await expect(h.session.prepareCollection({ cache: "warm" })).rejects.toThrow(
      "Installed staging verification failed",
    );
    expect(add).toHaveBeenCalledOnce();
    expect(purge).not.toHaveBeenCalled();
    expect(h.call.mock.calls.some(([tool]) => tool === "vortex_dispatch")).toBe(false);
    expect(Object.keys(h.records)).toEqual(["collection", "member"]);
    expect(fs.readFileSync(h.archive, "utf8")).toBe("unit cache bytes; not a genuine mod archive");
    expect(h.session.evidence).toContainEqual(
      expect.objectContaining({
        operation: "installed staging verification",
        verified: false,
        installedRecords: 2,
        directoriesPresent: 1,
        failures: [expect.objectContaining({ modId: "member" })],
      }),
    );
  },
);

it("rejects missing staged data at real readiness despite complete native counters and UI", async () => {
  const h = fixture();
  await h.session.addCollection();
  fs.rmSync(path.join(h.staging, "member"), { recursive: true });
  await expect(h.session.verifyReady()).rejects.toThrow("Installed staging verification failed");
  expect(h.records.member!.state).toBe("installed");
  expect(fs.existsSync(h.archive)).toBe(true);
});

it("refuses warm cleanup when there are no installed records to verify", async () => {
  const h = fixture();
  for (const mod of Object.values(h.records)) mod.state = "downloaded";
  vi.spyOn(h.session, "addCollection").mockResolvedValue(undefined);
  const purge = vi.spyOn(h.session, "purge").mockResolvedValue(undefined);
  await expect(h.session.prepareCollection({ cache: "warm" })).rejects.toThrow(
    "No installed mod records available",
  );
  expect(purge).not.toHaveBeenCalled();
  expect(fs.existsSync(h.archive)).toBe(true);
});

it.each([
  ["action", false],
  ["action", true],
  ["collection", false],
  ["collection", true],
] as const)(
  "validates staging outside %s timing and rejects a failed sample: missing=%s",
  async (mode, missing) => {
    const h = fixture();
    if (mode === "collection") {
      fs.unlinkSync(h.archive);
      const original = h.call.getMockImplementation()!;
      h.call.mockImplementation(async (tool, args) =>
        (args.path as string[] | undefined)?.includes("downloads") ? {} : original(tool, args),
      );
      await h.session.prepareCollection({ cache: "cold" });
    }
    await h.session.addCollection();
    if (missing) fs.rmSync(path.join(h.staging, "member"), { recursive: true });
    let clock = 100;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const stat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, "lstat").mockImplementation(((
      ...args: Parameters<typeof fs.promises.lstat>
    ) => {
      clock = 10_000;
      return stat(...args);
    }) as typeof fs.promises.lstat);
    const action = async () => {
      clock = 200;
      await h.session.verifyReady();
    };
    const measured =
      mode === "action" ? h.session.measure("ready", action) : h.session.collectionMeasure(action);
    if (missing) {
      await expect(measured).rejects.toThrow("Installed staging verification failed");
      expect(h.session.measurements).toEqual([]);
    } else {
      await measured;
      expect(h.session.measurements[0]!.wallMs).toBe(100);
      expect(clock).toBe(10_000);
    }
  },
);
