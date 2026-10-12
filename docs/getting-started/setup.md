# Run a collection

After [getting started](first-session.md), use this guide to prepare and install a pinned Nexus collection. It uses real downloads and real game files, and can take hours.

## Before you start

- Use a **test machine or QA-only Windows account**. Game support can write Documents and AppData as well as the copied game.
- Sign in with **Nexus Premium**; the unattended runner requires it. A personal API key alone cannot authenticate collections.
- Finish the game's Steam installation and updates, close the game and launcher, and use a clean source with no deployed mods. For Skyrim Anniversary content, finish the game's own paid-content downloads first.
- Allow space for a clean game snapshot, a separate working copy, collection archives, staging and deployment. Collection files can be much larger than the game.

## Prepare once

```powershell
pnpm run setup
```

Choose **Prepare a real collection**. Select the collection, confirm the test-machine and clean-source questions, and choose the warning policy. Setup finds supported Steam games, offers a saved snapshot or copies the installed game, and opens an isolated Vortex for login. Complete the browser login when asked; an unambiguous saved login is reused. Credentials and machine paths stay in the private local cache.

A **snapshot** is a verified clean game copy that you can reuse. Each benchmark creates a separate **working copy** to modify. Setup leaves the Steam game and existing snapshots untouched and starts no collection downloads.

On the first Vortex start, expect an extra restart while it saves the private game path and initializes the managed profile and staging folder. Setup waits for activation and checks the copied game's path before continuing. Keep any setup failure report; the runner does not treat a registered path alone as a ready game.

| Choice | Content and install policy                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1     | [Immersive & Adult, revision 104](https://www.nexusmods.com/games/skyrimspecialedition/collections/xxsqm4/revisions/104); follow the curator's game requirements                            |
| C2     | [Gate to Sovngarde, revision 118](https://www.nexusmods.com/games/skyrimspecialedition/collections/qdurkx/revisions/118); base Skyrim with the four free Creations, skip optionals          |
| C2-AE  | The same GTS revision; complete paid Anniversary content, install optionals                                                                                                                 |
| C3     | [Constellations, revision 121](https://www.nexusmods.com/games/skyrimspecialedition/collections/9zfscf/revisions/121); paid content and a separately downgraded verified snapshot           |
| C5     | [Night City: Femme Fatale PLUS, revision 94](https://www.nexusmods.com/games/cyberpunk2077/collections/p0qfwm/revisions/94); Cyberpunk with its required content, including Phantom Liberty |

For both GTS cases, run setup once for C2 and once for C2-AE. It can copy both variants from a completed Anniversary installation: the base snapshot omits paid files. C3 requires you to prepare its downgrade separately; setup can register the verified copy but does not downgrade it. Check each pinned curator's version/access requirements before running.

## Run the install

Setup prints the command for your selection. For base GTS:

```powershell
pnpm run benchmark -- --exploratory --repeats=1 --timeout-minutes=360 --select=B1-C2
```

This downloads genuine collection members and installs them in a new game copy, with a six-hour operation deadline. The runner loads your saved paths, checks the account and game prerequisites, uses Premium's maximum download threads and saves reports under a new timestamped `harness/.artifacts/proposal-benchmarks` directory. Choose a timeout appropriate to your workload.

Open the collection group's `results.json`. A pass requires a fully installed collection, the selected required/optional members, native completion UI, deployment and configured game-file readiness. It does not test launching the game. With warnings allowed, a resolved download warning can coexist with a pass; strict warning policy fails on any warning. Unresolved members and incomplete installation fail. Doodlebot records errors and performs no recovery or hidden retries. [Read results](../testing/results.md) explains the report.

This first run is exploratory, without an approved performance budget. For repeated release comparisons, continue with [run benchmarks](../testing/benchmarks.md#compare-releases).

## Check or update saved setup

```powershell
pnpm run setup -- --status
pnpm run setup -- --status --verify
```

Status shows detected games, cached login presence, saved collection choices, snapshots and verification dates without opening Vortex or contacting Nexus. Cached credentials and a dated Premium observation do not guarantee current server access. The second command checks every snapshot's inventory and bytes.

If a snapshot is missing or altered, keep the failure evidence and run setup to select or copy another clean source. It never repairs a damaged copy silently. Saved choices live in the gitignored `harness/.cache/benchmark-setup.json`; keep this file and credentials out of shared source and reports.

Custom TypeScript cases can load the same choice with `preparedCollection("C2")`. [The collection reference](../reference/collections.md) covers that API, custom snapshots and explicit restart/pause controls.
