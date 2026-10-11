# Read and compare results

Open the `results.json` in your runner's output directory. Check each case's status before looking at its timing.

`runBenchmarks()` writes this report, then throws if any case failed or was blocked. A nonzero command exit can therefore have a useful complete report. A multi-group runner catches each group's error, continues saving the other reports, and finishes unsuccessfully if any group was incomplete.

| Status    | Meaning                                                                  | Next step                         |
| --------- | ------------------------------------------------------------------------ | --------------------------------- |
| `passed`  | The case's actions and assertions completed, and supplied budgets passed | Read repeat statistics and scope  |
| `blocked` | A required condition, fixture, account, page, or control was unavailable | Resolve the recorded prerequisite |
| `failed`  | An assertion, operation, cleanup, or supplied budget failed              | Inspect the reason and evidence   |

With no supplied budget, `passed` is a correctness result for that case. It does not mean a release performance criterion has been met. A blocked row is missing coverage, not a slow sample.

`runBenchmarks()` returns the final results after every selected case and teardown passes. A failed or blocked case is saved to `results.json` before the function throws. Catch the error and inspect that report; callback evidence alone cannot establish success. The final report includes teardown failures.

## What the report contains

Each case has an ID and `dataset` (`real` or `synthetic`), per-repeat measurements and evidence, and a summary for each measurement name. The summary includes `samples`, `medianMs`, `minMs`, `maxMs`, and `spreadMs`.

All these app tests use released Vortex. `dataset` describes the data: `synthetic` means generated fixtures; `real` in the collection suite means actual members of a pinned Nexus revision. Check the cache evidence too. B1 downloads genuine members during timing; B2 uses genuine archives downloaded during preparation. B3–B5 time deploy or startup after installation. A warm real result is not a download-speed result, and a generated Downloads ZIP is not a cached Nexus member. [Test forms](proposal.md#real-and-synthetic-data-answer-different-questions) explains the local and offline alternatives.

Look inside each repeat's `evidence` array for its cache preparation entry. A cold run records `cache: "cold", archives: 0`. A warm run records `cache: "warm", completePrefill: true` and its archive count after checking completed files and sizes. The warm timed interval also checks that no member download begins or resumes. Read these entries together with the case status: preparation evidence alone cannot turn a failed install into a passed result.

Each measurement retains `wallMs`, `excludedMs`, and `activeMs`. Collection reports also contain phase events and excluded wait/pause intervals. Phase durations can overlap; do not add them to reconstruct total time.

Each repeat has a separate `warnings` array. A warning keeps its source, message, timestamp and original severity, including Vortex notices originally reported as errors. Collection runs use the warning policy saved by [setup](../getting-started/setup.md). Allowing warnings only permits a pass when Vortex confirms a fully installed collection and the final functional checks pass. Strict policy (`warningsAsErrors: true`) fails on any warning, even if installation later finishes. Unresolved failed members always fail. Earlier reports keep their original policy and result.

Doodlebot records failed install calls and does not retry them. A case that explicitly tests retries must keep every failed attempt in its evidence, even when a later attempt succeeds. Successful performance samples repeat only until the first failed or blocked repeat.

If the timing recorder loses events or cannot subscribe, install verification runs independently. A successful install with unusable timing produces a blocked benchmark, no collection measurements or partial phase timings, and a `collection timing` evidence entry with `valid: false`. An install error still produces a failed case, even when timing also failed.

Table measurements can include input delay, long-task blocked time, worst task, and worst frame. A missing input-delay sample is `null`, not zero. These measurements describe the instrumented action; they are not all interchangeable with user-perceived latency.

UI metrics get their own repeat summaries, for example `mods.scroll.worstFrameMs` and `mods.scroll.blockedMs`. Null input-delay samples are excluded. If a supplied budget needs a metric that was not captured, the case is blocked rather than passed. Different measurement sequences across repeats fail the case and retain raw results for diagnosis.

A measure() clock covers the complete callback and its visible result, including any readiness work you put inside it. Staging directory validation and deployment file integrity are checked afterward, before accepting the sample. Collection total time stops at the readiness boundary, before listener cleanup and post-run checks. Those checks can still fail the case. Collection-driver waits and polling remain part of end-to-end time and are described in control-overhead evidence; they are not silently removed as user waits.

Simple sort helpers read the names and establish an initial order before timing. Their setup warms virtualized rows; the reported action reverses that order and waits for visible rows to paint. Compare these runs with the same preparation.

The report records run conditions and host information. Private OAuth-cache and source game-fixture paths are omitted from the manifest. Check the remaining output before sharing it.

The suite index starts with `inProgress: true` and every selected group marked pending. It becomes complete after all groups finish. If a run stops early, pending groups are missing coverage; an older report in their directory does not belong to the new run.

## Compare the same cases

Keep two report directories, one for the baseline build and one for the candidate. Use the same hardware, storage, account, bandwidth, data revision, counts, actions, cache mode, security settings, window size, display scaling, UI zoom, and repeat count. Record the intentional Vortex build change.

Save this comparison script at the repository root:

```typescript title="compare-results.mts"
import fs from "node:fs";
import type { BenchmarkResult } from "./harness/benchmarks/index";

type Report = { results: BenchmarkResult[] };
const baseline = JSON.parse(
  fs.readFileSync("harness/.artifacts/baseline/results.json", "utf8"),
) as Report;
const candidate = JSON.parse(
  fs.readFileSync("harness/.artifacts/candidate/results.json", "utf8"),
) as Report;

for (const current of candidate.results) {
  const previous = baseline.results.find((result) => result.id === current.id);
  if (!previous || current.status !== "passed" || previous.status !== "passed") {
    console.log(current.id, "not comparable", current.status, current.repeats[0]?.reason ?? "");
    continue;
  }
  for (const [name, summary] of Object.entries(current.summary)) {
    const before = previous.summary[name];
    if (!before || before.medianMs <= 0) continue;
    console.log({
      case: current.id,
      measurement: name,
      baselineMs: before.medianMs,
      candidateMs: summary.medianMs,
      changePercent: 100 * (summary.medianMs / before.medianMs - 1),
      candidateSpreadMs: summary.spreadMs,
    });
  }
}
```

Run `pnpm exec tsx compare-results.mts`. Positive change means the candidate took longer. This script calculates differences; it does not decide whether they block a release. Review the manifests yourself before treating rows as comparable.

A large spread suggests repeat noise worth investigating. Check background activity, network changes, cache state, and thermal behavior before attributing the difference to Vortex.

## Apply an agreed budget

`manifest.budgets` accepts a measurement key in the form `<case-id>.<measurement-name>`. A budget can supply `maxMs`, or `baselineMs` with `maxSlowdownPercent`. Values must come from the agreed test plan; no default slowdown or absolute target is provided.

For example, if your case ID is `T1-scroll-150` and its measurement is `mods.scroll`, the budget key is `T1-scroll-150.mods.scroll`. A median outside a supplied budget changes the case status to failed and lists the key in `regressions`.

The proposal's target and slowdown decisions remain **TBD**. Retain the initial raw results while those decisions are made.
