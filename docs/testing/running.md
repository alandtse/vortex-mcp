# Choose and run checks

Doodlebot has fast repository checks, real-app integration tests, and performance scripts. Pick the layer that answers your question.

| Check              | Command                           | What it proves                                                                 |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------ |
| Repository gate    | `pnpm run ci`                     | Types, lint, formatting, documentation checks, unit tests, and extension build |
| Unit tests         | `pnpm run test`                   | Pure logic and simulated DOM behavior                                          |
| Real-app tests     | `pnpm run ai:test`                | Integration with an actual Vortex app and a disposable game                    |
| Your benchmark     | `pnpm exec tsx run-benchmark.mts` | Your defined actions, observations, timings, and supplied budgets              |
| Documentation site | `pnpm run docs:build`             | The site builds with valid navigation and links                                |

## Local integration suite

Install dependencies and a released Vortex first. The core Playwright suite runs without a Nexus account and uses disposable profiles and a test game. To force the installed app when a source checkout exists:

```powershell
$env:VORTEX_AI_INSTALLED = 'true'
pnpm run ai:test
```

The suite runs one worker and writes an HTML report to `harness/playwright-report`. Failure traces are retained. A Playwright test timeout is different from an approved performance budget.

Account and game-specific tests are separate. Do not infer that a local synthetic test covers a real collection or engine page.

The repository gate checks collection startup with simulated UI responses and DOM snapshots, including large pages, stacked dialogs, and failed clicks without another action. A real collection run must still reach its verified installation and deployment result.

## Add the right test

Use [unit tests](unit.md) for pure logic and DOM helpers. Use [real-app tests](integration.md) for Vortex integration and deployed files. Use [benchmarks](benchmarks.md) to compare observable performance.

A passing repository gate does not run Vortex. Report the specific check you ran and any untested real-app behavior.
