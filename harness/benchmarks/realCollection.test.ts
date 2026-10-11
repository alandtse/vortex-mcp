import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCleanGameFixture, BenchmarkSession, resolveArchivePath } from "./session";
import type { RunManifest } from "./types";
import type { HarnessConfig } from "../src/config";
import type { VortexInstance } from "../src/instance";
import type { RendererHandle } from "../src/cdp";

const roots: string[] = [];
function fixture() {
  const base = path.resolve("harness/.artifacts/benchmark-unit-fixtures");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "doodlebot-benchmark-real-unit-"));
  roots.push(root);
  const game = path.join(root, "game");
  fs.mkdirSync(path.join(game, "Data"), { recursive: true });
  fs.writeFileSync(path.join(game, "SkyrimSE.exe"), "unit game executable fixture");
  fs.writeFileSync(path.join(game, "Data/Skyrim.esm"), "unit game master fixture");
  return { root, game };
}
afterEach(() => {
  vi.doUnmock("../src/collections");
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("real collection completion and game readiness", () => {
  it.each([
    "vortex.deployment.injector.json",
    "Data/vortex.deployment.json",
    "archive/pc/mod/vortex.deployment.json",
  ])("rejects source deployment evidence without altering it: %s", (relative) => {
    const { game } = fixture();
    expect(() => assertCleanGameFixture(game)).not.toThrow();
    const manifest = path.join(game, relative);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, "source deployment sentinel");
    expect(() => assertCleanGameFixture(game)).toThrow("clean Steam game copy");
    expect(fs.readFileSync(manifest, "utf8")).toBe("source deployment sentinel");
    expect(fs.readFileSync(path.join(game, "Data/Skyrim.esm"), "utf8")).toBe(
      "unit game master fixture",
    );
  });
  it.each([false, true])(
    "rejects skipped required members even when stock status reports complete: ignored=%s",
    async (ignored) => {
      const { root, game } = fixture();
      const rules = [
        { type: "requires", ignored },
        { type: "requires" },
        { type: "recommends", ignored: true },
      ];
      const required = rules.filter(
        (rule) => rule.type === "requires" && rule.ignored !== true,
      ).length;
      const install = vi.fn(
        async (
          _mcp: unknown,
          _url: string,
          options: {
            warningsAsErrors: boolean;
            timeoutMs: number;
            verifyCompletion: (id: string, remainingMs: number) => Promise<void>;
          },
        ) => {
          expect(options.timeoutMs).toBeGreaterThan(0);
          expect(options.warningsAsErrors).toBe(true);
          await options.verifyCompletion("collection", options.timeoutMs);
          return {
            modId: "collection",
            complete: true,
            modCount: required,
            expectedModCount: required,
            answeredDialogs: [],
          };
        },
      );
      vi.doMock("../src/collections", () => ({
        installCollection: install,
        parseCollectionRef: () => ({ gameId: "skyrimse", slug: "fixture", revision: 2 }),
      }));
      const mod = {
        type: "collection",
        state: "installed",
        installationPath: "collection",
        attributes: { collectionSlug: "fixture", revisionNumber: 2 },
        rules,
      };
      const staging = path.join(root, "staging");
      fs.mkdirSync(path.join(staging, "collection"), { recursive: true });
      const call = vi.fn(async (tool: string, args: Record<string, unknown>) =>
        args.selector === "installPathForGame"
          ? staging
          : tool === "collection_status"
            ? [{ collectionModId: "collection", complete: true, required, satisfied: required }]
            : (args.path as string[] | undefined)?.at(-1) === "collection"
              ? mod
              : (args.path as string[] | undefined)?.at(-1) === "needToDeploy"
                ? { skyrimse: false }
                : { collection: mod },
      );
      const manifest = {
        collection: {
          url: "nxm://skyrimspecialedition/collections/fixture/revisions/2",
          expectedMods: 3,
          ready: { gameFiles: ["SkyrimSE.exe", "Data/Skyrim.esm"], equals: true },
        },
      } as unknown as RunManifest;
      const session = new BenchmarkSession(
        { cacheDir: root, gamePath: game, gameId: "skyrimse" } as HarnessConfig,
        { mcp: { call } } as unknown as VortexInstance,
        {
          page: {
            evaluate: vi.fn(async () => ({
              collectionModId: "collection",
              viewVisible: true,
              driver: { step: "review", installDone: true, postprocessing: false },
              progress: { visible: false, statuses: {} },
            })),
          },
        } as unknown as RendererHandle,
        manifest,
        "real",
      );
      if (ignored) await expect(session.addCollection()).rejects.toThrow("skipped or ignored");
      else {
        // This case explicitly tests a second caller-requested attempt. The SDK
        // must retain the first failure even when the next call succeeds.
        install.mockRejectedValueOnce(new Error("Expected fixture download failure"));
        await expect(session.addCollection()).rejects.toThrow("Expected fixture download failure");
        await session.addCollection();
        expect(
          session.evidence
            .filter(
              (entry) =>
                (entry as { operation?: string }).operation === "real Nexus collection install",
            )
            .map((entry) => (entry as { outcome?: string }).outcome),
        ).toEqual(["failed", "passed"]);
        expect(install).toHaveBeenCalledWith(
          expect.anything(),
          manifest.collection!.url,
          expect.objectContaining({
            timeoutMs: 3600000,
            expectedListedMods: 3,
            verifyCompletion: expect.any(Function),
          }),
        );
        await session.verifyReady();
        rules[0]!.ignored = true;
        await expect(session.verifyReady()).rejects.toThrow("skipped or ignored");
        rules[0]!.ignored = false;
        vi.spyOn(session.page, "evaluate").mockResolvedValueOnce({
          collectionModId: "collection",
          viewVisible: false,
          driver: null,
          progress: { visible: false, statuses: {} },
        });
        await expect(session.addCollection()).rejects.toThrow("completion is unobservable");
        expect(session.evidence).toContainEqual(
          expect.objectContaining({
            operation: "collection UI completion",
            verified: false,
          }),
        );
        await expect(session.verifyReady()).rejects.toThrow(
          "visible UI completion have not been verified",
        );
      }
    },
  );
  it("observes only actual regular game files and rejects unsafe relative paths", async () => {
    const { root, game } = fixture();
    const session = new BenchmarkSession(
      { cacheDir: root, gamePath: game } as HarnessConfig,
      {} as VortexInstance,
      {} as RendererHandle,
      undefined,
      "real",
    );
    expect(await session.observe({ gameFiles: ["SkyrimSE.exe", "Data\\Skyrim.esm"] })).toBe(true);
    expect(await session.observe({ gameFiles: ["skse64_loader.exe"] })).toBe(false);
    expect(await session.observe({ gameFiles: ["Data"] })).toBe(false);
    for (const file of [
      "../other.exe",
      "Data/../SkyrimSE.exe",
      "C:relative.exe",
      "C:/outside.exe",
      "\\outside.exe",
    ])
      await expect(session.observe({ gameFiles: [file] })).rejects.toThrow("without traversal");
    await expect(session.observe({ gameFiles: [] })).rejects.toThrow("at least one relative file");
    fs.symlinkSync(path.join(game, "Data"), path.join(game, "LinkedData"), "junction");
    await expect(session.observe({ gameFiles: ["LinkedData/Skyrim.esm"] })).rejects.toThrow(
      "linked fixture",
    );
  });
  it("accepts the observed leading-separator archive path only inside its private download folder", () => {
    const { root } = fixture();
    const downloads = path.join(root, "downloads");
    fs.mkdirSync(downloads);
    expect(resolveArchivePath(downloads, "\\fixture.zip", root)).toBe(
      path.join(downloads, "fixture.zip"),
    );
    for (const file of [
      "../game/SkyrimSE.exe",
      "\\..\\game\\SkyrimSE.exe",
      "C:/outside.zip",
      "\\\\server\\share\\file.zip",
    ])
      expect(() => resolveArchivePath(downloads, file, root)).toThrow();
  });
  it.each([false, true])(
    "warm prep removes installed records but preserves and verifies complete cached bytes: truncated=%s",
    async (truncated) => {
      const { root, game } = fixture();
      const staging = path.join(root, "staging");
      const downloads = path.join(root, "downloads");
      fs.mkdirSync(path.join(staging, "member"), { recursive: true });
      fs.mkdirSync(downloads);
      fs.writeFileSync(path.join(staging, "member/file.txt"), "installed member unit bytes");
      const archive = path.join(downloads, "fixture.zip");
      fs.writeFileSync(archive, "cached unit archive bytes");
      const size = fs.statSync(archive).size;
      const records: Record<string, { state: string; installationPath: string }> = {
        member: { state: "installed", installationPath: "member" },
      };
      const call = vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "vortex_dispatch") {
          delete records[(args.args as string[])[1]!];
          return;
        }
        if (args.selector) return args.selector === "installPathForGame" ? staging : downloads;
        return (args.path as string[]).includes("downloads")
          ? {
              archive: {
                state: "finished",
                localPath: "\\fixture.zip",
                size: size + (truncated ? 1 : 0),
              },
            }
          : records;
      });
      vi.doMock("../src/collections", () => ({
        resolveCollection: async () => ({ modCount: 3 }),
        parseCollectionRef: () => ({ gameId: "skyrimse", slug: "fixture", revision: 2 }),
      }));
      const manifest = {
        collection: {
          url: "nxm://skyrimspecialedition/collections/fixture/revisions/2",
          expectedMods: 3,
        },
      } as RunManifest;
      const session = new BenchmarkSession(
        { cacheDir: root, gamePath: game, gameId: "skyrimse" } as HarnessConfig,
        { mcp: { call } } as unknown as VortexInstance,
        {} as RendererHandle,
        manifest,
        "real",
      );
      vi.spyOn(session, "addCollection").mockResolvedValue(undefined);
      vi.spyOn(session, "purge").mockResolvedValue(undefined);
      if (truncated)
        await expect(session.prepareCollection({ cache: "warm" })).rejects.toThrow("truncated");
      else await session.prepareCollection({ cache: "warm" });
      expect(records).toEqual({});
      expect(fs.existsSync(path.join(staging, "member"))).toBe(false);
      expect(fs.readFileSync(archive, "utf8")).toBe("cached unit archive bytes");
    },
  );
});
