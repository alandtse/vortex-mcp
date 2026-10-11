# doodlebot operating manual

doodlebot is an agentic development and testing tool for Vortex, the Nexus Mods mod manager. Its
Vortex extension is an MCP server exposing Vortex's state and UI; the harness (this directory,
CLI `doodlebot`, run as `pnpm run ai -- <command>`) launches isolated profiles of an unmodified
Vortex, drives them, captures evidence and runs Playwright checks. A source checkout is optional.

This is the AI operating manual. Human setup, tool use, LLM workflows, tests and benchmarks
are documented separately in [the human site](../docs/index.md). Update both audiences when
their shared behavior changes; `pnpm run docs:generate` refreshes their contract references,
and `pnpm run docs:check` enforces the mapping in `scripts/documentation-map.json`.

- [KNOWLEDGE-ROUTES.md](KNOWLEDGE-ROUTES.md): shared specialist reading paths and evidence rules.
- [KNOWLEDGE.md](../KNOWLEDGE.md): confirmed pitfalls; search the affected area and recheck its scope.
- [WORKFLOWS.md](WORKFLOWS.md): bug reproduction, features, designs, state and window-size
  matrices, several issues at once.
- [PULL-REQUESTS.md](PULL-REQUESTS.md): Vortex PR titles, description template, reviews.
- [AGENT-WORKFLOW.md](AGENT-WORKFLOW.md): canonical task routing, delegation and handoff.
- `.claude/skills/`: `drive-vortex`, `vortex-dev`, `vortex-ui-test`. Apply the relevant ones.
- [ARCHITECTURE.md](../ARCHITECTURE.md): where a new capability belongs.

When developing Vortex, **read and follow its own `AGENTS.md`, `CLAUDE.md` when present, its
documentation index and task-specific AI guidance before editing its source**.

## Initial setup

Windows, a Node version compatible with package.json, the pinned pnpm (`pnpm@9.15.0`), Git and an
installed Vortex. No game or Nexus account is needed for sandbox tests.

```powershell
$env:VORTEX_AI_OWNER = 'operator'
pnpm install --frozen-lockfile
pnpm run ai -- setup --installed --sandbox
pnpm run ai -- doctor --installed --sandbox
pnpm run ai -- snapshot
pnpm run ai:test
```

- `setup` builds the extension when missing and starts an isolated Vortex. `--sandbox` is a
  disposable game with a tiny game-support extension: real archive install, enable, deploy and
  purge, no playable game. `--no-game`: global UI only. A real game:
  `--game <id> --game-path <dir>` (a disposable copy). An invalid explicit path fails, never
  falling back to a real install; without one, common games are found through Steam.
- Use the **same target, game and cache flags on every command** for a profile. Persist regular
  choices in the gitignored `harness/.env`. `VORTEX_AI_INSTALLED=1` makes tests use the installed
  build even when a source checkout exists.
- The extension id is `doodlebot`; the old `vortex-mcp` plugin folder is removed from harness
  profiles automatically.
- On pnpm layout errors, compare `pnpm --version` with package.json before touching the lockfile.
  Vortex checkouts use their `packageManager` pnpm, via `pnpm dlx` when PATH differs (or
  `VORTEX_AI_PNPM`).
- A sandboxed agent may need host approval to launch processes or GUI apps. That is not an OAuth
  or Vortex setup step.

## Nexus login (OAuth): interact once, cache automatically

Local automation needs no account. Collections need OAuth: an API key alone can make `isLoggedIn`
true while collection downloads fail. Don't ask for an API key for local tests or builds.

```powershell
pnpm run ai -- setup --oauth --installed     # waits up to 10 min; --no-wait returns at once
pnpm run ai -- save-login --installed        # after a timeout or --no-wait, once logged in
pnpm run ai -- auth-status                   # presence booleans, never secrets
pnpm run ai -- login-import --cache-dir D:\other-cache [--from D:\bench-cache] [--force]
```

- setup clears any seeded API key in its isolated profile so Log in appears. **The account owner**
  clicks Log in and completes the browser flow (password, MFA, captcha); agents do the rest. It
  caches access and refresh credentials and checks a fresh restore still has them.
- `save-login` refuses an unsigned or API-key-only profile and one that cannot shut down cleanly.
- **Never put passwords, API keys or OAuth tokens in chat or committed files.** Cache directories
  hold credentials: keep them private (the default is gitignored).
- The login cache is per target (installed or source build), independent of game and API key.
  Fresh and rebuilt profiles inherit credentials, not mod lists or game paths. The extension writes
  `oauth-<target>.json` in harness mode only, on every token rotation; only a real logout writes a
  `null` tombstone. Vortex's forced-logout migration is handled (KNOWLEDGE.md).
- Credential presence does not prove Nexus still accepts them; a revoked login means repeating
  `setup --oauth`.
- A nondefault cache with no OAuth file can inherit the default cache's login automatically.
  A new cache is therefore not proof of anonymous execution; core fixtures write an explicit
  null OAuth tombstone. `login-import` copies the login from `harness/.cache` (or
  `--from`) for the target `--installed`/`--dev-dir` selects; it refuses a logged-out source and
  replaces a login only with `--force`. Copies then rotate apart; if Nexus refuses one, import
  again or repeat setup.
- Optional legacy key: `VORTEX_AI_NEXUS_API_KEY` in `harness/.env`.

## Run and reset

Real benchmark native lifecycle: `harness/benchmarks/index.ts` exports `createGameSnapshot`,
`verifyGameSnapshot`, `resetGameSettings`, and `restartCollectionBenchmark`. Restart requires a
versioned SHA256 snapshot, uses a fresh private profile/game/archive cache, backs up and resets
supported account settings, and configures maximum download threads before the cold install.
`runBenchmarks({cleanStart:true,...})` applies the same reset to real repeats. The `previous`
session option is only for settled benchmark work and preserves the prior workspace.
`BenchmarkSession.pauseDownloads()` verifies no active or growing transfer; `resumeDownloads()`
resumes the collection driver. These controls do not alter timing exclusions or installation timeouts.
`downloadProgress()` exposes actual queue counts and received bytes without archive URLs; finished
archives alone do not prove that collection installation/deployment completed.
Real `BenchmarkSession.addCollection()` additionally verifies the selected collection's stock
install driver reaches review with post-processing finished and its visible progress panel gone.
The collection coordinator keeps dialog/FOMOD automation alive through this boundary. A finished
driver with a persistent progress panel fails with retained UI evidence; an unobservable driver
blocks. Do not resume skipped optional members, hide the UI, or patch Vortex to obtain a pass.
The selected page must be visible and driver fields readable. Completed-driver render settling
has a 30-second grace inside the overall installation timeout; each add attempt resets verification.
The read-only `inspectCollectionCompletion` helper records driver state and panel counts.
`createSkyrimSnapshot({source,destination,edition})` prepares base or paid-AE snapshots from one clean Steam source, excludes paid files only from the base copy and refuses incomplete paid inventory before an AE copy. Steam is untouched.
GTS qdurkx revision 118 has two configurations: C2/base skips optional rules and rejects paid
Creation files; C2-AE/anniversary installs optionals and requires all 74 stock Creation plugins
and their main BSA archives. `gtsCollection(edition,paths)` selects the matching policy.
`skyrimEdition` and `optionalMods` must agree before launch. Both variants require a verified
clean snapshot, UI completion and deployed bytes; selected optionals must be installed and enabled.
The coordinator persists optional rules with stock `addModRule` before starting the driver,
reapplies the choice if released Vortex regenerates that exact pinned manifest's rules, and
keeps its finish-dialog policy consistent through both passes. `collection_status.optionalSelected`
counts explicit `ignored:false` rules; absent flags do not prove the AE choice. Never ignore
required members; changed member counts or collection identity fail the run.
Collection startup validates the exact driver, reads active dialog text, and clicks Install Now
through scoped dialog snapshots. Check physical container and enabled-button uniqueness before
the click, then re-snapshot the selected container because scanning invalidates earlier refs.
Recheck exact driver ownership, query step and finished preparation after that scan and before
the action; the client UI lock does not prevent Vortex's native driver from changing.
Full-page trees can truncate before the footer on large Mods
pages. Missing/ambiguous collection-added dialogs and failed clicks fail the attempt; no action
retry or driver recovery is performed. `collectionStartup.test.ts` exercises this wiring with the
real UI helpers, including a stacked unrelated dialog and a truncated root snapshot.
Collection timing uses `watch_state_changes` scalar deltas, not whole state snapshots. It preserves
all changed member IDs, ignores byte-progress churn, drains up to four pages of 128 entries per
listener each cycle and drains remaining pages at stop. Sequence gaps, subscription failures and
projection errors invalidate timings without aborting install verification. No invalid/partial
phase timings are published; the benchmark is blocked unless an install error makes it failed.

The shared game-settings lease tracks each cold/live child at spawn and stays protected on failed
shutdown. Independent same-owner resets are excluded by operation guards; reset refuses live Vortex.
Human procedure and recovery: [clean restart](../docs/testing/benchmarks.md#restart-a-real-collection-from-scratch).
Snapshots establish file integrity, not arbitrary source provenance. Supply a known clean game,
close the game first, preserve saves/purchased catalogs, and never reset the Steam installation.

```powershell
pnpm run ai -- up --installed --sandbox
pnpm run ai -- down
pnpm run ai -- up --installed --sandbox --fresh
pnpm run ai -- up --installed --sandbox --rebuild-snapshot
```

| Start                | Behavior                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| Cold                 | Blank/cached-login profile, manage the game, quit cleanly, snapshot, launch |
| Warm                 | Reopen the working profile with its mods and settings                       |
| `--fresh`            | Replace the working profile with its baseline snapshot                      |
| `--rebuild-snapshot` | Recreate the baseline, keeping the login cache                              |

- Each target, game, path and `--no-game` has its own baseline; an unrelated working profile is
  never reused. The harness never edits Vortex's state database.
- `--sandbox` and `--bethesda-sandbox` don't seed the `.env` API key (with one, each local install
  waits on a 60 s Nexus lookup); `--with-api-key` does. The choice is part of the snapshot key, so
  keep it consistent.
- `up` returns once Vortex answers; Vortex runs detached (stdio in `<cache>/live/vortex-stdio.log`,
  its log in `userData/vortex.log`).
- `down` waits for a clean shutdown. An unresponsive instance is reported and left intact, never
  killed and certified; close that window and retry. A server of another cache is never stopped
  for holding the same port.
- For another instance take a slot (next section), not a hand-picked `--cache-dir`, `--port`
  and `--cdp-port`.

## Parallel sessions: a worktree and a slot per agent

Human preparation is available through `pnpm run setup` (`benchmarks/setup-cli.mts`). It creates a local example or prepares a pinned collection, discovers Steam games, reuses a saved kit login when unambiguous, and tracks verified game snapshots in gitignored `harness/.cache/benchmark-setup.json`. `--status` is read-only/offline; cached credentials and dated Premium observations do not prove current refresh/download access. `--status --verify` checks all tracked bytes. Constellations still requires a separately prepared downgrade. Guided real setup requires explicit clean-source and QA-only Windows/test-machine acknowledgements. The catalog loads these local choices; `--exploratory` supplies observed host facts without approving budgets, and `--timeout-minutes` gives a deliberate operation timeout. Setup starts no collection downloads and retains incomplete copies. Normal automation still performs no retries or recovery.

Each doodlebot session works in its own worktree and slot, so their Vortex instances coexist, and
changes the kit only under the kit lock (WORKFLOWS.md, "Several agents at once").

```powershell
pnpm run ai -- worktree add fix-a --owner fix-a --base upstream/master   # .vortex-worktrees/fix-a, installed and built
pnpm run ai -- up --owner fix-a --worktree fix-a --slot auto --bethesda-sandbox
pnpm run ai -- slots                                       # who has which slot, and whether it runs
pnpm run ai -- down --owner fix-a --slot auto
pnpm run ai -- worktree list
pnpm run ai -- worktree remove fix-a --owner fix-a         # the branch stays
```

- **Slots** (`slots.ts`). Slot 0 is `harness/.cache` and `harness/.artifacts` on MCP 3701 and CDP
  9222, the default. Slot n (1–19) is `harness/.slots/<n>/cache` and `…/artifacts` on 3701+10n and
  9222+10n, with its own instance lease. `--slot auto` (or `VORTEX_AI_SLOT=auto`; needs an owner)
  gives the owner a slot of its own, recorded in `<lease dir>/slots.json` and reused later; when all
  19 are given out, the least recently used idle one. `--slot <n>` picks one. Explicit
  `--cache-dir`, `--port` or `--cdp-port` win over the slot.
- **Pass the same `--owner` and `--slot` to every command.** `ai:test:*` scripts read
  `VORTEX_AI_SLOT` and `VORTEX_AI_OWNER`; `script` passes its instance on.
- A slot's first `up` copies slot 0's OAuth login; the copies then refresh separately. If Nexus
  refuses one, `login-import --slot <n> --force`.
- **Worktrees** (`worktree.ts`) of `.vortex-src` share its object store. `add` fetches the base
  (default `upstream/master`), creates `--branch` (default the name) or checks out an existing one,
  then installs and builds with the pinned pnpm (`--no-install`, `--no-build`).
  `--worktree <name>` on a command selects that checkout as `--dev-dir`.
  `worktree add <name> --owner <worker> --ref origin/<branch>` makes a detached review
  checkout. `remove` refuses while the checkout is owned/live, or dirty unless `--force`.
  Reuse a suitable owned checkout instead of provisioning one for each read-only specialist.
- Shared by all: `dist/` (rebuilt by whoever changes the extension, under the kit lock), the pnpm
  store, the CPU. Don't take timings while other slots are busy (`slots`).
- **The kit lock** (`kit lock --owner <you> [--wait <min>]`, `kit sync`, `kit push`, `kit unlock --acquisition <id>`,
  `kit status`): one session at a time edits and pushes this repo. `kit push` rebases `main` onto
  `origin/main`, refusing without the lock, with uncommitted changes or off `main`. If rebase
  changes the checked head, it stops before push for revalidation. `kit status --json` gives
  the acquisition ID; renew it with `kit renew --owner <you> --acquisition <id> --ttl 30`
  before expiry. Save the original acquisition ID for unlock; ordinary release checks it
  atomically and cannot clear a same-owner successor. `kit unlock --force` is explicit inspected
  recovery; it still refuses live operations and a dirty kit. Expired/replaced acquisitions
  require inspection, not silent reacquisition.
- `vortex-e2e` has an E2E operation guard as well as the checkout guard. Overlapping runs
  refuse; retry the root invocation after the prior run ends.
- `pnpm run ai:test:parallel-sessions -- [--a <checkout>] [--b <checkout>]` checks two sessions side
  by side: own ports, profile and lease, isolated installs, clean stop.

## The instance lease: one agent drives each Vortex

A lease per instance in `~/.vortex-ai/leases` (shared by every kit checkout; `VORTEX_AI_LEASE_DIR`
overrides) says who drives it. Owner: `--owner`, else `VORTEX_AI_OWNER`; supported live and
provisioning operations reject anonymous owners. Use a distinct owner per active worker.
Operation guards exclude independent commands even with the same owner. Explicit execution
contexts compose nested commands; never share one among concurrent workers. Snapshots are
guarded because they invalidate UI refs. Watchers guard each complete build/copy/reload cycle,
allowing commands between cycles. Raw MCP/CDP clients remain outside harness ownership enforcement.

```powershell
pnpm run ai -- lease status                     # live/stale ownership and operation guards
pnpm run ai -- lease acquire --owner qa --slot auto --purpose "PR QA" --ttl 120 --checkout C:/dev/vx-ab
pnpm run ai -- up --owner qa --slot auto --dev-dir C:/dev/vx-ab --sandbox
pnpm run ai -- down --owner qa --slot auto --dev-dir C:/dev/vx-ab
pnpm run ai -- lease release --owner qa         # keeps ownership if an app still runs
pnpm run ai -- evidence run --owner qa --checkout C:/dev/vx-ab --base <base-sha> --out <new-report.json> -- pnpm run verify
```

- `up`, `bootstrap`, `setup`, `save-login`, `down`, `e2e`, `vortex-e2e`, `ai:test` (whole run) and
  `ai:test:*` take it implicitly: free or stale, taken; same owner, joined; another live owner,
  **refused before anything stops**, naming the holder and how to wait.
- `up` leaves it held by the running Vortex until `down` or exit.
- `lease acquire` lasts `--ttl` minutes (default 60, `0` none) or, with `--pid <n>`, that process's
  life. Re-acquire to renew. `--checkout <dir>` also takes that checkout's lock, all or nothing;
  `--checkout-only` just the checkout.
- `lease release --owner <name>` releases all that owner holds; `--checkout <dir>` only that one. A
  live instance and its checkout stay owned until confirmed exit; ordinary release cannot expose
  a running app to another owner.
- `lease run [flags] [--] <cmd...>` holds the lease for the command, passes `VORTEX_AI_OWNER`,
  waits for known child exit before releasing operation holds and returning its exit code.
  Flags go first (PowerShell 5.1 strips `--`). It uses the caller's `INIT_CWD`; `--checkout`
  reserves that path but does not change the command directory. Prefer `evidence run` for
  checkout checks: it chooses an explicit cwd and refuses a live app using the checkout.
  Arbitrary shell commands remain responsible for their declared resources and side effects.
- `--wait <minutes>` on lease commands retries a root acquisition after releasing partial holds.
  Nested operations and a script already inside a live operation refuse contention immediately.
- Stale: every implicit holding process exited, or an idle explicit reservation expired. An active
  launcher or running Vortex keeps its ownership even after reservation expiry. App PID registration
  and cleanup use the acquisitions captured at launch. Known children retain protection
  until confirmed exit. Inspect surviving/uncertain descendants before recovery.
- `lease release --force` clears the instance lease; `--owner <name> --force` all of an owner's.
  Use only for explicitly authorized recovery after checking the holder and known children
  have exited and inspecting the preserved state. Do not bypass a live worker's ownership.
- Obsolete or corrupt lease records fail closed, including older records without an acquisition
  ID. Inspect the exact named record and its recorded live processes, then have their owner stop
  them before any narrowly scoped manual repair or removal. Never wipe the lease directory or
  silently migrate an active session.
- Checkout locks (`checkout:<path>`): `pr-preflight`'s revert check, `vortex-e2e`'s patch, `build`,
  and every launch from `--dev-dir`, `--worktree` or `.vortex-src` (held until that Vortex exits).
  `script` and `ai:test:*` take the checkout recorded in `<cache>/instance.json`.
- Liveness is a PID check, so a reused PID can keep a dead lease looking live. The lease cannot stop
  a process that ignores it.

## Drive from any agent or shell

`up` prints the Streamable HTTP MCP endpoint, bearer token and a client example. Every tool is also
callable from the CLI.

```powershell
pnpm run ai -- tools --json                              # live tools and input schemas
pnpm run ai -- snapshot [--selector <css>]
pnpm run ai -- click --ref <ref>                         # or --selector <css>
pnpm run ai -- fill --ref <ref> --value example
pnpm run ai -- press --key Escape
pnpm run ai -- call vortex_query --args-file query.json  # or --args <json>
pnpm run ai -- screenshot --label before [--full-page]
```

`--args-file` avoids shell quoting (a PowerShell BOM is fine); keep credential-bearing ones private.

The loop is snapshot, act, wait, inspect. Refs expire on the next snapshot, reload or element
removal: never reuse one. Filter or scroll virtualized rows into the DOM first. Check
`activeDialogs` when an action seems blocked. Independent clients must coordinate UI actions.

| Tool/path                                                  | Use                                                                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ui_snapshot`                                              | Tree, accessible names, refs, active dialogs; selector/index scope                                                                     |
| `ui_active_dialogs`                                        | Open dialogs only; cheap to poll                                                                                                       |
| `ui_click`, `ui_fill`                                      | Mouse sequence, React-compatible input                                                                                                 |
| `ui_press_key`                                             | DOM key handlers; not native dialogs or text insertion                                                                                 |
| `ui_select_option`                                         | Native select; custom dropdowns need click-then-click                                                                                  |
| `ui_scroll`                                                | Scroll plus events for virtualized lists; not a native wheel                                                                           |
| `ui_wait_for`                                              | Poll selector/text; check `matched`, a timeout returns false                                                                           |
| `ui_hover` / harness `realHover()`                         | JavaScript hover only / real CDP mouse including `:hover`                                                                              |
| harness `realWheel(config, selector, deltaY, { control })` | Native wheel, optionally with Control                                                                                                  |
| `ui_get_viewport`, `ui_set_viewport`                       | Read/resize window and renderer                                                                                                        |
| `ui_detect_layout_issues`, `ui_responsive_sweep`           | Advisory layout findings                                                                                                               |
| `ui_read_console`                                          | Renderer console/errors since a sequence number                                                                                        |
| `nexus_auth_status`                                        | Credential-presence booleans                                                                                                           |
| `automation_status`                                        | Profile paths, renderer lifetime ID, NODE_ENV, `react.build`. The profile is `userDataDir`; Vortex's log is `<userDataDir>/vortex.log` |
| `collection_install_state`                                 | Collection install driver, session and dialogs (below)                                                                                 |
| `vortex_query`, `vortex_dispatch`                          | Inspect state, invoke documented actions/events                                                                                        |

Harness `clickByName`/`fillByName` match exact case-insensitive names (or explicit regexes) and
reject ambiguity; use accessible names and scope modals to their dialog. `{ selector, index? }`
scopes the snapshot so a large table can't exhaust its node budget. Avoid native file pickers:
`install <archive>` or a documented event.

### Scratch scripts and renderer diagnostics

`doodlebot script <file.mts> [args...]` runs a scratch script with the kit's tsx under the instance
lease, with the instance's cache, ports and token in its environment. `--owner`, `--wait` and the
instance flags (`--slot`, `--worktree`, `--dev-dir`, `--cache-dir`, ports) are the kit's anywhere; other arguments, and all after `--`, are the script's. Outside this repo use
`.mts` (top-level `await`) and import the kit by the URL in `VORTEX_AI_KIT`:

A script's own path: use `fileURLToPath(import.meta.url)`. `new URL(import.meta.url).pathname`
keeps `%20` for the space in "Vortex MCP", and writes beside it fail.

```ts
const kit: typeof import("file:///C:/dev/doodlebot/harness/src/kit.ts") = await import(
  process.env.VORTEX_AI_KIT!
);
const mcp = kit.clientFor(kit.loadConfig());
```

`page.evaluate` with named inner functions works (`NAME_SHIM` in `cdp.ts`). A useful script
becomes a harness module with a test.

`doodlebot eval --expr "<expression>"` (or `eval <file.js>`) evaluates JavaScript in the renderer
over CDP and prints JSON; promises are awaited. Diagnostics only. It refuses unless MCP and CDP both
report a profile in this cache, so it never touches the operator's Vortex.

### Recording a feature

Standalone `doodlebot record --ffmpeg <exe> --seconds <1-60> --label <name>` records the
renderer while a human drives it, holding the live operation throughout. For automated actions,
run `kit.recording.startRecording(config, { encoder, label })`, the UI actions and
`recording.stop()` in one guarded `doodlebot script`; stop recording in `finally`.
A second independent CLI session cannot drive that instance during recording.
The encoder needs MJPEG in and
VP8/WebM out (`pnpm exec playwright install ffmpeg`). Frames repeat, so pauses keep their length;
keep durations when converting. For PR media, `gh pr edit --attach <file>` (GitHub CLI 2.99+)
uploads files that `--body-file` image references name (push access, under 10 MB).

## Install and deploy

```powershell
pnpm run ai -- install C:/fixtures/example.zip
pnpm run ai -- collection <collection-url>
pnpm run ai -- deploy --game <active-game-id> [--purge]
pnpm run ai -- purge
pnpm run ai -- e2e <collection-url> [--runs <n>] [--keep] [--purge] [--no-launch]
```

- `slow-download [--count <n>] [--seconds <n>] [--stagger <s>]` keeps real downloads in flight
  (throttled local files, no network or account) for work on the UI that reports them: the
  spine's download button and panel, the Downloads page. It returns when they finish, so run it
  it with the UI actions inside one guarded `script` using `kit.slowDownload` when automation
  needs to observe downloads in flight. `--stagger` starts each after the one before, so a UI
  that announces arrivals sees them separately.
- `install` waits for the installer; `collection` checks OAuth first and waits for required
  members. FOMODs take defaults; unexpected dialogs stay visible. Add a scoped helper with a test
  when a workflow needs an answer, never a global guess.
- `deploy` refuses while installing or when install state is unreadable. Foreign-instance purge
  prompts are cancelled unless `--purge`. **Use disposable game paths for destructive tests**: a
  moved profile does not isolate writes to a real game's folder or configuration.
- `e2e` also verifies completion, deployment and a newly observed game process, so it needs the
  real game and network; `--no-launch` with a disposable path stops before launch. The sandbox
  executable is never evidence of a game launch.

## Tests and development

```powershell
pnpm run ci         # typecheck, lint, format, unit tests, build; no Vortex
pnpm run ai:test:core # Playwright contract against a real Vortex, account-free (ai:test alias)
pnpm run ai:test:oauth # opt-in: cached sandbox OAuth survives a fresh restore
pnpm run ai -- responsive --screenshots --viewports "1024x720,1280x720,1280x1000,1920x1080" [--strict]
```

- Say which suite ran and disclose skips. Quote comma lists in PowerShell.
- See [TESTING.md](TESTING.md) for the core contract, pinned-release CI and opt-in scenarios.
  Feature regressions and performance scripts stay outside the default kit gate.
- Responsive checks: each relevant state with its own label, width and height, real sizes after OS
  clamping, and a visual review against any design (WORKFLOWS.md has the state matrix).
- `pnpm run ai:source` prepares the managed base `.vortex-src` (`--update`, `--no-build`,
  `--where`); create or reuse a worker worktree before editing. `up` defaults to the managed
  source when present. Select `--installed`, `--exe <path>`, `--dev-dir <path>` or
  `--worktree <name>` explicitly for reproducible checks.
- Extension work uses one watcher: `pnpm run ai:watch -- --owner <you> --slot auto` or
  `pnpm run dev -- --owner <you> --slot auto`, against your already-running instance.
  It observes doodlebot source and runs finite build/copy/reload cycles, retaining pending
  edits through contention and allowing other commands between cycles. Build failure never
  installs partial output. It does not build Vortex source. `pnpm run build` is one-shot;
  `build-extension` or `up --rebuild-extension` forces a build. Recheck `tools --json` after
  tool registration changes. Do not start a watcher inside an inherited long-lived operation.
- Live CLI attachment and every watch cycle check `automation_status.userDataDir` against the
  exact canonical live profile; a reachable port or changed runtime ID is insufficient.
- Extension builds compile captured source, configuration, package/lock and `info.json` bytes
  in a private directory under `harness/.artifacts`, using the installed dependencies. Only a
  successful, uncancelled build whose inputs still match can replace `dist`. Freshness checks
  validate input/output digests, including metadata, additions and deletions; timestamps are
  insufficient. Failed builds retain the previous generation, which may now be stale.
- Extension publication and profile installation stage a complete generation and use a
  backup/swap with rollback. A failed rollback reports and retains its recovery backup;
  inspect that path before retrying. An interrupted rename sequence may also need manual
  recovery; this is not a crash-atomic filesystem transaction. The current capture covers
  `src` production files and the fixed root build configs, package, lock and metadata, with
  Node/platform/architecture/`NODE_ENV` identity. Provision pinned dependencies under the kit
  lock. New external config inputs, environment dependencies or symlinks need an explicit
  capture-contract change; dependency integrity is not proved by the generation marker.
- `ai:test:nexus` (opt-in; same target, cache and ports as account setup): a separate
  `nexus-smoke` profile and disposable Stardew Valley folder, the five required members of
  revision 1 of `stardewvalley/nudx7b`, SHA-256 checks of deployed files, purge, evidence,
  refreshed credentials copied back. No launch. Needs Nexus Premium for unattended downloads.
  Outages are failures, not a reason to repeat OAuth.

### Recorded checks and readiness

`evidence identity` captures the current subject checkout/diff and kit identity separately.
`evidence runtime` hashes the actual executable and selected build files; list the executable
first, then the app bundle and doodlebot extension bundle. A source runtime also needs
`--checkout` and `--base`. These commands inspect files; they do not build or select an app.
Use `pnpm --silent run ai` when redirecting JSON so pnpm's command banner is omitted.

```powershell
pnpm --silent run ai -- evidence identity --checkout . --base <base-sha> > harness/.artifacts/identity.json
pnpm run ai -- evidence run --owner <you> --checkout . --base <base-sha> --out harness/.artifacts/ci.json -- pnpm run ci
pnpm run ai -- evidence run --owner <you> --checkout . --base <base-sha> --out harness/.artifacts/scoped.json --test-format vitest --test-report <new-test-report.json> -- pnpm exec vitest run <test-files> --reporter=json --outputFile <new-test-report.json>
```

`evidence run` executes an explicit command in the subject root, or a contained `--cwd`,
using the subject's already-installed pinned pnpm. It never installs a toolchain. It guards
the checkout, refuses an app running from it, records the actual executable/arguments/cwd,
retains output and captures before/after source identity. Choose new output/report paths
for every run; existing evidence is never overwritten. A valid failed/interrupted receipt
remains failed evidence. If reporter JSON is missing or malformed, receipt collection fails;
retain the saved `.log` and report that collection failure instead of claiming a valid receipt. Keep artifacts in ignored task storage so creating a report does not itself
change the subject diff.

For released-app core evidence, create a runtime JSON with `--kind installed`, a release
`--label` and `--mode production`, including the actual Vortex executable, app bundle and
`dist/index.js`. Use an isolated owner/slot; the collector sets the selected executable and
target from that runtime identity. Set `PLAYWRIGHT_JSON_OUTPUT_FILE` to a new absolute path,
pass the same path as `--test-report` with `--test-format playwright`, and run
`pnpm run ai:test:core --reporter=json` through `evidence run --runtime <runtime.json>`.
Core evidence must include the complete unfiltered suite with no skips.

For example, in PowerShell 7, from the kit root (replace paths/version with the actual runtime):

```powershell
$env:VORTEX_AI_OWNER = 'task-validation'
$env:VORTEX_AI_SLOT = 'auto'
pnpm --silent run ai -- evidence runtime --kind installed --label <actual-version> --mode production C:/Vortex/Vortex.exe C:/Vortex/resources/app.asar dist/index.js > harness/.artifacts/runtime.json
$env:PLAYWRIGHT_JSON_OUTPUT_FILE = Join-Path (Get-Location) 'harness/.artifacts/core-tests.json'
pnpm run ai -- evidence run --owner task-validation --checkout . --base <base-sha> --out harness/.artifacts/core.json --runtime harness/.artifacts/runtime.json --test-format playwright --test-report $env:PLAYWRIGHT_JSON_OUTPUT_FILE -- pnpm run ai:test:core --reporter=json
(Get-FileHash -Algorithm SHA256 harness/.artifacts/core.json).Hash.ToLowerInvariant()
```

Use the absolute resolved file path and that hash in its artifact reference. Hash the
independent review file the same way. Keep the identity JSON from the same unchanged revision.

Copy [readiness.example.json](readiness.example.json), replace its placeholders with generated
identities/artifact hashes and actual reviewed evidence, and choose the correct target, task
and affected contracts. That example is documentation-only; executable changes need additional
roles such as scoped tests, control and runtime checks. The schema in `src/readiness.ts`
defines all roles. Every artifact reference contains an absolute path and its SHA-256.
The independent reviewer inspects gate applicability against the actual diff.

```powershell
pnpm run ai -- readiness --manifest <task-manifest.json> --json
```

Readiness uses schema **v2**; command receipts use **v1**, preflight and upstream E2E reports
use **v4**, including producing kit identities before and after execution. Current and baseline
native reports must use the manifest's unchanged kit code. Obsolete formats must be rerun.
Scoped and control test receipts require nonempty execution with zero failures and zero skips
or TODO tests; a failed baseline control still requires nonempty execution with zero omissions.
Native assertion controls embed the exact Vitest JSON and its digest for every branch and
reverted test group. Both sides must have complete, consistent execution; the branch passes
and the reverted run must contain an actual failed assertion. Incomplete branch runs prevent
mutation, and incomplete reverted runs fail after restoring the exact branch bytes. Their
reporter bytes and output remain in the native report for diagnosis.
Every performance series receipt needs a concrete production runtime; current runs must match
the manifest runtime. Historical baseline receipts retain the runtime hashes and source identity
verified during their execution, including the unchanged-runtime check; later sequential builds
may replace those files or advance that checkout. Readiness does not require retaining the old
build or compare it with current built bytes. Vortex app/performance source runtimes must match
the corresponding subject head, base and local-change identity. An equivalent separate checkout is allowed; a released app
cannot establish behavior introduced by modified Vortex source.
The evaluator checks current identities, artifacts,
required evidence, controls and E2E comparisons. Its result is an evidence-complete handoff,
not permission to publish, merge or release. Semantic correctness, meaningful independent
review and the correspondence between source and built runtime still require inspection.
A local-diff result cannot certify a later commit.

### Pull request checks

- `pnpm run ai -- pr-checks <number-or-url> [--repo <owner/name>] [--json]`: the PR head's checks
  via `gh`, failed jobs expanded to failed steps (a test failure vs. a failed upload). Nonzero while
  any check is pending or failed.
- `pnpm run ai:preflight` (= `pr-preflight`) before pushing; put its report in the PR. It diffs
  the committed `HEAD` of `--checkout` (default `.vortex-src`) against its merge-base with `--base`
  (default `upstream/master`), prints PASS/WARN/FAIL/SKIP per check with file:line, exits 1 on any
  FAIL or INCONCLUSIVE. `--json` lists every hit. Pass a named `--owner`; the operation guard
  excludes concurrent checks, including the same owner's independent commands.

| Check                    | Result                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Size                     | WARN over 400 changed lines or 10 files, excluding lockfiles, `etc/*.api.md`, snapshots, build output                                                                    |
| Callers outside the diff | WARN list: uses outside the diff's hunks of each touched export, class member, class/component (default imports, barrels) and private helper (one level up); tests apart |
| Readers of changed state | WARN: readers of each class field whose assignment changed, and of its getters                                                                                           |
| Dispatchers of reducers  | WARN: each changed reducer's action creator, its calls and type-string uses                                                                                              |
| Revert check             | Branch failure or a reverted pass is FAIL; a reverted failure is INCONCLUSIVE until its intended assertion is inspected                                                  |
| Measurements in comments | WARN for timing or size figures in added comments                                                                                                                        |
| PR description           | With `--pr <n>`: FAIL on a non-Conventional or >72-char title, missing section, "Not run", no head sha                                                                   |

- Test code (`*.test.*`, `*.spec.*`, `__tests__`, `__mocks__`, `__fixtures__`, `test-utils`) is
  never reverted or counted as a caller.
- Revert check: `pnpm exec vitest run` on `--test <path>` (repeatable) or the tests the diff
  touches, from each test's nearest `package.json` (`--project-dir` overrides). `--revert <path>`
  reverts only those files; `--revert-hunk <file>:<line>` only the hunk holding that head line.
  It is the only check that writes: it refuses uncommitted changes, backs up, restores exact bytes
  after handled cancellation and confirmed child exit, then verifies hashes and `git status`.
  A forcibly terminated wrapper requires inspection before recovery. `--skip-revert` skips it;
  `--head <ref>` checks a ref without checkout (and without the revert check).
- Discovery is regex-based (`touchedSymbols`, `parseImports` in `prPreflight.ts`): object-literal
  methods, renamed callers and `require()` are missed, member matches include unrelated objects.
  Read the list.

### Vortex's own E2E suite

Only when requested, `pnpm run ai:vortex-e2e -- --owner <worker> --checkout <dir>`
(= `vortex-e2e`) runs `<checkout>/packages/e2e` as
upstream CI does (`CI=1`, `VORTEX_E2E_HEADED` unset, one worker, no retries). It needs a built
checkout and holds E2E and checkout operation guards. Stop any app using that checkout first.
Its temporary fixture writes require source-mutation authorization. For the run only it:

- applies `harness/patches/` (`e2e-window-startup.patch`; KNOWLEDGE.md explains the local
  startup problem). It refuses a dirty checkout, fails if `git apply --check` does,
  skips patches already present, and restores exact bytes after confirmed child exit, including
  handled Ctrl+C. Inspect state after forcible termination;
- leaves out, via `--grep-invert`, tests needing absent `E2E_NEXUS_FREE_USER_*` /
  `E2E_NEXUS_PREMIUM_USER_*` credentials (environment or `packages/e2e/.env`), reported as
  credential-skipped, and refuses if Playwright's filtered count differs from its own.

| Flag                      | Effect                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| `--checkout <dir>`        | Vortex checkout (default `.vortex-src`)                            |
| `--spec <file>`           | Relative to `packages/e2e` or `packages/e2e/src/tests`; repeatable |
| `--grep`, `--grep-invert` | Passed to Playwright (credential filter added to the latter)       |
| `--compare <report.json>` | Regressions, pre-existing and fixed against an earlier run         |
| `--json`                  | Report as JSON; Playwright's output to stderr                      |
| `--owner <name>`          | Lease owner                                                        |

Reports use schema v4 and go to `harness/.artifacts/vortex-e2e/<time>-<sha>.json`. Old or malformed
baseline formats must be rerun. Comparison reports distinguish regressions, lost coverage,
changed failure causes and execution-condition differences. A successful exploratory command
does not establish final readiness; use the strict revision-bound readiness manifest described
in AGENT-WORKFLOW.md. For a PR, run master as the baseline, then the
branch with `--compare`. For an upstream CI failure, run its exact spec, save before/after
reports, don't substitute the harness app, and read the workflow's flags, credentials and test
summary. Animation tests need a rendered window (KNOWLEDGE.md). Test credential skips with the
account variables empty.

Final readiness is stricter than an exploratory comparison: skipped, credential-skipped and
flaky tests block it. Regressions, changed failures, missing coverage and execution-condition
drift cannot be dispositioned away. Only an unchanged pre-existing product failure can have
an inspected disposition, bound to its exact failure fingerprint and supporting evidence.
External blockers and unknown causes remain blocked.

### A Bethesda game without the game

`up --dev-dir <checkout> --bethesda-sandbox` manages a fake Fallout 4 that Vortex's own support
accepts (plugins, LOOT, the Plugins page, Missing Masters): a stand-in `Fallout4.exe` and
`Fallout4.esm`, plugins with real TES4 headers (`pluginBytes`, `writePlugin` in
`bethesdaSandbox.ts`), and a private `LocalAppData` and `Documents\My Games\Fallout4` under the
cache (Documents moved by a `NODE_OPTIONS=--require` preload, `mainPreload.ts`).

- **The harness refuses to manage the game unless `automation_status.paths` shows both
  redirects**, so the operator's real Fallout 4 profile is never written.
- **Source builds only**: packaged Vortex ignores NODE_OPTIONS and is stopped before a game
  activates. For a release's behaviour, build its tag from source.
- `--isolate-user-folders` gives any game the same private folders.
- `setDeterministicLoadOrder(mcp)` turns LOOT autosort off, orders natives, masters, light plugins
  and plugins by name, and verifies `state.loadOrder`, so Plugins page values compare across runs.
- `pnpm run ai:test:bethesda`: Missing Masters flags an absent master before and after an offline
  collection, whose postprocess must fire and plugin list apply; a game-version mismatch prompt
  must appear and Continue must complete.

### Offline collections

`offlineCollection.ts` builds collections with bundled members and installs them with no account.

- **Manifest**: `optional` members (a `recommends` rule); `plugins: [{ name, enabled }]`, by
  default every root `.esp/.esm/.esl` enabled (the gamebryo parser throws without it,
  KNOWLEDGE.md); `modRules` between members; a member `fileExpression` overrides its bundle name.
- **Direct members** (`direct: [{ name, url, optional?, tag?, logicalFilename?, plugins? }]`)
  download from a URL instead of the archive. Serve them with `startArchiveServer(archives,
{ fail })` (`downloadServer.ts`, `kit.downloads`): `fail(name, attempt)` resets that GET's
  connection. Vortex retries a failed download itself (4 GETs in all), so to make a member fail,
  fail it until the install ends, then stop failing and `resumeViaNotification` (the round trip is
  `ai:test:collection-download-retry`). `closeCollectionReviews(mcp)` closes any review a script or a
  resume left open; one left open makes the next install find no Install Now.
- `addOfflineCollection` registers the archive as a download and runs `start-install-download`, so
  the mod has an `archiveId`; `via: "file"` uses `start-install <path>` instead.
- `gameVersions: [MISMATCHED_GAME_VERSION]` makes Install Now show "Game version mismatch" (and
  records a pending vote); `answerGameVersionPrompt(mcp, "continue" | "cancel")` answers it.
- `installOfflineCollection(mcp, archive, options)` drives Install Now, the prompt and the review.
  Options: `gameVersions`, `gameVersionAnswer`, `allowIncomplete`, `onPhase`, and `optionals`: skip (default),
  `"install"` or `"stand-in"`. An incomplete review fails unless `allowIncomplete`. Returns
  `closedWith` and `postprocessed`. `onPhase` marks install-now, game-version-answered,
  review-shown, optionals-install, optionals-stand-in, review-closing, review-closed.
- Installing bundled optionals has stalled until Vortex's 5 min watchdog, so the default skips
  them. `completeOptionalsWithoutInstall(mcp, id)` stands in after Install optional mods so the
  review returns. **No member files exist: never use it to test installation.**
- `updateOfflineCollection(mcp, oldId, archive, { remove, keep })` does what `collectionUpdate`
  does after download, returning `removeMs`. The changelog, the "Remove mods from old revision?"
  question and re-enabling optionals are not reproduced.
- `resumeViaNotification(mcp, id)` is the only login-free path to `InstallDriver.start`: after
  Later it enables and deploys the collection, then clicks "Collection incomplete"'s Resume (toast
  in classic layout, Notifications popover in modern). Once per collection per session; deploys,
  so sandboxes only.
- **Find dialogs by their own text and buttons, never a full snapshot** (it hits its node limit on
  large lists; dialog text is cut at 400 chars). `waitForInstallNow`, `dialogButtons(mcp, text)`
  (disabled marked), `clickInsideDialog` (throws on a miss; pollers pass `{ required: false }`),
  `reviewDialogsFor(mcp, id)`.

### Where a collection install is

Collection startup observes the exact current driver before any resume or Install Now action. A newly added manifest uses stock did-install-mod -> driver.query; wait for its queued preparation and ownership instead of dispatching resume. Idle means a found collectionless driver at prepare or completed review, with preparing===false; only an existing manifest in that state can receive one resume. Dispatch failures propagate including Already installing text. Queued or unobservable preparation waits/fails within the startup deadline, including the final observation before clicking. A foreign current collection is refused even at review. The startup wait mounts the requested view at most once, bounds missing/queued-driver observation to 60 seconds inside the overall deadline, and clicks Install Now only at the exact owned query step. Completion verification remains separate; lastCollectionId alone does not establish active ownership.

Native `collection` and benchmark `addCollection()` never recover errors or retry failed actions. Collection notices (title and message, including warning notices), exact native failed session members and unresolved selected failed downloads are recorded as warnings. `installCollection({warningsAsErrors:true})` fails on any warning; the lower-level default permits warnings only after all selected members and the final completion boundary pass. A warning-bearing install without a supplied final functional/UI completion verifier fails conservatively; driver counters alone cannot prove the visible completion boundary. The native CLI supplies the stock completion-view verifier, prints warnings as they occur and supports --warnings-as-errors. Any remaining failed session/member record at completion fails regardless of policy. The SDK defaults a directly written manifest to strict mode when the option is omitted; the current catalog factories explicitly set `warningsAsErrors:false`, retaining warnings while requiring final functional/UI completion. A machine configuration can opt into strict warnings with `warningsAsErrors:true`. Repeats expose separate warnings with original severity and evidence records the policy. Catalog startup cases verify functional readiness before and after restart, outside the startup timing window. `collection_download_failures` uses the stock matcher without changing failed state. Normal dialogs/FOMOD steps advance the requested installation; failed UI actions propagate once and are not retried. An absent dialog is a normal waiting observation; a rejected host confirmation predicate inspects another candidate without clicking. Watcher errors during teardown cannot turn a failed action into success. Failed SDK install calls remain in evidence before throwing. Planned repeats stop on the first failure/block; an explicit retry case must retain every failed attempt. Timing errors remain separate and publish no invalid phases.

The completion poll fails immediately on an owned native review dialog whose text begins with the Collection installation incomplete heading. A match later in the body or a mod name does not establish failure; DOM text may concatenate the heading and body without whitespace. It requires a found review driver with current collectionId equal to the pinned manifest and strong dialog attribution (driver or collection-prop); a present session must match both collection and game. installDone=false is normal at this failed review. Review/postprocessing=false alone does not prove finalization has settled. Selected optional failure also terminates when the matching session has only terminal statuses, a failed recommends witness and unsatisfied selected optional rules. Pending/unknown statuses prevent that optional inference. Warning evidence is recorded before the failure; the detector performs no resume, retry, dismissal or selection repair.

The concurrent dialog watcher reads the exact owned native review and collection status before any COMPLETE review action. It blocks terminal failures independently of warningsAsErrors, allowing the completion poll to retain warnings and throw. With optionalMods=install it can start only one optional round; after that click its review policy permits Done only, and blocks every review answer while selected optionals remain unsatisfied. A settled installed-but-unsatisfied observation without a failed-member witness stays open until the existing timeout, rather than being retried or dismissed. Final successful completion clicks Done only. Tests run the actual watcher with autoAnswer=true, including failures appearing between its 1.5-second polls and the coordinator's 5-second polls.

Matching active session failed records block COMPLETE review clicks even if every collection rule is satisfied. The completion coordinator checks failed session/download records before returning satisfied counts, rechecks them before any final dialog dismissal or verifyCompletion call, and checks again afterward. Historical notifications may be warnings; remaining owned failed records never qualify as functional completion. Foreign session failures are not attributed to this collection.

`collection_install_state` (`doodlebot call collection_install_state`, cheap to poll) reads
Vortex's private `InstallDriver` through the React fiber tree; when a build stops passing its
`driver` prop, `driver.found` is false with a reason.

- `driver`: `step` (`prepare`, `changelog`, `query` = Install Now shown, `start`, `disclaimer`,
  `installing`, `review`), `installDone`, `postprocessing`, collection id and name, `preparing`,
  `starting` (null on builds without the game-version Cancel fix), `lastCollectionId`.
- `session`: the active session's members by status and type, and the outstanding ones.
- `dialogs`: open modals with their step (`query`, `game-version-prompt`, `review`) and collection
  (`collectionId`, `collectionName`, `via`: `driver`, `collection-prop` or `text`).

To wait on a plain `events.emit` event: `vortex_dispatch` with `action: "onEvent", args:
["<event>", "__CALLBACK__"]`, then `poll_listener`. There is one listener per event name, so take
`lastSeq` first (`watchEvent` in `offlineCollection.ts`).

### Measuring renderer, main process and checks

- `perf_trace_start` / `perf_trace_stop` (write tier): count, total and max ms per action type,
  tasks over 50 ms, heap start/max/end. React rendering shows as long tasks.
- `profileRenderer(page, run)` (`profiling.ts`): a CDP CPU profile summarised by function and
  file, `inclusive`, `inclusiveApp`, `longestBusy`, plus a DevTools `.cpuprofile` and
  `pageStartMs`; `summariseWindows(profile, windowsFromMarks(marks, durationMs))` splits by marks.
- `tableProbes.ts`, for any SuperTable (`#table-<id>`) or modal: `measureRowIdentity`,
  `measureAfter` (blocking until a page condition holds), `recordDialogFade`, `rowsOnScreen`,
  `wheelScroll`, `jumpAndSample`, `probeRowDropdown`, `columnWidths`, `seedConflictPairs`,
  `conflictEditorCounts`.
- `markLog` / `readSince` / `summariseLog` (`vortexLog.ts`): Vortex's log over an operation
  (persist:diff per hive, slow writes, sort timings, backups, memory warnings, crashes).
- `check_probe_counts`: health-check runs per event in harness instances; a count that stops
  rising while its event fires means those checks are suppressed.
- **Keep the observer light**: poll `ui_active_dialogs` / `openDialogs` (`uiDriver.ts`), never
  repeated full `ui_snapshot`s, which dominate a profile on large lists.

**Production.** Source builds run NODE_ENV=development with React's slow development build, so any
timing meant to reflect users needs production:

- `pnpm run ai -- build --checkout <dir> [--production]` runs the checkout's `pnpm run build` with
  its pinned pnpm under the checkout lock, refusing while a Vortex runs from it, with
  NODE_ENV=production for the build only (unset otherwise). It restores `etc/vortex.api.md` and
  `etc/Dependency Report.md` if rewritten. The caller's environment is untouched; in the agent
  sandbox clear a variable with `$env:NODE_ENV=$null`.
- `up --dev-dir <checkout> --production` **fails unless `automation_status` shows
  `nodeEnv: "production"` and `react.build: "production"`**, and warns on a development bundle.
- Compare A/B builds in the same mode from the same `--fresh` baseline; record
  `automation_status.react` with the numbers.

### Opt-in checks

Outside `ai:test`; each writes JSON evidence (and screenshots or a `.cpuprofile`) under
`harness/.artifacts`. Keep CPU-heavy work off the machine while they measure.

| Command                                                   | Needs                              | Fails on                                                                    |
| --------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `ai:test:collection-scale -- --members <n>`               | sandbox                            | a freeze over 10 s in a phase                                               |
| `ai:test:plugins-page -- --plugins <n> [--vortex-order]`  | fake Fallout 4                     | blocking on scroll, filter, clear or toggle; a row not following its toggle |
| `ai:test:collection-download-retry`                       | fake Fallout 4                     | a member whose downloads failed not being installed by a resume             |
| `ai:test:plugins-mod-link -- --mods <n>`                  | fake Fallout 4                     | the Mod link not scrolling the last-sorted mod (default 300) into view      |
| `ai:test:download-churn -- --downloads <n> --seconds <s>` | any                                | nothing; measures persist:diff, slow writes, dispatches, long tasks         |
| `ai:test:large-library`                                   | sandbox                            | see below                                                                   |
| `ai:test:mods-scroll -- --mods <n>`                       | sandbox                            | see below                                                                   |
| `ai:test:zoom [-- --signed-out]`                          | source build with zoom             | zoom controls, shortcuts, timers, animation, layout                         |
| `ai:test:panels`                                          | source build, `--bethesda-sandbox` | right-hand split view behaviour                                             |

- **collection-scale** options (`collectionScale.ts`, deterministic; none = required members, no
  rules): `--optional <f>`, `--glob <f>`, `--duplicates <n>`, `--rules <n>`, `--update` (revision
  2, `--extra <n>` default 50), `--missing-optional`, `--optionals skip|install|stand-in`.
  `phases.install` and `phases.update` report wall time, `longestFreezeMs`, long tasks, step
  timings, `dispatches`, `marks`, `windows`, `inclusive`, `inclusiveApp`, `longestBusy`. Realistic:
  `--members 2000 --optional 0.1 --glob 0.04 --duplicates 20 --rules 1000 --update`.
- **large-library** (3,000 seeded mods, `largeLibrary.ts`): more than 200 rendered rows, a filter
  clear blocking over 2 s, blank rows at any depth, a task over 1.5 s across 10 installs, or a
  modern deploy over 1.6× the classic-layout deploy (or `--max-deploy-ms`). Flags: `--mods <n>`,
  `--layout modern|classic`, `--installs <n>`, `--no-deploy`, `--settings-deploy`. Run against a
  source build and against `--installed` as baseline.
- **mods-scroll** (real wheel, `--mods` default 3,000): more than 200 rows on arrival, a flick
  frame gap over `--max-frame-gap` (300 ms), blank rows 1 s after scrolling, a clipped edge
  dropdown, the Status column narrowing back, or with `--conflicts <pairs>` over 200 conflict
  editor entries rendered. Rows kept after a scroll-through only warn unless
  `--max-accumulated <n>`; `--no-scroll-through` skips it.
- **zoom** needs no game or account and restores zoom, layout and window size. `--signed-out`
  uses a separate anonymous profile on the next ports and never logs out the active one.
- **panels**: match `VORTEX_AI_OWNER` to the instance owner; it saves and restores workspaces and
  window size. The toggle is `[data-split-view-toggle]` (`aria-pressed`), the chooser
  `[data-panel-chooser="panel"]`; both panes stay at least 440 px.

## Configuration and recovery

| Variable                                   | Purpose/default                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `VORTEX_AI_EXE`                            | Installed Vortex executable, otherwise auto-detected                       |
| `VORTEX_AI_DEV_DIR`                        | Explicit Vortex source directory                                           |
| `VORTEX_AI_INSTALLED`                      | `1` forces installed Vortex, including tests                               |
| `VORTEX_AI_GAME_ID`, `VORTEX_AI_GAME_PATH` | Game and install path                                                      |
| `VORTEX_AI_CACHE_DIR`                      | Profiles/login cache; default `harness/.cache`                             |
| `VORTEX_AI_ARTIFACT_DIR`                   | Screenshots/reports; default `harness/.artifacts`                          |
| `VORTEX_MCP_PORT`, `VORTEX_AI_CDP_PORT`    | MCP/CDP; default 3701/9222                                                 |
| `VORTEX_MCP_TOKEN`                         | Bearer token shared by harness and MCP client                              |
| `VORTEX_AI_NEXUS_API_KEY`                  | Optional legacy key; sandboxes need `--with-api-key`                       |
| `VORTEX_AI_HEADLESS`                       | Hide window; screenshots may be blank                                      |
| `VORTEX_AI_OWNER`                          | Required named worker when `--owner` is absent                             |
| `VORTEX_AI_SLOT`                           | Instance slot (`0`–`19` or `auto`) when `--slot` is absent                 |
| `VORTEX_AI_PNPM`                           | A pnpm of the Vortex checkout's pinned version, used instead of `pnpm dlx` |
| `VORTEX_AI_LEASE_DIR`                      | Lease files; default `~/.vortex-ai/leases`                                 |
| `VORTEX_AI_KIT`                            | Set by `script`: the `file://` URL of `kit.ts`                             |

- Unclear prerequisites: `doctor` with the same flags. No UI write tools: Vortex started without a
  token. HTTP 403: token, host or origin mismatch.
- Startup errors name the isolated `userData/vortex.log`. Don't print whole logs: auth flows may
  log sensitive URLs.
- An instance predating `automation_status`: update its extension and restart it with its MCP
  `vortex_quit` tool first.
- **Never treat a port collision as permission to stop an unrelated Vortex.** Never commit
  profiles, screenshots with private data, or credentials.
