import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessConfig } from "./config";
import { ensureGameManaged, waitForGameStartup } from "./gameSetup";
import type { VortexMcpClient } from "./mcpClient";
import { clickByName, type SnapshotNode } from "./uiDriver";

vi.mock("./uiDriver", async (original) => ({
  ...(await original<typeof import("./uiDriver")>()),
  clickByName: vi.fn(),
}));

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native game startup dialog handling", () => {
  it("captures a watcher failure immediately but drains the pending native query before rejecting", async () => {
    vi.useFakeTimers();
    const failure = new Error("dialog transport unavailable");
    let completeQuery!: (value: string) => void;
    const query = new Promise<string>((resolve) => {
      completeQuery = resolve;
    });
    const call = vi.fn(async (tool: string) => {
      if (tool === "ui_active_dialogs") throw failure;
      return query;
    });
    let settled = false;
    const outcome = waitForGameStartup({ call } as unknown as VortexMcpClient, "private-game")
      .catch((error: unknown) => error)
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    completeQuery("private-game");
    expect(await outcome).toBe(failure);
    expect(call.mock.calls.filter(([tool]) => tool === "vortex_query")).toHaveLength(1);
  });

  it("stops activation polling after a dialog watcher failure", async () => {
    vi.useFakeTimers();
    const failure = new Error("dialog transport unavailable");
    const call = vi.fn(async (tool: string) => {
      if (tool === "ui_active_dialogs") throw failure;
      return null;
    });
    let settled = false;
    const outcome = waitForGameStartup({ call } as unknown as VortexMcpClient, "private-game")
      .catch((error: unknown) => error)
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(2000);
    expect(call.mock.calls.filter(([tool]) => tool === "vortex_query")).toHaveLength(1);
    expect(settled).toBe(true);
    expect(await outcome).toBe(failure);
  });

  it("retains a separate UI activation failure and the already captured watcher failure", async () => {
    vi.useFakeTimers();
    const gamePath = fs.mkdtempSync(path.join(os.tmpdir(), "doodlebot-game-startup-"));
    roots.push(gamePath);
    fs.writeFileSync(path.join(gamePath, "game.exe"), "private fixture");
    const original = new Error("game UI activation failed");
    const watcher = new Error("dialog transport unavailable");
    let failClick!: (error: Error) => void;
    const click = new Promise<SnapshotNode>((_resolve, reject) => {
      failClick = reject;
    });
    vi.mocked(clickByName).mockImplementation(() => click);
    const call = vi.fn(async (tool: string, args?: { path?: string[] }) => {
      if (tool === "ui_active_dialogs") throw watcher;
      if (tool === "ui_click") throw new Error("stable navigation selector absent");
      if (args?.path?.includes("discovered")) return { path: gamePath };
      return {};
    });
    const outcome = ensureGameManaged({ call } as unknown as VortexMcpClient, "vortexaisandbox", {
      gamePath,
      config: {} as HarnessConfig,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clickByName).toHaveBeenCalledTimes(1);
    failClick(original);
    const failure = await outcome;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original, watcher]);
    expect((failure as Error).cause).toBe(original);
  });

  it("finishes successful native activation and drains the dialog watcher", async () => {
    vi.useFakeTimers();
    const call = vi.fn(async (tool: string) => (tool === "vortex_query" ? "private-game" : []));
    const outcome = waitForGameStartup({ call } as unknown as VortexMcpClient, "private-game");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe(true);
    expect(call.mock.calls.filter(([tool]) => tool === "ui_active_dialogs")).toHaveLength(0);
  });
});
