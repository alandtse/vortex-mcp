# Write a unit test

Use Vitest for logic that does not need Vortex: parsing, statistics, input validation, and pure DOM helpers. Test the behavior your caller relies on, including a useful failure case.

```typescript title="harness/src/my-parser.test.ts"
import { expect, it } from "vitest";
import { parseCollectionRef } from "./collections";

it("keeps a pinned collection revision", () => {
  expect(parseCollectionRef("nxm://skyrimse/collections/example/revisions/7")).toEqual({
    gameId: "skyrimse",
    slug: "example",
    revision: 7,
  });
});
```

`example` is test input for the parser; it is not a real collection to download.

Run `pnpm exec vitest run harness/src/my-parser.test.ts`. The full unit suite is `pnpm run test`.

DOM logic belongs with the extension's jsdom tests. A simulated DOM can check a selector or transformation, but cannot prove that a current Vortex screen has the expected control. Use [a real-app test](integration.md) for that contract.

For collection startup, run `pnpm exec vitest run src/uiAutomation.test.ts harness/src/collectionStartup.test.ts`. These tests cover a large page whose snapshot stops before the dialog, Vortex's nested dialog wrappers, two separate dialogs with identical text, one successful **Install Now** click, and failures without another click. They need neither a game nor a Nexus account; they do not install a real collection.

The DOM click tests also check buttons that change their label or role during the action. The click result must describe the original target so a successful transition to another dialog step does not look like a wrong click.

When changing measurements, test the timing arithmetic and status handling with unit tests, then verify the actual app action separately.

Run `pnpm exec vitest run harness/benchmarks/stagingIntegrity.test.ts` to check collection staging validation. It needs no Vortex, game or account. The tests use real temporary directories with mocked Vortex state, UI and timing recorder. They check that missing or unsafe staging fails before cleanup, and that both timing routes reject failed validation without counting validation time. They do not install a real collection or measure native phases.
