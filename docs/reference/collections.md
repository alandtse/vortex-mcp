# Collection setup

Use [guided setup](../getting-started/setup.md) for login and machine paths. Your code can then load a collection without repeating those details.

## preparedCollection

Import from `./benchmarks/setup`.

<!-- contract:proposal.setup:preparedCollection -->

```typescript
export function preparedCollection(code: CollectionCode, file = benchmarkSetupFile): RealCollection;
```

<!-- /contract -->

Returns saved configuration for C1, C2, C2-AE, C3 or C5. The catalog supplies game, revision, members and readiness files. Setup supplies snapshot, private login-cache location, QA acknowledgement and warning policy. Missing or inconsistent configuration throws. A real run rechecks files and account access; loading configuration does not prove readiness.

## prepareCollection

Import from `./benchmarks/setup`. This prepares files, not a collection installation.

<!-- contract:proposal.setup:prepareCollection -->

```typescript
export async function prepareCollection(options: PrepareCollectionOptions): Promise<RealCollection>;
```

<!-- /contract -->

<!-- contract:proposal.setup:PrepareCollectionOptions -->

```typescript
export interface PrepareCollectionOptions {
  code: CollectionCode;
  /** Required acknowledgement; setup never infers that a user's account is disposable. */
  dedicatedWindowsAccount: true;
  /** The operator confirms the source is clean and the game/launcher are closed. */
  cleanSource: true;
  authCache: string;
  owner: string;
  /** Copy this source into a new snapshot, even when an older snapshot is saved. */
  source?: string;
  /** Register an existing verified copy rather than copying the installed game. */
  snapshot?: string;
  warningsAsErrors?: boolean;
  setupFile?: string;
  snapshotRoot?: string;
}
```

<!-- /contract -->

Finds the Steam game when `source` is omitted, creates or reuses a verified snapshot, saves local choices and returns configuration. Use `snapshot` to register a verified copy. `cleanSource` and `dedicatedWindowsAccount` are operator acknowledgements. The CLI manages the private `authCache` and exclusive `owner` for you.

An explicit `source` always creates a new snapshot. Omit both `source` and `snapshot` to reuse a saved copy for that game/content, or discover and copy the installed game if none is saved. Choose either `source` or `snapshot`; passing both fails.

Creation rejects linked files, deployment manifests and existing destinations. Reuse checks every byte. A partial or altered copy fails; it is never silently repaired.

## createGameSnapshot and verifyGameSnapshot

Import from `./harness/benchmarks/index` for custom fixtures.

<!-- contract:benchmarks.gameFixtures:createGameSnapshot -->

```typescript
export async function createGameSnapshot(options: GameSnapshotOptions): Promise<GameSnapshot>;
```

<!-- /contract -->

<!-- contract:benchmarks.gameFixtures:GameSnapshotOptions -->

```typescript
export interface GameSnapshotOptions {
  /** A known clean installed game. Hashes prove integrity, not Steam provenance. */
  source: string;
  /** New directory, outside source. Neither existing snapshots nor sources are overwritten. */
  destination: string;
  /** Exact relative files to leave out, for example incomplete paid Creation downloads. */
  exclude?: readonly string[];
}
```

<!-- /contract -->

<!-- contract:benchmarks.gameFixtures:verifyGameSnapshot -->

```typescript
export async function verifyGameSnapshot(
  snapshot: string,
  manifestFile = gameSnapshotManifest(snapshot),
): Promise<GameSnapshot>;
```

<!-- /contract -->

`createGameSnapshot()` copies a known clean game into a new directory, hashes/checks every file, and returns the manifest stored beside the copy. It never overwrites source or existing snapshots. `verifyGameSnapshot()` returns the manifest after checking exact inventory and bytes. Changed, extra or missing files fail.

Matching hashes prove copy integrity, not a clean source or Steam provenance. Never cache a game with deployed mods.

## createSkyrimSnapshot

<!-- contract:benchmarks.skyrimEdition:createSkyrimSnapshot -->

```typescript
export async function createSkyrimSnapshot(options: SkyrimSnapshotOptions): Promise<GameSnapshot>;
```

<!-- /contract -->

<!-- contract:benchmarks.skyrimEdition:SkyrimSnapshotOptions -->

```typescript
export interface SkyrimSnapshotOptions {
  source: string;
  destination: string;
  edition: "base" | "anniversary";
}
```

<!-- /contract -->

`edition: "base"` keeps four free Creations and omits paid files. `"anniversary"` requires all 74 Creation plugins and nonempty main archives. Finish purchased-content downloads and close Skyrim first. Constellations also needs a separately prepared downgrade; this helper does not downgrade games.

## Installing and checking

In a real session, `addCollection()` installs once, `deploy()` deploys and `verifyReady()` checks configured files. B1–B5 supply the complete workflow, including native UI completion. [Run a collection](../getting-started/setup.md) covers preparation and install policy; [results](../testing/results.md) explains warnings and failure evidence.

Warm-cache preparation checks that every installed mod record has a regular staging directory before purging the prefill. `verifyReady()` performs the same check for real collections. Missing, linked or unsafe directories fail even when Vortex's counters and UI say the collection is complete. The evidence entry `installed staging verification` identifies affected records; the fixture is retained without repair or another install attempt.

Directory presence cannot prove that every installer output is correct. Deployment verification separately compares the file bytes listed in Vortex's deployment manifests. These checks run outside the timed action window, and a failure prevents the sample from being accepted.

Pause/resume belongs in explicit pause tests or operator controls. It cannot recover failed members. Ordinary automation performs no recovery.

## Restart a real collection from scratch

Close the game and finish or stop the previous benchmark first. Use a [prepared collection](../getting-started/setup.md) and a new output folder:

```typescript title="restart-collection.mts"
import fs from "node:fs";
import path from "node:path";
import { restartCollectionBenchmark } from "./harness/benchmarks/index";
import { exploratoryManifest } from "./benchmarks/config";
import { preparedCollection } from "./benchmarks/setup";

const machine = exploratoryManifest();
const outputDir = "harness/.artifacts/gts-clean-restart";
const manifest = {
  ...machine,
  profile: { ...machine.profile, account: "premium" as const },
  collection: preparedCollection("C2"),
};

await restartCollectionBenchmark({ manifest, outputDir }, async (vortex) => {
  await vortex.collectionMeasure(async () => {
    await vortex.addCollection();
    await vortex.deploy();
  });
  await vortex.verifyReady();
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "evidence.json"),
    JSON.stringify(
      {
        scope: "One exploratory cold install; no approved baseline",
        measurements: vortex.measurements,
        evidence: vortex.evidence,
      },
      null,
      2,
    ),
  );
});
```

After preparing C2 with setup, run `pnpm exec tsx restart-collection.mts`. C2's revision comes from the checked-in pin. This performs real Nexus downloads and installs the collection into a fresh copy of the real game; it can take hours and needs space for archives, staging and deployment.

The restart checks every snapshot file, creates a new Vortex profile with an empty download cache, and sets maximum download threads before the clock starts. Old modded game copies and failed-run evidence stay separate. It does not repair or overwrite the Steam installation. A dirty snapshot is rejected; make a fresh snapshot from a known clean installation instead.

On the QA account, Skyrim's INIs, their `.base`/`.baked` copies, `Plugins.txt` and `loadorder.txt` are backed up and checked before removal. Saves and `ContentCatalog.txt` stay in place. Cyberpunk's reset covers `UserSettings.json`. Other games need a reset adapter before a clean restart is supported. Backups remain in `outputDir/game-settings-backups`, with `backup.json` recording their original locations. They are private recovery files. The reset remains in effect after the run; to recover old settings, close Vortex and the game and copy the backed-up files to those recorded locations.

An existing session can be passed as `previous` after its work has settled; restart closes it and retains its workspace. Another running real benchmark for the same account/game blocks the restart. To reset settings for each real repeat in `runBenchmarks()`, add `cleanStart: true` to its options.

## Pause and resume downloads

While a real collection is installing, the session exposes `pauseDownloads()` and `resumeDownloads()`. For example, an application can call these from its Pause and Resume controls:

```typescript
import type { BenchmarkSession } from "./harness/benchmarks/index";

export async function pauseUntilResume(
  vortex: BenchmarkSession,
  waitForResume: () => Promise<void>,
): Promise<void> {
  const progress = await vortex.downloadProgress();
  console.log(progress.active, progress.paused, progress.finished, progress.receivedBytes);
  await vortex.pauseDownloads();
  // Returns after scheduling has stopped and no download bytes are growing.
  try {
    await waitForResume(); // Your application's Resume control.
  } finally {
    await vortex.resumeDownloads();
  }
}
```

An automated control can poll `downloadProgress()` until `active > 0` before testing Pause. `receivedBytes` counts the bytes reported by Vortex, including partial transfers; it is not an estimate of the final collection size.

Pause controls the exclusively owned benchmark profile's whole download queue. Resume starts the collection's own driver with the account's maximum download threads. It does not mean the collection has finished: keep awaiting the original `addCollection()` operation. A paused install still has its original timeout. Keep pause/resume outside timed baseline runs; this control does not silently subtract the pause from a measurement.

The restart promise also includes teardown checks. Treat the operation as successful only when that promise resolves. For failures before the callback, catch the returned promise and save its error message; the error includes the retained workspace location. Inside the callback, a `finally` block can save partial measurements and evidence if installation fails.

## Custom collection manifests

The supplied pins use `preparedCollection()`. For another collection/store, a directly written manifest must supply the pinned revision URL, game/engine, expected member count, private `authCache`, clean `gameFixture`, `allowGameFixtureCopy: true`, `dedicatedWindowsAccount: true` and a meaningful `ready` condition. The unattended runner still requires Premium and a test machine/account. File hashes prove copy integrity, not source cleanliness or Steam provenance.

Set `warningsAsErrors` explicitly when writing a manifest: the SDK defaults to strict warnings when omitted, while prepared collection choices use the policy saved by setup. Required and selected optional members must finish under either policy. A lower-level install using allowed warnings also needs its final completion-verification callback; member counts alone do not prove success.

For a login-only integration rather than a benchmark, the app CLI supports `pnpm run ai -- setup --installed --oauth` with a named `VORTEX_AI_OWNER`. Finish the browser login in its isolated Vortex and keep the same cache/instance settings for later commands. Normal collection work uses the single [collection guide](../getting-started/setup.md).
