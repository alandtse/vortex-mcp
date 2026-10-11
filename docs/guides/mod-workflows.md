# Install a mod and check deployment

This example creates a tiny archive, installs it, enables the mod, deploys it, and checks the actual file in the disposable game. Save it at the repository root:

```typescript title="local-mod.mts"
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withVortex } from "./harness/benchmarks/index";
import { clientFor, localMod, zipSync, strToU8 } from "./harness/src/kit";

await withVortex({}, async (vortex) => {
  const archive = path.join(vortex.config.cacheDir, "hello-mod.zip");
  const content = "Hello from a Vortex test\n";
  fs.writeFileSync(archive, zipSync({ "textures/hello.txt": strToU8(content) }));

  const { modId } = await localMod.installLocalMod(clientFor(vortex.config), archive);
  const profile = await vortex.call<{ id: string }>("vortex_query", {
    selector: "activeProfile",
  });
  await vortex.call("set_mods_enabled", {
    modIds: [modId],
    enabled: true,
    profileId: profile.id,
    expectedActiveProfileId: profile.id,
  });

  const deployed = path.join(vortex.config.gamePath!, "Data", "textures", "hello.txt");
  try {
    await vortex.deploy();
    assert.equal(fs.readFileSync(deployed, "utf8"), content);
  } finally {
    await vortex.purge();
  }
});
```

Run `pnpm exec tsx local-mod.mts`.

Installation writes to Vortex's staging directory. Enabling chooses the mod for the active profile. Deployment places its files in the game. The assertion checks the final bytes, so the test can catch a deployment failure even if the installed-mod list looks correct.

This archive's `Data/textures` destination belongs to the disposable test game. Real games have different mod paths and installers. Use a suitable fixture when testing those behaviors.

## Collections

Real collection runs need [OAuth and download access](../getting-started/setup.md). Use the [benchmark runner](../testing/benchmarks.md) with a pinned revision, cache mode, and explicit game fixture. See the [proposal matrix](../testing/proposal.md) for intended real-data coverage.

Doodlebot presses **Install Now** in the collection's own dialog, even with a large mod library open behind it. It rechecks that the collection still owns the install driver before clicking. If that dialog is missing, ambiguous, or the click fails, the run fails and keeps its evidence. It does not retry the click or restart installation.
