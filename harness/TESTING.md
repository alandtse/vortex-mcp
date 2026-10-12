# Testing doodlebot

Test the contracts doodlebot owns: safe isolation, startup and shutdown, credentials,
MCP transport, UI actions, and evidence from real installation and deployment. A Vortex
feature regression is useful evidence for that feature, but is not a universal kit gate.

## Fast gate

Cold setup regressions: `pnpm exec vitest run harness/src/bootstrap.test.ts` requires installed
kit dependencies but no Vortex, game or account. Mocked launches and temporary directories
verify register/flush/native-startup ordering, delayed activation, private path validation,
conflicting CLI arguments, no-game behavior and failure preservation. A failed first shutdown
cannot admit the second launch; activation failures cannot publish the snapshot marker.
These checks do not prove native staging creation. Run the released-app core and the relevant
source runtime separately, including actual staging tag/instance identity, archive install,
enable/deploy/purge, warm/reset reuse and graceful shutdown.

`pnpm exec vitest run harness/src/gameStartup.test.ts` exercises the actual activation/dialog
helpers with fake clocks and MCP transport. Watcher failures are captured immediately, abort
further active-game polling, and await in-flight work before rejecting. Separate UI activation
and watcher errors remain distinct causes. These tests need no Vortex, game or account.

`pnpm run ci` runs types, lint, formatting, paired documentation checks and their negative
controls, unit and filesystem/process tests, and the extension build. Run it for every kit change. Tests use synthetic credentials and an
isolated lease directory. The operator's package-manager override must not affect them.

Keep boundary and failure tests: authentication/redaction, stale profile guards, leases,
sandbox containment, refused destructive dialogs, incomplete installs, failed shutdown,
cache rotation/logout, and restoring a checkout after a failed check. Test runtime selection
through a real child process and concurrent Electron resolution through separate processes.
These tests do not download tools or contact Nexus.

Collection-start regressions use the real UI helpers with a bounded root snapshot and a
separately observable dialog footer. DOM coverage verifies the default 1,500-node limit;
startup coverage includes stock nested dialog-role containers and separate identical sibling
dialogs through actual DOM snapshots. It checks one click, stacked dialogs, missing/ambiguous dialogs and transport
failure without a second action. These checks do not establish a real collection completed.
Click identity tests exercise handlers that relabel/change role during mousedown or click;
returned metadata describes the target before the sequence. Collection startup also exercises
native DOM label replacement through its MCP response adapter.

Human tests/benchmark run instructions live in `/docs/testing`; update those with this manual
and the source-generated package/helper references when selection or prerequisites change.
`docs:check` validates contract drift, paired change coverage and the human-only site boundary.
`docs:test` verifies stale/missing/one-audience failures and executable documentation examples.
`docs:build` is the separate strict MkDocs gate for site publication, using requirements-docs.txt.

Staging integrity regressions: `pnpm exec vitest run harness/benchmarks/stagingIntegrity.test.ts`
needs no Vortex, game or account. Private native filesystem fixtures and mocked native state/UI
exercise the SDK's warm preparation and real-readiness routes. Missing, linked, unsafe and
non-directory staging paths fail before purge/removal; empty installed inventories also fail.
Both measurement routes defer this validation until after the action window and reject failed
samples. These fixtures mock the recorder and establish no real installation or native phase
timing. Directory presence is not full installer-output integrity; deployment-manifest byte
verification is separate. Failures retain evidence without recovery or another install attempt.

Workflow regression coverage must exercise actual boundaries: independent commands with the
same owner are excluded; intentional nested work is allowed; partial holds unwind before retry;
known children keep protection after wrapper interruption; failed child registration waits for
exit; expired/replaced acquisitions cannot be renewed or released by stale callers. Kit unlock
requires the original acquisition ID; forced recovery still checks live operations and a clean tree.
Fixture shutdown errors preserve the app PID, profile and parent cache, and fail the run;
directory cleanup follows confirmed exit. Use synthetic
repositories/processes for these cases, never temporary edits to a user's Vortex source.

Watch tests check source edits/additions/deletions, contention without lost updates, finite
build/copy/reload guards, immutable inputs through edit/Undo, build failure and cancellation,
verified generation freshness, staged publication/copy rollback and foreign profiles at every
attachment/reload boundary. Fixture tests include rejected shutdowns without an error value.
Evidence tests
check real CLI exclusion/cancellation, source/runtime drift, applicable gates, nonempty complete
selection and changed E2E failures. A happy-path schema test alone cannot prove these contracts.
Readiness regressions also cover native producer-kit drift, provenance on every production
performance run, Vortex runtime/subject mismatch across checkouts, and skipped or TODO
scoped/control tests. Native assertion controls retain reporter bytes for each test group;
tests reject absent, inconsistent, empty or incomplete execution on either side, prove real
Vitest output is collected, and verify cancellation waits for child exit before restoration.
Retain the producing kit identity on both sides of native preflight and E2E execution; regenerate
current and baseline reports when that kit identity differs from the readiness manifest.

## Account-free real-app contract

Recorded CI at `1729a39` on 7 October 2026 passed the kit gate (675 unit tests in 58 files,
plus documentation controls), but the released Vortex 2.8.0 core passed 20/21. The lifecycle
test failed with `Vortex did not exit cleanly`; fixture preservation remained enabled.
Run [37673176382](https://github.com/doodlum/vortex-doodlebot/actions/runs/37673176382) retains
the failure trace. Its cause is unconfirmed; do not treat an earlier 21/21 at `343fd18` as
evidence that this run passed, or force shutdown/delete the fixture to hide the failure.

`pnpm run ai:test:core` (`ai:test` is the same suite) runs only the four core `.spec.ts`
files. It uses disposable profiles, games, and credentials, independent of the operator's
login. Run it after changes to the extension, launch/cache code, UI driver or deployment,
and before releasing the kit.

- Launch and clean shutdown; cold/warm/fresh profile semantics and game activation.
- No unrecoverable errors in the fixture's main/renderer logs, including rotated logs.
  Check after confirmed shutdown and before deleting or resetting each profile; a responsive
  MCP endpoint and passing UI assertions do not establish a healthy startup. Retain the
  fixture evidence on a failed health check, and skip links to unrelated profiles.
- Correct profile/debug ports; MCP tools available with writes enabled.
- Snapshot references, React clicks/input, native select, keyboard, scroll and hover.
- Real window dimensions and restoration, allowing at most two DIPs of OS rounding.
- Known layout faults, decoded PNG dimensions/content, and a fresh renderer after reload.
- Archive installation, enable/disable, deployed file contents and purge.

Use Playwright or filesystem observations to check MCP actions independently. Ordinary
assertions time out in 60 seconds; cold worker fixtures have a separate four-minute budget.
The lifecycle test sets its own four-minute limit. Restore modified window/DOM state even
when assertions fail. Performance is not measured by these timings.

CI runs this suite against official Vortex **2.8.0**, with a pinned SHA-256 installer, after
the fast gate. Update the version, URL and checksum together when changing the supported
baseline. Source builds run the same suite locally with the managed source checkout;
`VORTEX_AI_INSTALLED=1` and `VORTEX_AI_EXE` explicitly select a release instead. A green source
run alone does not establish compatibility with a released Vortex.

## Authentication and live services

`pnpm run ai:test:oauth` explicitly uses the operator's sandbox login. Cache it first with
`save-login --sandbox`. The check captures a clean profile, performs a fresh restore, verifies
access/refresh credential presence, and leaves Vortex running. It prints no credentials.
This verifies persistence, **not** that Nexus accepts the login.

`pnpm run ai:test:nexus` is a separate live-service collection check. It requires cached OAuth,
network access and Premium for unattended downloads. Run it deliberately after authentication
changes or before a release; never require an account for the fast or core gates.

## Optional Vortex regressions and benchmarks

The named `ai:test:*` scripts outside Playwright are explicit scenarios:

| Purpose                                   | Commands                                             |
| ----------------------------------------- | ---------------------------------------------------- |
| Collection recovery and Bethesda checks   | `collection-download-retry`, `bethesda`              |
| Plugins, zoom and split panels            | `plugins-page`, `plugins-mod-link`, `zoom`, `panels` |
| Multi-session isolation                   | `parallel-sessions`                                  |
| Performance/scale                         | `large-library`, `mods-scroll`, `collection-scale`   |
| Measurement without a pass/fail threshold | `download-churn`                                     |

Run the relevant scenarios when changing those Vortex features or the kit helpers they use.
Use production React for performance runs, an idle machine, explicit fixture sizes, and
baseline comparisons. Do not treat a measurements-only script's successful exit as a passed
performance test. Existing Vortex bugs may fail a targeted regression without invalidating
doodlebot's core contract. Report each suite, failures and skips separately.

## Final workflow integration

After scoped checks, run the actual CI and released-app core commands through `evidence run`,
using an isolated owner/slot and new reporter paths. Unit and core fixture environments start
their own operation contexts; the collecting parent retains protection for its known child.
This checks the composed workflow as well as the individual helpers.

Fresh QA inspects the identified diff and independently exercises a refusal or failed check,
recovery and a subsequent handoff. Synthetic repositories cover source mutation/restoration;
an isolated released app covers runtime behavior. Inspect the final manifest and artifacts,
then run `readiness`. Verify the actual final commit for publication; a previous local-diff
receipt remains evidence for that diff only. See [the manual](AGENTS.md#recorded-checks-and-readiness)
and [the workflow](AGENT-WORKFLOW.md) for commands and report responsibilities.

## Human-authored benchmark entry points

The TypeScript benchmark SDK in harness/benchmarks runs released Vortex without a source build. Its process-spawn callback marks B5 startup. The human guides in docs/testing document fixtures, explicit real-game prerequisites, 133 proposed cases, three repeats, and blocked reports. Human documentation is authored from the proposal and implementation, without using machine manuals as prose input. Machine references are generated from source.
