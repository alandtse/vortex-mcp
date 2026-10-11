import { afterEach, expect, it, vi } from "vitest";
import { installCollection } from "./collections";
import type { VortexMcpClient } from "./mcpClient";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  "query",
  "stacked-dialogs",
  "missing-dialog",
  "ambiguous-dialogs",
  "duplicate-buttons",
  "disabled-button",
  "dialog-drift",
  "snapshot-error",
  "scan-owner-drift",
  "scan-step-drift",
  "scan-preparation-drift",
  "wrong-click-target",
  "start",
  "installing",
  "disclaimer",
  "review",
  "idle",
  "preparing",
  "fresh",
  "fresh-unclaimed",
  "foreign",
  "foreign-review",
  "dispatch-error",
  "click-error",
  "changed-owner",
  "unknown-preparation",
  "missing-preparation",
  "collectionless-start",
  "closed-review",
  "preparation-changes",
  "preparation-unobservable",
  "query-vanishes",
])("starts the exact collection once without hiding failures: %s", async (mode) => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        data: {
          collection: {
            id: 1,
            name: "Fixture",
            currentRevision: { id: 2, revisionNumber: 2, modCount: 1 },
          },
          requested: { id: 2, revisionNumber: 2, modCount: 1 },
        },
      }),
    ),
  );
  const fresh = mode.startsWith("fresh");
  let added = !fresh;
  let warning = false;
  let observations = 0;
  const idle = [
    "idle",
    "dispatch-error",
    "preparing",
    "fresh",
    "fresh-unclaimed",
    "unknown-preparation",
    "missing-preparation",
    "collectionless-start",
    "closed-review",
  ].includes(mode);
  const foreign = mode.startsWith("foreign");
  const driver = {
    found: true,
    collectionId: idle ? undefined : foreign ? "other" : "pinned",
    lastCollectionId: "pinned",
    preparing:
      mode === "unknown-preparation"
        ? null
        : mode === "missing-preparation"
          ? undefined
          : mode === "preparing" || mode === "fresh",
    step: idle
      ? "prepare"
      : foreign ||
          [
            "click-error",
            "changed-owner",
            "preparation-changes",
            "preparation-unobservable",
            "query-vanishes",
            "stacked-dialogs",
            "missing-dialog",
            "ambiguous-dialogs",
            "duplicate-buttons",
            "disabled-button",
            "dialog-drift",
            "snapshot-error",
            "scan-owner-drift",
            "scan-step-drift",
            "scan-preparation-drift",
            "wrong-click-target",
          ].includes(mode)
        ? "query"
        : mode,
    installDone: mode === "review" || mode === "foreign-review" || mode === "closed-review",
  };
  if (mode === "collectionless-start") driver.step = "start";
  if (mode === "closed-review") driver.step = "review";
  if (mode === "preparation-changes")
    setTimeout(() => {
      driver.preparing = false;
    }, 6000);
  if (driver.preparing)
    setTimeout(() => {
      driver.preparing = false;
      driver.collectionId = "pinned";
      driver.step = "query";
    }, 500);
  const mod = {
    id: "pinned",
    type: "collection",
    attributes: { collectionSlug: "wanted", revisionNumber: 2 },
    rules: [{ type: "requires", reference: { tag: "member" } }],
  };
  let generation = 0;
  let latestRef = "";
  const scopedReads = new Map<number, number>();
  const call = vi.fn(async (tool: string, args?: Record<string, unknown>) => {
    if (tool === "nexus_auth_status") return { oauthPresent: true, oauthRefreshable: true };
    if (tool === "list_notifications")
      return warning
        ? [{ id: "duplicate", type: "warning", message: "Already installing a collection" }]
        : [];
    if (tool === "collection_download_failures") return [];
    const collectionDialog = "Skyrim Special Edition collection addedFixtureLaterInstall Now";
    const otherDialog = "Another operationInstall Now";
    if (tool === "ui_active_dialogs")
      return mode === "missing-dialog"
        ? [otherDialog]
        : mode === "stacked-dialogs"
          ? [otherDialog, collectionDialog]
          : [collectionDialog];
    if (tool === "ui_snapshot") {
      const index = Number(args?.index ?? 0);
      if (args?.selector !== undefined) {
        if (mode === "snapshot-error") throw new Error("Snapshot transport rejected");
        if (
          args.selector !== '[role="dialog"]' ||
          index >= (["stacked-dialogs", "ambiguous-dialogs"].includes(mode) ? 2 : 1)
        )
          throw new Error("No element matches selector");
        scopedReads.set(index, (scopedReads.get(index) ?? 0) + 1);
        if ((scopedReads.get(index) ?? 0) > 1) {
          if (mode === "scan-owner-drift") driver.collectionId = "other";
          if (mode === "scan-step-drift") driver.step = "installing";
          if (mode === "scan-preparation-drift") driver.preparing = true;
        }
      }
      const text =
        (mode === "stacked-dialogs" && index === 0) ||
        (mode === "dialog-drift" && (scopedReads.get(index) ?? 0) > 1)
          ? otherDialog
          : collectionDialog;
      latestRef = `start-${String(index)}-${String(++generation)}`;
      const buttons = [
        {
          ref: latestRef,
          role: "button",
          name: "Install Now",
          disabled: mode === "disabled-button",
        },
      ];
      if (mode === "duplicate-buttons") buttons.push({ ...buttons[0]!, ref: "duplicate" });
      // Model the actual failure: the root snapshot stops in the mod library;
      // the separately scoped dialog contains the visible footer button.
      return {
        generation,
        title: "Vortex",
        viewport: { width: 1280, height: 800 },
        nodeCount: args?.selector === undefined ? 1500 : 1,
        truncated: args?.selector === undefined,
        activeDialogs: [text],
        rootText: args?.selector === undefined ? undefined : text,
        tree:
          args?.selector === undefined
            ? [{ ref: "background", role: "button", name: "Remove" }]
            : buttons,
      };
    }
    if (tool === "ui_click") {
      expect(args?.ref).toBe(latestRef);
      if (mode === "click-error") throw new Error("Native click rejected");
      driver.step = "installing";
      if (mode === "wrong-click-target") return { role: "text", name: "Install Now" };
      return { role: "button", name: "Install Now" };
    }
    if (tool === "collection_install_state") {
      observations++;
      if (observations === 3) {
        if (mode === "preparation-changes") driver.preparing = true;
        if (mode === "preparation-unobservable") driver.preparing = null;
        if (mode === "query-vanishes") driver.step = "installing";
      }
      if (mode === "changed-owner" && observations >= 3) driver.collectionId = "other";
      return { driver, session: null };
    }
    if (tool === "vortex_query") {
      if (args?.selector === "activeGameId") return "skyrimse";
      const route = ((args?.path ?? []) as string[]).join("/");
      if (route.endsWith("isPremium")) return true;
      if (route.endsWith("maxParallelDownloads")) return 10;
      return added ? { pinned: mod } : {};
    }
    if (tool === "vortex_dispatch") {
      if (args?.action === "start-download") {
        added = true;
        return;
      }
      if (args?.action === "resume-collection") {
        if (mode === "dispatch-error")
          throw new Error("Already installing a collection: transport rejected dispatch");
        if (driver.collectionId !== undefined) {
          warning = true;
          return;
        }
        driver.collectionId = "pinned";
        driver.step = "start";
      }
      return;
    }
    if (tool === "collection_status")
      return [
        {
          collectionModId: "pinned",
          required: 1,
          satisfied: 1,
          complete: true,
          optional: 0,
          optionalSelected: 0,
          optionalIgnored: 0,
          optionalSatisfied: 0,
        },
      ];
    throw new Error(`Unexpected tool ${tool}`);
  });
  const outcome = installCollection(
    { call } as unknown as VortexMcpClient,
    "nxm://skyrimspecialedition/collections/wanted/revisions/2",
    {
      autoAnswer: false,
      warningsAsErrors: true,
      timeoutMs: 12_000,
      verifyCompletion: async () => undefined,
    },
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(13_000);
  const result = await outcome;
  const fails = [
    "foreign",
    "foreign-review",
    "dispatch-error",
    "click-error",
    "changed-owner",
    "fresh-unclaimed",
    "unknown-preparation",
    "missing-preparation",
    "collectionless-start",
    "preparation-unobservable",
    "missing-dialog",
    "ambiguous-dialogs",
    "duplicate-buttons",
    "disabled-button",
    "dialog-drift",
    "snapshot-error",
    "scan-owner-drift",
    "scan-step-drift",
    "scan-preparation-drift",
    "wrong-click-target",
  ].includes(mode);
  expect(result).toHaveProperty(
    fails ? "error" : "value.complete",
    fails ? expect.any(Error) : true,
  );
  const resumes = call.mock.calls.filter(([, args]) => args?.action === "resume-collection");
  expect(resumes).toHaveLength(["idle", "dispatch-error", "closed-review"].includes(mode) ? 1 : 0);
  const clicks = call.mock.calls.filter(([tool]) => tool === "ui_click");
  expect(clicks).toHaveLength(
    [
      "query",
      "preparing",
      "fresh",
      "click-error",
      "preparation-changes",
      "stacked-dialogs",
      "wrong-click-target",
    ].includes(mode)
      ? 1
      : 0,
  );
  if (clicks.length > 0) {
    expect(
      call.mock.calls.filter(
        ([tool, args]) => tool === "ui_snapshot" && args?.selector === undefined,
      ),
    ).toEqual([]);
    expect(clicks[0]![1]?.ref).toMatch(mode === "stacked-dialogs" ? /^start-1-/ : /^start-0-/);
  }
  if ("value" in result) expect(result.value.warnings).toEqual([]);
  if (mode === "dispatch-error" && "error" in result)
    expect(result.error.message).toContain("transport rejected dispatch");
  if (mode === "click-error" && "error" in result)
    expect(result.error.message).toBe("Native click rejected");
  if (mode === "fresh-unclaimed")
    expect(call.mock.calls.filter(([, args]) => args?.action === "view-collection")).toHaveLength(
      1,
    );
});
