import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { Page } from "@playwright/test";
import type { HarnessConfig } from "../src/config";
import type { VortexInstance } from "../src/instance";
import type { RendererHandle } from "../src/cdp";
import { BenchmarkTable } from "./tables";
import { waitForCollectionCompletion } from "./collectionCompletion";
import { CollectionRecorder, CollectionDownloadFailed } from "./collectionEvents";
import { verifySkyrimEdition } from "./skyrimEdition";
import { excludedDuration } from "./timing";
import { retainedFixtureError, runInSession } from "./lifecycle";
import { beginOAuthCache, type OAuthCacheLease } from "./credentials";
import { verifyGameSnapshot, gameSnapshotManifest, assertRegularPath } from "./gameFixtures";
import { resetGameSettings, gameSettingsResource } from "./gameSettings";
import { holdLease, addInstancePid, removeInstancePid, type HoldResult } from "../src/lease";
import {
  BenchmarkBlocked,
  type RunManifest,
  type Observation,
  type Expectation,
  type Measurement,
  type PhaseEvent,
  type Exclusion,
  type TableName,
  type TableDefinition,
  type DatasetKind,
} from "./types";

const defaults: Partial<Record<TableName, TableDefinition>> = {
  mods: {
    page: "Mods",
    root: "#table-mods",
    rows: "#table-mods tr[data-rowid]",
    scroller: "#table-mods .table-main-pane",
    search: '#table-mods input[type="text"]',
  },
  downloads: {
    page: "Downloads",
    root: "#table-downloads",
    rows: "#table-downloads tr[data-rowid]",
    scroller: "#table-downloads .table-main-pane",
    search: '#table-downloads .table-header-pane .header-filename input[type="text"]',
  },
};

export interface SessionOptions {
  executable?: string;
  outputDir?: string;
  manifest?: RunManifest;
  dataset?: DatasetKind;
  /** Require a verified game snapshot and back up/reset supported per-user game settings before launch. */
  cleanStart?: true;
}
export class BenchmarkSession {
  readonly warnings: import("../src/collections").CollectionWarning[] = [];
  private recordWarning(warning: import("../src/collections").CollectionWarning): void {
    if (this.warnings.some((prior) => prior.id === warning.id && prior.source === warning.source))
      return;
    this.warnings.push(warning);
    this.evidence.push({ operation: "collection warning", ...warning });
  }
  readonly measurements: Measurement[] = [];
  readonly phases: PhaseEvent[] = [];
  readonly exclusions: Exclusion[] = [];
  readonly evidence: unknown[] = [];
  private warm = false;
  private prepared = false;
  private collectionTiming = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private measurementDepth = 0;
  private validations: Array<() => Promise<void>> = [];
  private installedCollectionId: string | undefined;
  private collectionUiVerified = false;
  private tables = new Map<TableName, BenchmarkTable>();
  constructor(
    readonly config: HarnessConfig,
    private instance: VortexInstance,
    private handle: RendererHandle,
    readonly manifest: RunManifest | undefined,
    readonly dataset: DatasetKind,
    private readonly oauthCache?: OAuthCacheLease,
    private readonly gameSettingsLease?: HoldResult,
    private readonly spawnedProcesses: Set<ChildProcess> = new Set(),
  ) {}
  get page(): Page {
    return this.handle.page;
  }
  get mcp() {
    return this.instance.mcp;
  }
  get gameId(): string {
    return this.config.gameId;
  }
  get timeoutMs(): number {
    return this.manifest?.timeoutMs ?? (this.dataset === "real" ? 60 * 60 * 1000 : 120_000);
  }
  private async downloadControlOptions() {
    if (this.closed || this.closing || this.dataset !== "real")
      throw new Error("Download control requires an open real collection session");
    const rows = await this.call<Array<{ collectionModId: string }>>("collection_status", {
      gameId: this.gameId,
    });
    if (rows.length !== 1)
      throw new Error(
        "Download control requires exactly one collection in the owned benchmark profile",
      );
    return {
      gameId: this.gameId,
      collectionModId: rows[0]!.collectionModId,
      exclusiveProfile: true as const,
    };
  }
  async pauseDownloads() {
    const { pauseCollectionDownloads } = await import("../src/collectionDownloads");
    const result = await pauseCollectionDownloads(this.mcp, await this.downloadControlOptions());
    this.evidence.push({ operation: "downloads paused", ...result });
    return result;
  }
  async downloadProgress() {
    if (this.closed || this.closing) throw new Error("Download progress requires an open session");
    const { downloadProgress } = await import("../src/collectionDownloads");
    return downloadProgress(this.mcp);
  }
  async resumeDownloads() {
    const { resumeCollectionDownloads } = await import("../src/collectionDownloads");
    const result = await resumeCollectionDownloads(this.mcp, await this.downloadControlOptions());
    this.evidence.push({ operation: "collection downloads resumed", ...result });
    return result;
  }
  async call<T = unknown>(
    tool: string,
    args: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    return this.instance.mcp.call<T>(tool, args, timeoutMs);
  }
  assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
  block(reason: string): never {
    throw new BenchmarkBlocked(reason);
  }
  async observe(observation: Observation): Promise<unknown> {
    if (observation.gameFiles) {
      const game = this.config.gamePath;
      if (!game || observation.gameFiles.length === 0)
        throw new Error(
          "gameFiles observation requires a copied game path and at least one relative file",
        );
      assertInside(this.config.cacheDir, game);
      const targets = observation.gameFiles.map((relative) => {
        if (
          !relative ||
          path.isAbsolute(relative) ||
          path.win32.isAbsolute(relative) ||
          /^[a-z]:/i.test(relative) ||
          relative.split(/[\\/]/).includes("..")
        )
          throw new Error(
            "gameFiles must contain relative files inside the copied game without traversal",
          );
        const target = path.resolve(game, relative.replace(/[\\/]/g, path.sep));
        assertInside(game, target);
        return target;
      });
      return targets.every((target) => fs.existsSync(target) && fs.statSync(target).isFile());
    }
    if (observation.path) return this.call("vortex_query", { path: observation.path });
    if (!observation.selector) throw new Error("Observation requires selector or path");
    const locator = this.page.locator(observation.selector);
    if (observation.read === "count") return locator.count();
    if (observation.read === "texts") return locator.allTextContents();
    if ((await locator.count()) !== 1)
      throw new BenchmarkBlocked(`Observation requires one match: ${observation.selector}`);
    if (observation.read === "value") return locator.inputValue();
    if (observation.read === "attribute") {
      if (!observation.attribute) throw new Error("Attribute observation requires attribute");
      return locator.getAttribute(observation.attribute);
    }
    return (await locator.textContent())?.trim() ?? "";
  }
  async waitFor(expectation: Expectation): Promise<void> {
    const until = Date.now() + this.timeoutMs;
    for (;;) {
      if (JSON.stringify(await this.observe(expectation)) === JSON.stringify(expectation.equals))
        return;
      if (Date.now() >= until)
        throw new Error(
          `Action did not produce expected observable result: ${JSON.stringify(expectation)}`,
        );
      await this.page.waitForTimeout(25);
    }
  }
  async openPage(page: string): Promise<void> {
    const label = page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const button = this.page.getByRole("button", { name: new RegExp(`^${label}$`, "i") });
    if ((await button.count()) !== 1 || !(await button.isVisible()))
      this.block(
        `No unique visible navigation control for ${page}; supply the game's actual page label`,
      );
    await button.click();
  }
  table(name: TableName): BenchmarkTable {
    if ((name === "plugins" || name === "load-order") && this.dataset !== "real")
      this.block(
        `${name}: real engine-specific installed data is required; sandbox rows do not cover this engine`,
      );
    const definition = this.manifest?.tables?.[name] ?? defaults[name];
    if (!definition)
      this.block(
        `${name}: configure manifest.tables.${name} with actual game-specific page, root, rows and scroller`,
      );
    let table = this.tables.get(name);
    if (!table) {
      table = new BenchmarkTable(this, definition, name);
      this.tables.set(name, table);
    }
    return table;
  }
  async measure<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.measurementDepth > 0)
      throw new Error("Measurements cannot nest; time each observable action once");
    const baseName = name;
    let occurrence = 2;
    while (this.measurements.some((item) => item.name === name))
      name = `${baseName}.${occurrence++}`;
    this.measurementDepth++;
    const start = Date.now();
    try {
      await this.page.evaluate(`(() => {
      const data={tasks:[],frames:[],inputs:[],running:true};window.__doodleBenchmark=data;
      data.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())data.tasks.push(entry.duration);});data.observer.observe({type:'longtask'});
      if(PerformanceObserver.supportedEntryTypes.includes('event')){
        data.inputObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries())data.inputs.push(entry.processingStart-entry.startTime);});data.inputObserver.observe({type:'event',durationThreshold:16});
      }
      let last=performance.now();requestAnimationFrame(function frame(now){data.frames.push(now-last);last=now;if(data.running)requestAnimationFrame(frame);});
    })()`);
      const value = await action();
      // Allow the consequence to paint, rather than ending at an action's dispatch.
      await this.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const end = Date.now();
      const sample = (await this.page.evaluate(`(() => {const data=window.__doodleBenchmark;
        for(const entry of data.observer.takeRecords())data.tasks.push(entry.duration);
        for(const entry of data.inputObserver?.takeRecords()??[])data.inputs.push(entry.processingStart-entry.startTime);
        return {tasks:data.tasks,frames:data.frames.slice(1),inputs:data.inputs};})()`)) as {
        tasks: number[];
        frames: number[];
        inputs: number[];
      };
      const excludedMs = excludedDuration(start, end, this.exclusions);
      for (const validate of this.validations.splice(0)) await validate();
      this.measurements.push({
        name,
        wallMs: end - start,
        excludedMs,
        activeMs: end - start - excludedMs,
        inputDelayMs: sample.inputs.length ? Math.max(...sample.inputs) : null,
        blockedMs: sample.tasks.reduce((sum, n) => sum + n, 0),
        worstTaskMs: Math.max(0, ...sample.tasks),
        worstFrameMs: Math.max(0, ...sample.frames),
      });
      return value;
    } finally {
      this.measurementDepth--;
      this.validations = [];
      await this.page
        .evaluate(
          `(() => {const data=window.__doodleBenchmark;if(data){data.running=false;data.observer.disconnect();data.inputObserver?.disconnect();delete window.__doodleBenchmark;}})()`,
        )
        .catch(() => undefined);
    }
  }
  async excluded<T>(reason: Exclusion["reason"], wait: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await wait();
    } finally {
      this.exclusions.push({ reason, start, end: Date.now() });
    }
  }
  async seedMods(count = this.manifest?.synthetic?.count ?? 150): Promise<string[]> {
    if (this.dataset !== "synthetic")
      this.block("Synthetic mod seeding cannot be used as real collection evidence");
    if (!Number.isInteger(count) || count < 2)
      throw new Error("At least two synthetic mods required");
    const { seedLibrary } = await import("../src/largeLibrary");
    const result = await seedLibrary(this.instance.mcp, {
      count,
      filesPerMod: this.manifest?.synthetic?.filesPerMod,
    });
    this.assert(result.modIds.length === count, "Wrong synthetic mod count");
    const records = await this.call<Record<string, unknown>>("vortex_query", {
      path: ["persistent", "mods", this.gameId],
    });
    this.assert(
      Object.keys(records).length === count,
      "Seeded library count does not match Vortex state",
    );
    this.evidence.push({
      fixture: "synthetic staging files + Vortex addMods",
      count,
      gameId: this.gameId,
    });
    return result.modIds;
  }
  async seedDownloads(count = this.manifest?.synthetic?.count ?? 150): Promise<void> {
    if (this.dataset !== "synthetic")
      this.block("Synthetic archive seeding cannot be used as real collection download evidence");
    if (!Number.isInteger(count) || count < 2)
      throw new Error("At least two synthetic downloads required");
    const { zipSync, strToU8 } = await import("fflate");
    const folder = await this.safeSelectorPath("downloadPathForGame");
    fs.mkdirSync(folder, { recursive: true });
    const archive = zipSync({
      "fixture.txt": strToU8("Synthetic UI archive, not a Nexus download"),
    });
    const initial = await this.call<Record<string, unknown>>("vortex_query", {
      path: ["persistent", "downloads", "files"],
    });
    this.assert(
      Object.keys(initial ?? {}).length === 0,
      "Synthetic Downloads fixture requires an empty download set",
    );
    const expected = new Set<string>();
    for (let index = 0; index < count; index++) {
      const fileName = `benchmark-download-${String(index).padStart(5, "0")}.zip`;
      expected.add(fileName);
      // Match the released Windows watcher's observed localPath exactly. Reserve
      // every record before exposing files to it: burst events can be dropped,
      // and bare filenames racing the watcher produce duplicate records.
      await this.call("vortex_dispatch", {
        action: "addLocalDownload",
        args: [
          `benchmark-download-${String(index).padStart(5, "0")}`,
          this.gameId,
          `${path.sep}${fileName}`,
          archive.byteLength,
        ],
      });
    }
    for (const fileName of expected) {
      fs.writeFileSync(path.join(folder, fileName), archive);
      this.assert(
        fs.statSync(path.join(folder, fileName)).size === archive.byteLength,
        "Synthetic archive size does not match registered download",
      );
    }
    const deadline = Date.now() + this.timeoutMs;
    let readySince: number | undefined;
    for (;;) {
      const records = await this.call<
        Record<string, { localPath?: string; state?: string; size?: number }>
      >("vortex_query", {
        path: ["persistent", "downloads", "files"],
      });
      const entries = Object.values(records ?? {});
      const names = entries.map((record) => path.win32.basename(record.localPath ?? ""));
      this.assert(
        entries.length <= count &&
          new Set(names).size === names.length &&
          names.every((name) => expected.has(name)),
        "Synthetic download watcher produced duplicate or unexpected records",
      );
      if (
        entries.length === count &&
        entries.every((record) => record.state === "finished" && record.size === archive.byteLength)
      ) {
        readySince ??= Date.now();
        if (Date.now() - readySince >= 1000) break;
      } else readySince = undefined;
      if (Date.now() >= deadline)
        this.block(
          `Synthetic Downloads watcher indexed ${entries.length}/${count} finished archives before timeout; retained files can be inspected`,
        );
      await this.page.waitForTimeout(100);
    }
    this.evidence.push({
      fixture:
        "synthetic finished local ZIP archives registered with Vortex's observed watcher paths",
      count,
    });
  }
  private async safeSelectorPath(selector: string): Promise<string> {
    const result = await this.call<string>("vortex_query", { selector, args: [this.gameId] });
    assertInside(this.config.cacheDir, result);
    return result;
  }
  async prepareCollection(options: { cache: "cold" | "warm" }): Promise<void> {
    const collection = this.manifest?.collection;
    if (this.dataset !== "real" || !collection)
      this.block("A real pinned collection manifest is required");
    const { resolveCollection, parseCollectionRef } = await import("../src/collections");
    const resolved = await resolveCollection(parseCollectionRef(collection.url));
    this.assert(
      resolved.modCount === collection.expectedMods,
      `Pinned collection changed: expected ${collection.expectedMods}, received ${resolved.modCount}`,
    );
    this.warm = options.cache === "warm";
    if (this.warm) {
      await this.addCollection();
      const { modsStillInstalling } = await import("../src/deployment");
      this.assert(
        (await modsStillInstalling(this.instance.mcp, this.gameId)).length === 0,
        "Warm prefill still has unfinished installers",
      );
      await this.verifyInstalledStaging();
      await this.purge();
      const staging = await this.safeSelectorPath("installPathForGame");
      const records = await this.call<Record<string, { installationPath?: string }>>(
        "vortex_query",
        { path: ["persistent", "mods", this.gameId] },
      );
      for (const [id, mod] of Object.entries(records)) {
        await this.call("vortex_dispatch", { action: "removeMod", args: [this.gameId, id] });
        if (mod.installationPath) {
          const folder = path.resolve(staging, mod.installationPath);
          assertInside(this.config.cacheDir, folder);
          fs.rmSync(folder, { recursive: true, force: true });
        }
      }
      const remaining = await this.call<Record<string, unknown>>("vortex_query", {
        path: ["persistent", "mods", this.gameId],
      });
      this.assert(
        Object.keys(remaining ?? {}).length === 0,
        "Warm preparation did not leave a clean installed-mod set",
      );
      const files = await this.call<
        Record<string, { state?: string; localPath?: string; size?: number }>
      >("vortex_query", { path: ["persistent", "downloads", "files"] });
      const downloads = await this.safeSelectorPath("downloadPathForGame");
      this.assert(Object.keys(files).length > 0, "Warm cache has no archives");
      for (const file of Object.values(files)) {
        this.assert(
          file.state === "finished" && typeof file.localPath === "string",
          "Warm cache contains an incomplete archive",
        );
        const archive = resolveArchivePath(downloads, file.localPath, this.config.cacheDir);
        this.assert(fs.existsSync(archive), `Warm archive missing: ${file.localPath}`);
        this.assert(
          fs.statSync(archive).isFile() &&
            typeof file.size === "number" &&
            file.size > 0 &&
            fs.statSync(archive).size === file.size,
          "Warm archive is truncated, not a regular file, or missing its completed size",
        );
      }
      this.evidence.push({
        cache: "warm",
        completePrefill: true,
        archives: Object.keys(files).length,
      });
    } else {
      const downloads = await this.safeSelectorPath("downloadPathForGame");
      const records = await this.call<Record<string, unknown>>("vortex_query", {
        path: ["persistent", "downloads", "files"],
      });
      this.assert(
        Object.keys(records ?? {}).length === 0,
        "Cold precondition: download records must be empty",
      );
      this.assert(
        !fs.existsSync(downloads) || fs.readdirSync(downloads).length === 0,
        "Cold precondition: downloads folder must be empty",
      );
      this.evidence.push({ cache: "cold", archives: 0 });
    }
    this.prepared = true;
  }
  async addCollection(): Promise<void> {
    const collection = this.manifest?.collection;
    if (this.dataset !== "real" || !collection)
      this.block("Add collection requires a real pinned collection and OAuth");
    this.collectionUiVerified = false;
    try {
      const { installCollection } = await import("../src/collections");
      const result = await installCollection(this.instance.mcp, collection.url, {
        warningsAsErrors: collection.warningsAsErrors ?? true,
        onWarning: (warning) => this.recordWarning(warning),
        timeoutMs: this.timeoutMs,
        expectedListedMods: collection.expectedMods,
        optionalMods: collection.optionalMods,
        verifyCompletion: async (modId, remainingMs) => {
          let last: unknown;
          try {
            await waitForCollectionCompletion(this.page, modId, {
              timeoutMs: remainingMs,
              onObservation: (snapshot) => {
                last = snapshot;
              },
            });
            this.collectionUiVerified = true;
          } finally {
            this.evidence.push({
              operation: "collection UI completion",
              verified: this.collectionUiVerified,
              snapshot: last,
            });
          }
        },
      });
      this.assert(
        result.complete &&
          result.expectedModCount > 0 &&
          result.modCount === result.expectedModCount,
        "Collection installation is incomplete",
      );
      this.assert(typeof result.modId === "string", "No pinned collection mod was installed");
      const required = await this.verifyCollectionMembers(result.modId);
      this.assert(
        required === result.expectedModCount,
        "Coordinator completeness did not include every required collection rule",
      );
      this.installedCollectionId = result.modId;
      this.evidence.push({
        operation: "real Nexus collection install",
        outcome: "passed",
        url: collection.url,
        modCount: result.modCount,
        requiredMods: result.expectedModCount,
        listedMods: collection.expectedMods,
        answeredDialogs: result.answeredDialogs,
        downloadThreads: result.downloadThreads,
        optionalMods: result.optionalMods,
        optionalCount: result.optionalCount,
        optionalSatisfied: result.optionalSatisfied,
        warningsAsErrors: collection.warningsAsErrors ?? true,
        warnings: result.warnings ?? [],
        skyrimEdition: collection.skyrimEdition,
        controlOverhead: {
          installDriverWaitMs: 4000,
          completionPollIntervalMs: 5000,
          note: "Existing collection coordinator has a forced startup wait and periodic completion polling; total includes this harness coordination. Phase event timestamps do not depend on listener polling.",
        },
      });
    } catch (error) {
      this.evidence.push({
        operation: "real Nexus collection install",
        outcome: "failed",
        at: Date.now(),
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  private async verifyCollectionMembers(modId: string): Promise<number> {
    const collection = this.manifest?.collection;
    if (!collection) this.block("Pinned collection manifest is required for real readiness");
    const { parseCollectionRef } = await import("../src/collections");
    const ref = parseCollectionRef(collection.url);
    const mod = await this.call<{
      type?: string;
      state?: string;
      attributes?: { collectionSlug?: string; revisionNumber?: number };
      rules?: { type?: string; ignored?: boolean }[];
    } | null>("vortex_query", { path: ["persistent", "mods", this.gameId, modId] });
    this.assert(
      mod?.type === "collection" &&
        mod.state === "installed" &&
        mod.attributes?.collectionSlug === ref.slug &&
        Number(mod.attributes.revisionNumber) === ref.revision,
      "Installed collection identity/state does not match the pinned revision",
    );
    if (!Array.isArray(mod.rules))
      this.block("Pinned collection has no observable rules; completeness cannot be verified");
    const required = mod.rules.filter((rule) => rule.type === "requires");
    const optional = mod.rules.filter((rule) => rule.type === "recommends");
    const choice = collection.optionalMods ?? "skip";
    this.assert(
      optional.every((rule) => rule.ignored === (choice === "skip")),
      "Optional collection rules do not match the requested install/skip policy",
    );
    if (required.some((rule) => rule.ignored === true))
      this.block(
        "A required collection member was skipped or ignored; install its genuine dependency before claiming completion",
      );
    this.assert(required.length > 0, "Pinned collection has no required member rules");
    const statuses = await this.call<
      {
        collectionModId: string;
        required: number;
        satisfied: number;
        complete: boolean;
        optional?: number;
        optionalSatisfied?: number;
        optionalIgnored?: number;
      }[]
    >("collection_status", { gameId: this.gameId });
    const status = statuses.find((item) => item.collectionModId === modId);
    this.assert(
      status?.complete === true &&
        status.required === required.length &&
        status.satisfied === required.length,
      "Pinned collection still has unsatisfied required members",
    );
    if (choice === "install")
      this.assert(
        status.optional === optional.length &&
          status.optionalSatisfied === optional.length &&
          status.optionalIgnored === 0,
        "Selected optional members are not all installed and enabled",
      );
    return required.length;
  }
  async collectionMeasure(action: () => Promise<void>): Promise<void> {
    if (!this.prepared)
      this.block("Call prepareCollection({cache:'cold'|'warm'}) before collectionMeasure");
    if (this.collectionTiming) throw new Error("Collection measurement already active");
    const recorder = new CollectionRecorder(this, this.warm, {
      warningsAsErrors: this.manifest?.collection?.warningsAsErrors ?? true,
      onWarning: (warning) => this.recordWarning(warning),
    });
    let timingFailure: unknown;
    try {
      await recorder.start();
    } catch (error) {
      timingFailure = error;
    }
    this.collectionTiming = true;
    const start = Date.now();
    recorder.markAdd();
    let waitObserverReady = false;
    try {
      await this.page.evaluate(`(() => {
      const data={intervals:[],start:null};window.__doodleCollectionWait=data;
      const check=()=>{const open=Array.from(document.querySelectorAll('[role="dialog"], .modal.in')).some(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0;});
        if(open&&data.start===null)data.start=Date.now();if(!open&&data.start!==null){data.intervals.push({reason:'user-wait',start:data.start,end:Date.now()});data.start=null;}};
      data.observer=new MutationObserver(check);data.observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','aria-hidden']});check();
    })()`);
      waitObserverReady = true;
    } catch (error) {
      timingFailure ??= error;
    }
    let failure: unknown;
    let end: number | undefined;
    try {
      await action();
      await this.verifyReady();
      end = Date.now();
      for (const validate of this.validations.splice(0)) await validate();
      this.evidence.push({ operation: "collection verification", verified: true });
    } catch (error) {
      failure = error;
    } finally {
      this.collectionTiming = false;
      this.validations = [];
      if (waitObserverReady) {
        try {
          const waits = (await this.page.evaluate(
            `(() => {const data=window.__doodleCollectionWait;data.observer.disconnect();if(data.start!==null)data.intervals.push({reason:'user-wait',start:data.start,end:Date.now()});delete window.__doodleCollectionWait;return data.intervals;})()`,
          )) as Exclusion[];
          this.exclusions.push(...waits);
        } catch (error) {
          timingFailure ??= error;
        }
      }
      try {
        await recorder.stop(failure === undefined);
      } catch (error) {
        timingFailure ??= error;
        if (error instanceof CollectionDownloadFailed) failure ??= error;
      }
      if (timingFailure !== undefined) {
        this.evidence.push({
          operation: "collection timing",
          valid: false,
          reason: timingFailure instanceof Error ? timingFailure.message : String(timingFailure),
        });
        failure ??= new BenchmarkBlocked(
          "Collection timing unavailable; installation verification ran independently",
          { cause: timingFailure },
        );
      } else {
        this.phases.push(...recorder.phases);
        this.exclusions.push(...recorder.exclusions);
      }
    }
    if (
      (this.manifest?.collection?.warningsAsErrors ?? true) &&
      this.warnings.length > 0 &&
      (failure === undefined || failure instanceof BenchmarkBlocked)
    )
      failure = new CollectionDownloadFailed(
        "Collection warnings are treated as errors for this benchmark",
      );
    if (failure) throw failure;
    this.assert(end !== undefined, "No verified collection completion boundary");
    const excludedMs = excludedDuration(start, end, this.exclusions);
    this.measurements.push({
      name: "collection.total",
      wallMs: end - start,
      excludedMs,
      activeMs: end - start - excludedMs,
    });
    for (const phase of ["add", "download", "install", "deploy"] as const) {
      const begin = this.phases.find((e) => e.phase === phase && e.edge === "start");
      const finish = this.phases.find((e) => e.phase === phase && e.edge === "end");
      if (begin && finish) {
        const excluded = excludedDuration(begin.at, finish.at, this.exclusions);
        this.measurements.push({
          name: `collection.${phase}`,
          wallMs: finish.at - begin.at,
          excludedMs: excluded,
          activeMs: finish.at - begin.at - excluded,
        });
      }
    }
    if (this.warm)
      this.evidence.push({
        phase: "download",
        timing: null,
        reason: "archives already cached; no network member downloads observed",
      });
  }
  async purge(): Promise<void> {
    const { purgeGame } = await import("../src/deployment");
    await purgeGame(this.instance.mcp, { timeoutMs: this.timeoutMs });
    this.evidence.push({ operation: "purge completed" });
  }
  async deploy(): Promise<void> {
    const { deployMods, needsDeployment } = await import("../src/deployment");
    await deployMods(this.instance.mcp, this.gameId, { timeoutMs: this.timeoutMs });
    this.assert(
      !(await needsDeployment(this.instance.mcp, this.gameId)),
      "Vortex still has undeployed changes",
    );
    const validate = async () => {
      const deployed = await verifyDeployment(this.config.gamePath!, this.config.cacheDir);
      this.evidence.push({
        operation: "deploy",
        deployedFilesVerified: deployed,
        integrityValidation: "outside timed action window",
      });
    };
    if (this.measurementDepth > 0 || this.collectionTiming) this.validations.push(validate);
    else await validate();
  }
  async verifyReady(): Promise<void> {
    const ready = this.manifest?.collection?.ready;
    if (this.dataset === "real" && !ready)
      this.block("Define collection.ready: game-specific readiness observable required");
    if (ready) await this.waitFor(ready);
    if (this.dataset === "real") {
      if (!this.installedCollectionId)
        this.block("Install the genuine pinned collection before checking readiness");
      await this.verifyCollectionMembers(this.installedCollectionId);
      this.assert(
        this.collectionUiVerified,
        "Collection driver and visible UI completion have not been verified",
      );
    }
    const { needsDeployment, modsStillInstalling } = await import("../src/deployment");
    this.assert(
      (await modsStillInstalling(this.instance.mcp, this.gameId)).length === 0,
      "Install still running at ready boundary",
    );
    this.assert(
      !(await needsDeployment(this.instance.mcp, this.gameId)),
      "Deployment incomplete at ready boundary",
    );
    if (this.dataset === "real") {
      const validate = () => this.verifyInstalledStaging();
      if (this.measurementDepth > 0 || this.collectionTiming) this.validations.push(validate);
      else await validate();
    }
    this.evidence.push({
      operation: "ready checked",
      gameLaunch: "excluded",
      observable: ready ?? "all sandbox mods installed and no pending deployment",
    });
  }
  private async verifyInstalledStaging(): Promise<void> {
    const staging = await this.safeSelectorPath("installPathForGame");
    const records = await this.call<Record<string, { state?: string; installationPath?: string }>>(
      "vortex_query",
      { path: ["persistent", "mods", this.gameId] },
    );
    const installed = Object.entries(records ?? {}).filter(([, mod]) => mod.state === "installed");
    const failures: { modId: string; installationPath?: string; reason: string }[] = [];
    for (const [modId, mod] of installed) {
      try {
        const relative = mod.installationPath;
        if (
          typeof relative !== "string" ||
          relative.length === 0 ||
          path.isAbsolute(relative) ||
          path.win32.isAbsolute(relative) ||
          /^[a-z]:/i.test(relative) ||
          relative.split(/[\\/]/).includes("..")
        )
          throw new Error("Installed mod has no safe relative staging directory");
        const folder = path.resolve(staging, relative.replace(/[\\/]/g, path.sep));
        assertInside(staging, folder);
        if (!(await fs.promises.lstat(folder)).isDirectory())
          throw new Error("Installed mod staging path is not a directory");
      } catch (error) {
        failures.push({
          modId,
          installationPath: mod.installationPath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const verified = installed.length > 0 && failures.length === 0;
    this.evidence.push({
      operation: "installed staging verification",
      verified,
      installedRecords: installed.length,
      directoriesPresent: installed.length - failures.length,
      failures,
      scope:
        "Directory presence only; deployment verification separately compares manifest file bytes",
      integrityValidation: "outside timed action window",
    });
    this.assert(
      installed.length > 0,
      "No installed mod records available for staging verification",
    );
    this.assert(
      verified,
      `Installed staging verification failed for ${failures.length}/${installed.length} mod records; inspect evidence for paths`,
    );
  }
  async restartToMods(): Promise<void> {
    const definition = this.manifest?.tables?.mods ?? defaults.mods!;
    await this.openPage(definition.page);
    await this.handle.close();
    await this.instance.stop();
    if (this.instance.process.exitCode === null && this.instance.process.signalCode === null)
      throw new Error("Cannot restart before confirming Vortex exit");
    if (this.gameSettingsLease && this.instance.process.pid)
      removeInstancePid(this.gameSettingsLease.lease, this.instance.process.pid);
    const { launchVortex } = await import("../src/instance");
    let start: number | undefined;
    this.instance = await launchVortex({
      config: this.config,
      userDataDir: this.instance.userDataDir,
      onSpawn: (at) => {
        start = at;
      },
      onProcessSpawn: (child) => {
        this.spawnedProcesses.add(child);
        if (this.gameSettingsLease && child.pid)
          addInstancePid(this.gameSettingsLease.lease, child.pid);
      },
    });
    if (this.gameSettingsLease && this.instance.process.pid)
      addInstancePid(this.gameSettingsLease.lease, this.instance.process.pid);
    const { attachToRenderer } = await import("../src/cdp");
    this.handle = await attachToRenderer(this.config);
    await this.page
      .locator(definition.rows)
      .first()
      .waitFor({ state: "visible", timeout: this.timeoutMs });
    if (!definition.search) this.block("Mods usability requires a configured real search control");
    const search = this.page.locator(definition.search);
    if ((await search.count()) !== 1)
      this.block(`Missing Mods usability search input: ${definition.search}`);
    const before = await this.page.locator(definition.rows).allTextContents();
    this.assert(before.length >= 2, "Startup requires a populated Mods list");
    const token = crypto.randomUUID();
    await search.fill(token);
    await this.page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 0,
      definition.rows,
      { timeout: this.timeoutMs },
    );
    await search.fill("");
    await this.page
      .locator(definition.rows)
      .first()
      .waitFor({ state: "visible", timeout: this.timeoutMs });
    await this.page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    this.assert(start !== undefined, "Missing process launch timing signal");
    const wallMs = performance.now() - start;
    this.measurements.push({
      name: "startup.mods-usable",
      wallMs,
      excludedMs: 0,
      activeMs: wallMs,
    });
    this.evidence.push({
      operation: "startup usability",
      probe: "real search to no results then clear restores visible rows",
      rowsBefore: before.length,
    });
  }
  async memoryWhile<T>(action: () => Promise<T>): Promise<{ result: T; samplesMb: number[] }> {
    const samplesMb: number[] = [];
    let stopped = false;
    const sample = async () => {
      const mb = (await this.page.evaluate(
        `performance.memory ? performance.memory.usedJSHeapSize/1048576 : null`,
      )) as number | null;
      if (mb === null) this.block("Renderer heap memory not exposed by this released build");
      samplesMb.push(mb);
    };
    await sample();
    let pending: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      if (!stopped) pending = pending.then(sample);
    }, 250);
    try {
      return { result: await action(), samplesMb };
    } finally {
      stopped = true;
      clearInterval(timer);
      await pending;
      await sample();
      this.evidence.push({
        experiment: "optional renderer JS heap sampling; excludes main process and native memory",
        samplesMb,
      });
    }
  }
  async close(preserve = false): Promise<void> {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.closing = this.closeInside(preserve).finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
  private async closeInside(preserve: boolean): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.handle.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.instance.stop();
    } catch (error) {
      failures.push(error);
    }
    if (
      [...this.spawnedProcesses].some(
        (child) =>
          child !== this.instance.process && child.exitCode === null && child.signalCode === null,
      )
    ) {
      try {
        const { stopStaleInstance } = await import("../src/instance");
        await stopStaleInstance(this.config);
      } catch (error) {
        failures.push(error);
      }
    }
    if (
      [this.instance.process, ...this.spawnedProcesses].some(
        (child) => child.exitCode === null && child.signalCode === null,
      )
    )
      failures.push(new Error("Could not confirm Vortex exit"));
    else {
      if (this.gameSettingsLease) {
        try {
          if (this.instance.process.pid)
            removeInstancePid(this.gameSettingsLease.lease, this.instance.process.pid);
          for (const child of this.spawnedProcesses)
            if (child.pid) removeInstancePid(this.gameSettingsLease.lease, child.pid);
          this.gameSettingsLease.release();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        this.oauthCache?.finish();
      } catch (error) {
        failures.push(error);
      }
    }
    // Inspect after shutdown flushed the logs, before erasing any evidence.
    try {
      const { assertNoUnrecoverableErrors } = await import("../src/tests/appHealth");
      assertNoUnrecoverableErrors(this.config.cacheDir);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      const failure =
        failures.length === 1
          ? failures[0]
          : new AggregateError(
              failures,
              failures
                .map((error) => (error instanceof Error ? error.message : String(error)))
                .join("; "),
            );
      throw retainedFixtureError(failure, this.config.cacheDir);
    }
    if (!preserve) {
      const root = path.resolve(this.config.cacheDir);
      if (!path.basename(root).startsWith("doodlebot-benchmark-"))
        throw new Error("Refusing cleanup of non-benchmark directory");
      fs.rmSync(root, { recursive: true, force: true });
    }
    this.closed = true;
  }
}

export function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Refusing path outside disposable fixture: ${target}`);
  let candidate = path.resolve(target);
  while (candidate !== path.resolve(root)) {
    let info: fs.Stats | undefined;
    try {
      info = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info?.isSymbolicLink()) throw new Error(`Refusing linked fixture path: ${candidate}`);
    candidate = path.dirname(candidate);
  }
}
export function resolveArchivePath(downloads: string, localPath: string, cacheDir: string): string {
  assertInside(cacheDir, downloads);
  if (!localPath || /^[a-z]:/i.test(localPath) || /^[\\/]{2}/.test(localPath))
    throw new Error("Archive localPath must be relative to the private download cache");
  const relative = localPath.replace(/^[\\/]/, "").replace(/[\\/]/g, path.sep);
  const archive = path.resolve(downloads, relative);
  assertInside(downloads, archive);
  return archive;
}
export function assertCleanGameFixture(source: string): void {
  assertRegularPath(source);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory())
    throw new BenchmarkBlocked("Real gameFixture must be an existing game directory");
  const visit = (folder: string): void => {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      if (/^vortex\.deployment(?:\..+)?\.json$/i.test(item.name))
        throw new BenchmarkBlocked(
          "Real gameFixture contains a Vortex deployment manifest; provide a clean Steam game copy before benchmarking. The source fixture is untouched.",
        );
      if (item.isSymbolicLink())
        throw new BenchmarkBlocked(
          "Real gameFixture contains linked files; provide a clean regular game copy before benchmarking",
        );
      if (item.isDirectory()) visit(path.join(folder, item.name));
    }
  };
  visit(source);
}
async function hashDeploymentFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function verifyDeployment(gamePath: string, cacheDir: string): Promise<number> {
  assertInside(cacheDir, gamePath);
  let verified = 0;
  const visit = async (folder: string): Promise<void> => {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      assertInside(cacheDir, file);
      if (item.isDirectory()) await visit(file);
      else if (/^vortex\.deployment(\..+)?\.json$/i.test(item.name)) {
        const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as {
          targetPath: string;
          stagingPath: string;
          files: { target?: string; relPath: string; source: string }[];
        };
        for (const entry of manifest.files) {
          const target = path.resolve(manifest.targetPath, entry.target ?? "", entry.relPath);
          const source = path.resolve(manifest.stagingPath, entry.source, entry.relPath);
          assertInside(cacheDir, target);
          assertInside(cacheDir, source);
          const sourceHash = await hashDeploymentFile(source);
          if (sourceHash !== (await hashDeploymentFile(target)))
            throw new Error(`Deployment bytes differ: ${entry.relPath}`);
          verified++;
        }
      }
    }
  };
  await visit(gamePath);
  if (verified === 0) throw new Error("No deployed file bytes verified");
  return verified;
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
export async function createSession(options: SessionOptions): Promise<BenchmarkSession> {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "doodlebot-benchmark-"));
  let config: HarnessConfig | undefined;
  let instance: VortexInstance | undefined;
  let handle: RendererHandle | undefined;
  let oauthCache: OAuthCacheLease | undefined;
  let gameSettingsLease: HoldResult | undefined;
  let settingsBackup: Awaited<ReturnType<typeof resetGameSettings>> | undefined;
  let editionProof: ReturnType<typeof verifySkyrimEdition> | undefined;
  const spawnedProcesses = new Set<ChildProcess>();
  try {
    const { loadConfig, resolveTarget } = await import("../src/config");
    const { sandboxConfig } = await import("../src/sandbox");
    const { bootstrap } = await import("../src/bootstrap");
    const { authCacheFile } = await import("../src/instance");
    const target = resolveTarget({
      preferInstalled: true,
      exe: options.executable ?? options.manifest?.executable,
    });
    if (target.kind !== "installed")
      throw new BenchmarkBlocked("Benchmarks require a stock released Vortex installer build");
    const mcpPort = await freePort();
    let cdpPort = await freePort();
    while (cdpPort === mcpPort) cdpPort = await freePort();
    config = loadConfig({
      target,
      cacheDir,
      mcpPort,
      cdpPort,
      slot: 0,
      owner: `benchmark-${crypto.randomUUID()}`,
      apiKey: undefined,
      production: true,
      headless: false,
      artifactDir: path.resolve(options.outputDir ?? "harness/.artifacts/benchmarks"),
      gameId: "vortexaisandbox",
      gamePath: undefined,
    });
    const dataset = options.dataset ?? "synthetic";
    if (dataset === "real") {
      const collection = options.manifest?.collection;
      if (!collection || collection.allowGameFixtureCopy !== true)
        throw new BenchmarkBlocked(
          "Real collection requires pinned manifest, OAuth cache and allowGameFixtureCopy:true",
        );
      if (collection.dedicatedWindowsAccount !== true)
        throw new BenchmarkBlocked(
          "Real game benchmarks require collection.dedicatedWindowsAccount:true on a QA-only Windows account/test machine: stock Vortex Documents isolation is not guaranteed; game support may write that account's Documents and LocalAppData",
        );
      const { parseCollectionRef } = await import("../src/collections");
      const ref = parseCollectionRef(collection.url);
      if (
        ref.gameId !== collection.gameId ||
        !Number.isInteger(ref.revision) ||
        !ref.revision ||
        ref.revision < 1
      )
        throw new BenchmarkBlocked(
          "Real collection must pin a positive revision for the configured Vortex game ID",
        );
      if (!fs.existsSync(collection.gameFixture) || !fs.existsSync(collection.authCache))
        throw new BenchmarkBlocked(
          "Real collection requires existing read-only gameFixture and private authCache; complete Nexus browser OAuth setup first",
        );
      const fixture = path.join(cacheDir, "game");
      if (ref.slug === "qdurkx" && ref.gameId === "skyrimse" && !collection.skyrimEdition)
        throw new BenchmarkBlocked(
          "GTS must specify skyrimEdition:'base' or 'anniversary' and the matching optionalMods policy",
        );
      if (collection.skyrimEdition) {
        if (
          collection.gameId !== "skyrimse" ||
          collection.optionalMods !== (collection.skyrimEdition === "base" ? "skip" : "install")
        )
          throw new BenchmarkBlocked(
            "Skyrim edition and optionalMods policy disagree: base skips, Anniversary installs",
          );
        editionProof = verifySkyrimEdition(collection.gameFixture, collection.skyrimEdition);
      }
      assertCleanGameFixture(collection.gameFixture);
      if (options.cleanStart || fs.existsSync(gameSnapshotManifest(collection.gameFixture)))
        await verifyGameSnapshot(collection.gameFixture);
      fs.cpSync(collection.gameFixture, fixture, { recursive: true, dereference: true });
      if (options.cleanStart || fs.existsSync(gameSnapshotManifest(collection.gameFixture)))
        await verifyGameSnapshot(fixture, gameSnapshotManifest(collection.gameFixture));
      if (collection.skyrimEdition) verifySkyrimEdition(fixture, collection.skyrimEdition);
      config = { ...config, gameId: collection.gameId, gamePath: fixture };
      oauthCache = beginOAuthCache(collection.authCache, authCacheFile(config));
      if (!config.owner) throw new Error("Real benchmark session requires a named owner");
      gameSettingsLease = holdLease(gameSettingsResource(config.gameId), config.owner, {
        purpose: "real benchmark shared game settings",
      });
      if (options.cleanStart)
        settingsBackup = await resetGameSettings({
          gameId: config.gameId,
          owner: config.owner,
          dedicatedWindowsAccount: true,
          backupDir: path.join(config.artifactDir, "game-settings-backups"),
        });
    } else {
      if (options.cleanStart)
        throw new BenchmarkBlocked(
          "cleanStart requires a real collection and verified game snapshot",
        );
      config = sandboxConfig(config);
      fs.writeFileSync(authCacheFile(config), "null");
    }
    ({ instance } = await bootstrap(config, {
      fresh: true,
      preserveGameFixture: dataset === "real",
      onProcessSpawn: (child) => {
        spawnedProcesses.add(child);
        if (gameSettingsLease && child.pid) addInstancePid(gameSettingsLease.lease, child.pid);
      },
    }));
    if (gameSettingsLease && instance.process.pid)
      addInstancePid(gameSettingsLease.lease, instance.process.pid);
    const { attachToRenderer } = await import("../src/cdp");
    handle = await attachToRenderer(config);
    await instance.mcp.call("vortex_dispatch", { action: "setAutoDeployment", args: [false] });
    if (dataset === "real") {
      const { requireOAuth } = await import("../src/auth");
      try {
        await requireOAuth(instance.mcp);
      } catch (error) {
        throw new BenchmarkBlocked(
          "The copied private OAuth cache is not refreshable; complete Nexus OAuth setup before real collection installation",
          { cause: error },
        );
      }
      const active = await instance.mcp.call<string | null>("vortex_query", {
        selector: "activeGameId",
      });
      const discovered = await instance.mcp.call<{ path?: string } | null>("vortex_query", {
        path: ["settings", "gameMode", "discovered", config.gameId],
      });
      if (
        active !== config.gameId ||
        !discovered?.path ||
        path.resolve(discovered.path).toLowerCase() !== path.resolve(config.gamePath!).toLowerCase()
      )
        throw new BenchmarkBlocked(
          "Real collection requires the active managed game to be the private copied fixture",
        );
    }
    const session = new BenchmarkSession(
      config,
      instance,
      handle,
      options.manifest,
      dataset,
      oauthCache,
      gameSettingsLease,
      spawnedProcesses,
    );
    const status = await instance.mcp.call<Record<string, unknown>>("automation_status");
    session.evidence.push({
      runtime: status,
      binarySha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(target.executable))
        .digest("hex"),
      target: "released installer",
      startingState: "fresh disposable profile, one managed game",
      cleanRestart: options.cleanStart === true,
      gameSettingsBackup: settingsBackup,
      skyrimContent: editionProof,
      userGameFolders:
        dataset === "real"
          ? "dedicated QA account: game support may write Documents/LocalAppData; cleanStart resets only allowlisted settings after verified backup"
          : "anonymous fake game, no per-user game folders",
    });
    return session;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await instance?.stop().catch(() => undefined);
    if (config) {
      const { stopStaleInstance } = await import("../src/instance");
      try {
        await stopStaleInstance(config);
        if (
          [...spawnedProcesses].some(
            (child) => child.exitCode === null && child.signalCode === null,
          )
        )
          throw new Error(
            "Could not confirm every spawned benchmark Vortex exited; reservations retained",
          );
        oauthCache?.finish();
        if (gameSettingsLease) {
          if (instance?.process.pid)
            removeInstancePid(gameSettingsLease.lease, instance.process.pid);
          for (const child of spawnedProcesses)
            if (child.pid) removeInstancePid(gameSettingsLease.lease, child.pid);
          gameSettingsLease.release();
        }
      } catch (cleanupError) {
        throw retainedFixtureError(
          new AggregateError(
            [error, cleanupError],
            "Benchmark startup failed and private OAuth cache persistence could not complete; fixture and credential reservation preserved",
          ),
          cacheDir,
        );
      }
    }
    if (error instanceof BenchmarkBlocked)
      throw new BenchmarkBlocked(`${error.message}; fixture preserved at ${cacheDir}`, {
        cause: error,
      });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; fixture preserved at ${cacheDir}`,
      { cause: error },
    );
  }
}
export async function withVortex<T>(
  options: SessionOptions,
  run: (vortex: BenchmarkSession) => Promise<T>,
): Promise<T> {
  const session = await createSession(options);
  return runInSession(session, run);
}

export interface RestartCollectionOptions extends Omit<SessionOptions, "dataset" | "cleanStart"> {
  /** Optional previous owned session, after its benchmark work has settled. Retains its workspace. */
  previous?: BenchmarkSession;
}
/** Stop the previous owned session if supplied, then start a cold benchmark from a verified snapshot. */
export async function restartCollectionBenchmark<T>(
  options: RestartCollectionOptions,
  run: (vortex: BenchmarkSession) => Promise<T>,
): Promise<T> {
  const { previous, ...next } = options;
  await previous?.close(true);
  return withVortex({ ...next, dataset: "real", cleanStart: true }, async (vortex) => {
    const { maximizeDownloadThreads } = await import("../src/collections");
    vortex.evidence.push({
      operation: "download threads configured before cold benchmark",
      ...(await maximizeDownloadThreads(vortex.mcp)),
    });
    await vortex.prepareCollection({ cache: "cold" });
    return run(vortex);
  });
}
