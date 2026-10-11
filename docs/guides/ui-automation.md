# Drive the UI

Your `withVortex()` callback has a normal Playwright `page`. Use visible labels for actions and check their effect.

```typescript title="ui-test.mts"
import { expect } from "@playwright/test";
import { withVortex } from "./harness/benchmarks/index";

await withVortex({}, async (vortex) => {
  await vortex.seedMods(150);
  await vortex.openPage("Mods");

  const search = vortex.page.locator("#table-mods .header-name input");
  await search.fill("no-matching-mod");
  await expect(vortex.page.locator("#table-mods tr[data-rowid]")).toHaveCount(0);

  await search.fill("");
  await expect(vortex.page.locator("#table-mods tr[data-rowid]")).not.toHaveCount(0);
});
```

Run `pnpm exec tsx ui-test.mts`. The test generates local mods, searches for a name absent from the list, checks that no rows remain, and clears the search to verify the list returns. It exercises the actual input.

## Inspect named controls

For Vortex's UI snapshot helpers, connect the lower-level client within the same callback:

```typescript
const client = clientFor(vortex.config);
const screen = await ui.snapshot(client);
console.log(ui.flatten(screen.tree).map(({ role, name, text }) => ({ role, name, text })));
```

Import `clientFor` and `ui` from `./harness/src/kit`. A snapshot describes controls currently rendered by Vortex. It does not prove that an off-screen row, download, or deployed file exists.

Large pages can reach the snapshot's node limit before a dialog's footer. Inspect the dialog directly with `ui.snapshot(client, '[role="dialog"]')`. Collection startup does this automatically, checks that the dialog and **Install Now** button are unique, and takes a fresh scoped snapshot before clicking.

`ui.clickByName(client, {role: "button", name: "Manage"})` takes a fresh snapshot and requires one matching control. Use the actual label on your screen. A string name matches exactly, ignoring case; a regular expression supports a pattern. An ambiguous match needs a more precise role, `testId`, or scope.

## Time a table action

For table benchmarks, use [the action helpers](../testing/adding-benchmarks.md). They require an observable consequence and record timing only after that consequence appears.

Game-specific Plugins and Load Order pages need real game data and their actual controls. Missing pages should become blocked coverage, not successful tests of a substitute table.
