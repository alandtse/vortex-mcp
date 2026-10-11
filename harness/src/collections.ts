/**
 * Installing a Nexus collection, unattended.
 *
 * A collection is not a mod — it is a manifest of mods plus their rules, and
 * Vortex installs it through a driver that downloads each member in turn. The
 * whole flow needs Nexus OAuth from initial setup; see
 * AGENTS.md.
 *
 * The entry point is the same `start-download` event Vortex's own "Add to
 * Vortex" button uses (collections/index.ts). The `modInfo.nexus.ids` payload
 * is not optional decoration: Vortex recognises a download as a collection by
 * those ids, and without them the collection-completed event never fires and the
 * download sits there looking like an ordinary archive.
 */
import type { VortexMcpClient } from "./mcpClient";
import { isDeepStrictEqual } from "node:util";
import { requireOAuth } from "./auth";
import { nexusCollectionDomain, vortexCollectionGameId } from "./collectionIdentity";
import {
  collectionTerminalFailure,
  type CollectionInstallObservation,
} from "./collectionTerminalFailure";
import {
  autoAdvanceFomods,
  autoAnswerDialogs,
  dialogPolicies,
  snapshot,
  snapshotIfPresent,
  openDialogs,
  clickInsideDialog,
  findNodes,
  findOne,
  snapshotIsDialog,
  type AnsweredDialog,
} from "./uiDriver";
import { withUiLock } from "./uiSession";

export class CollectionError extends Error {}
export interface CollectionWarning {
  id: string;
  source: "notification" | "session" | "download";
  at: number;
  message: string;
  originalSeverity: "error" | "warning";
}
const noticeIdentity = (notice: { id: string; type?: string; title?: string; message?: string }) =>
  JSON.stringify([notice.id, notice.type, notice.title, notice.message]);

export interface CollectionRef {
  gameId: string;
  slug: string;
  /** Omitted means "latest", which Vortex resolves itself. */
  revision?: number;
}

/**
 * Parse the collection URLs people actually have to hand.
 *
 * Accepts the website form (`next.nexusmods.com/<game>/collections/<slug>`,
 * optionally `/revisions/<n>`) and the `nxm://` form the "Add to Vortex" button
 * produces, plus a bare `<game>/<slug>`.
 */
export function parseCollectionRef(input: string): CollectionRef {
  const trimmed = input.trim();

  const nxm =
    /^nxm:\/\/([a-z0-9]+)\/collections\/([a-z0-9_-]+)(?:\/revisions\/(\d+))?\/?(?:[?#].*)?$/i.exec(
      trimmed,
    );
  if (nxm?.[1] !== undefined && nxm[2] !== undefined) {
    return {
      gameId: vortexCollectionGameId(nxm[1]),
      slug: nxm[2],
      revision: nxm[3] === undefined ? undefined : Number(nxm[3]),
    };
  }

  const web =
    /^https:\/\/(?:next\.|www\.)?nexusmods\.com\/(?:games\/)?([a-z0-9]+)\/collections\/([a-z0-9_-]+)(?:\/revisions\/(\d+))?\/?(?:[?#].*)?$/i.exec(
      trimmed,
    );
  if (web?.[1] !== undefined && web[2] !== undefined) {
    return {
      gameId: vortexCollectionGameId(web[1]),
      slug: web[2],
      revision: web[3] === undefined ? undefined : Number(web[3]),
    };
  }

  const bare = /^([a-z0-9]+)\/([A-Za-z0-9_-]+)$/.exec(trimmed);
  if (bare?.[1] !== undefined && bare[2] !== undefined) {
    return { gameId: vortexCollectionGameId(bare[1]), slug: bare[2] };
  }

  throw new CollectionError(
    `Could not read "${input}" as a collection.\n\n` +
      `  Expected one of:\n` +
      `    https://next.nexusmods.com/fallout4/collections/<slug>\n` +
      `    nxm://fallout4/collections/<slug>/revisions/<n>\n` +
      `    fallout4/<slug>`,
  );
}

export function toNxmUrl(ref: CollectionRef): string {
  const base = `nxm://${nexusCollectionDomain(ref.gameId)}/collections/${ref.slug}`;
  return ref.revision === undefined ? base : `${base}/revisions/${String(ref.revision)}`;
}

export interface ResolvedCollection extends CollectionRef {
  collectionId: number;
  revisionId: number;
  revisionNumber: number;
  name: string;
  modCount: number;
}

/**
 * Look the collection up on Nexus to get its real ids.
 *
 * Vortex's own "Add to Vortex" button passes collectionId, revisionId and
 * revisionNumber alongside the nxm URL, and it needs them: given only a slug the
 * download never resolves — no error, no download, nothing at all, which is a
 * miserable thing to debug. This is the public GraphQL API and needs no token,
 * so resolution works before the instance is even logged in.
 */
export async function resolveCollection(ref: CollectionRef): Promise<ResolvedCollection> {
  if (ref.revision !== undefined && (!Number.isInteger(ref.revision) || ref.revision < 1))
    throw new CollectionError("Collection revision must be a positive integer.");
  const query = `query($slug: String!, $game: String!${ref.revision === undefined ? "" : ", $revision: Int!"}) {
    collection(slug: $slug, domainName: $game, viewAdultContent: true) { id name currentRevision { id revisionNumber modCount } }
    ${ref.revision === undefined ? "" : "requested: collectionRevision(slug: $slug, revision: $revision, viewAdultContent: true) { id revisionNumber modCount }"}
  }`;

  const response = await fetch("https://api.nexusmods.com/v2/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "vortex-mcp-harness/1.0" },
    body: JSON.stringify({
      query,
      variables: {
        slug: ref.slug,
        game: nexusCollectionDomain(ref.gameId),
        ...(ref.revision === undefined ? {} : { revision: ref.revision }),
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new CollectionError(
      `Nexus returned ${String(response.status)} looking up ${ref.gameId}/${ref.slug}.`,
    );
  }

  const body = (await response.json()) as {
    data?: {
      requested?: { id: number; revisionNumber: number; modCount: number } | null;
      collection?: {
        id: number;
        name: string;
        currentRevision?: { id: number; revisionNumber: number; modCount: number };
      } | null;
    };
    errors?: { message: string }[];
  };

  if (body.errors !== undefined && body.errors.length > 0) {
    throw new CollectionError(`Nexus rejected the lookup: ${body.errors[0]?.message ?? "unknown"}`);
  }
  const collection = body.data?.collection;
  const revision = ref.revision === undefined ? collection?.currentRevision : body.data?.requested;
  if (collection == null || revision == null) {
    throw new CollectionError(
      `No collection "${ref.slug}" for ${ref.gameId} on Nexus. Check the URL — the slug is the ` +
        `short code at the end, e.g. .../collections/pmmttm.`,
    );
  }

  return {
    ...ref,
    gameId: vortexCollectionGameId(ref.gameId),
    collectionId: collection.id,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    name: collection.name,
    modCount: revision.modCount,
  };
}

export interface InstallCollectionOptions {
  /** Fail on any observed collection warning. Default false; final completion is still required. */
  warningsAsErrors?: boolean;
  onWarning?: (warning: CollectionWarning) => void;
  /** Optional pinned listed count; required-member completion is checked separately. */
  expectedListedMods?: number;
  /** How long to allow for the whole download+install. Collections are big. */
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  /** Answer blocking modals automatically. Defaults to true. */
  autoAnswer?: boolean;
  /** Keep the optional-member choice applied through driver metadata refreshes. */
  optionalMods?: "skip" | "install";
  /** Surface instrumentation failure at each collection progress poll. */
  verifyProgress?: () => void;
  /** Final functional/UI boundary. Required to accept warnings; automation remains active. */
  verifyCompletion?: (collectionModId: string, remainingMs: number) => Promise<void>;
}

export interface InstallCollectionResult {
  warnings: CollectionWarning[];
  ref: CollectionRef;
  modId: string | undefined;
  /** Member mods actually installed. */
  modCount: number;
  /** Members the collection *requires*; optional ones are not counted. */
  expectedModCount: number;
  complete: boolean;
  answeredDialogs: AnsweredDialog[];
  downloadThreads: DownloadThreads;
  optionalMods: "skip" | "install";
  optionalCount: number;
  optionalSatisfied: number;
}

export interface DownloadThreads {
  previous: number;
  threads: number;
  premium: boolean;
}

/** Use Vortex's supported maximum: ten Premium download threads, one for a free account. */
export async function maximizeDownloadThreads(mcp: VortexMcpClient): Promise<DownloadThreads> {
  const premium = await mcp.call<unknown>("vortex_query", {
    path: ["persistent", "nexus", "userInfo", "isPremium"],
  });
  if (typeof premium !== "boolean")
    throw new CollectionError(
      "Nexus membership status is unavailable; finish account setup before configuring collection downloads",
    );
  const previous = await mcp.call<number>("vortex_query", {
    path: ["settings", "downloads", "maxParallelDownloads"],
  });
  const threads = premium ? 10 : 1;
  await mcp.call("vortex_dispatch", { action: "type:SET_MAX_DOWNLOADS", args: [threads] });
  const actual = await mcp.call<number>("vortex_query", {
    path: ["settings", "downloads", "maxParallelDownloads"],
  });
  if (actual !== threads)
    throw new CollectionError(`Vortex did not apply ${String(threads)} download threads`);
  return { previous, threads, premium };
}

interface CollectionRule {
  /** "requires" for a member that must install, "recommends" for an optional one. */
  type: string;
  ignored?: boolean;
  reference: Record<string, unknown> & { description?: string; logicalFileName?: string };
}

interface CollectionMod {
  id: string;
  name?: string;
  type?: string;
  /** "installing" until the installer finishes, then "installed". */
  state?: string;
  attributes?: { collectionSlug?: string; revisionNumber?: number };
  rules?: CollectionRule[];
}

/**
 * How many member mods installing this collection should actually produce.
 *
 * Nexus's `modCount` counts everything the collection lists, optional mods
 * included, and Vortex only installs the required ones. Waiting for `modCount`
 * therefore waits for mods that are never coming: the FallUI Series collection
 * reports 11 and installs 8, so a complete install looked like a stall and then
 * a timeout. The collection mod's own `requires` rules are what Vortex works
 * from, so count those and fall back to `modCount` only before they exist.
 */
function requiredMemberCount(collectionMod: CollectionMod, fallback: number): number {
  const required = (collectionMod.rules ?? []).filter((r) => r.type === "requires");
  return required.length > 0 ? required.length : fallback;
}

/**
 * Download and install a collection, waiting for it to actually finish.
 *
 * Four steps, and skipping any of them leaves the collection looking installed
 * when it is not:
 *
 *   1. Resolve the collection on Nexus for its real ids.
 *   2. Download it. This installs the *collection mod* — a manifest — and
 *      nothing else. Vortex reports "Collection incomplete" at this point.
 *   3. Start the install driver, which is what pulls down the member mods. The
 *      UI gates this behind an "Install Now" button; there is no event that
 *      skips it, so the harness clicks it.
 *   4. Wait for the members. The download callback fires at the end of step 2,
 *      so treating it as completion is the mistake that makes a collection look
 *      installed with zero mods in it.
 *
 * Blocking modals are answered throughout, not at fixed points: the version
 * mismatch appears before the first mod, the purge prompt partway through, and
 * a cancellation confirm can appear at any time.
 */
export async function installCollection(
  mcp: VortexMcpClient,
  input: string,
  options: InstallCollectionOptions = {},
): Promise<InstallCollectionResult> {
  const ref = parseCollectionRef(input);
  const report = options.onProgress ?? ((): void => undefined);
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new CollectionError("Collection installation exceeded the overall timeout");
    return ms;
  };
  const optionalMods = options.optionalMods ?? "skip";
  const warnings: CollectionWarning[] = [];
  const observeWarning = (warning: CollectionWarning) => {
    if (!warnings.some((prior) => prior.source === warning.source && prior.id === warning.id)) {
      warnings.push(warning);
      options.onWarning?.(warning);
    }
    if (options.warningsAsErrors === true)
      throw new CollectionError(
        "Collection warning treated as an error: " +
          warning.message +
          ". Doodlebot does not retry failed installs. The profile and downloads are preserved.",
      );
  };

  // `isLoggedIn` is not the right question here. Vortex defines it as
  // `truthy(APIKey) || truthy(OAuthCredentials)`, so an API key alone satisfies
  // it — but this build authenticates collection downloads with OAuth, and an
  // API key gets a 401 surfaced as "You are not logged in to Nexus Mods!" well
  // after the download has been dispatched. Ask for what is actually needed.
  await requireOAuth(mcp);
  const activeGame = await mcp.call<string | null>("vortex_query", { selector: "activeGameId" });
  if (activeGame !== ref.gameId)
    throw new CollectionError(
      `Collection is for ${ref.gameId}, but the active game is ${activeGame ?? "none"}. Start the matching game before installation.`,
    );

  const controller = new AbortController();
  const previousErrors = new Set(
    (
      await mcp.call<{ id: string; type?: string; title?: string; message?: string }[]>(
        "list_notifications",
      )
    ).map(noticeIdentity),
  );
  const answeredDialogs: AnsweredDialog[] = [];
  let automationFailure: unknown;
  const recordAutomationFailure = (error: unknown) => {
    automationFailure ??= error;
    controller.abort();
  };
  const assertAutomationHealthy = () => {
    if (automationFailure !== undefined) throw automationFailure;
  };
  let ownedCollectionId: string | undefined;
  let optionalRoundStarted = false;
  const answeringPolicies = dialogPolicies({ optionalMods });
  const answering =
    options.autoAnswer === false
      ? Promise.resolve([])
      : autoAnswerDialogs(mcp, {
          policies: answeringPolicies,
          signal: controller.signal,
          pollMs: 1_500,
          canAnswer: async (dialog) => {
            if (
              options.warningsAsErrors === true &&
              (await collectionErrors(mcp, previousErrors)).length > 0
            )
              return false;
            const completedReview = /collection installation complete/i.test(dialog);
            if (ownedCollectionId === undefined) return !completedReview;
            if (
              (
                await mcp.call<unknown[]>("collection_download_failures", {
                  gameId: ref.gameId,
                  collectionModId: ownedCollectionId,
                })
              ).length > 0
            )
              return false;
            if (!completedReview) return true;
            // The watcher runs faster than the completion poll. Read its own
            // owned review boundary before a click can start another round.
            const native = await mcp.call<CollectionInstallObservation>("collection_install_state");
            if (
              native.driver?.found !== true ||
              native.driver.collectionId !== ownedCollectionId ||
              native.driver.step !== "review" ||
              (native.session &&
                (native.session.collectionId !== ownedCollectionId ||
                  native.session.gameId !== ref.gameId)) ||
              !native.dialogs?.some(
                (d) =>
                  d.collectionId === ownedCollectionId &&
                  (d.via === "driver" || d.via === "collection-prop") &&
                  d.step === "review" &&
                  /^collection installation complete/i.test(d.text ?? ""),
              )
            )
              return false;
            if ((native.session?.statusCounts.failed ?? 0) > 0) return false;
            const statuses = await mcp.call<CollectionCompleteness[]>("collection_status", {
              gameId: ref.gameId,
            });
            const status = statuses.find((entry) => entry.collectionModId === ownedCollectionId);
            if (!status?.complete) return false;
            const optionalIncomplete = status.optionalSatisfied < status.optional;
            if (optionalMods === "install" && !optionalIncomplete)
              for (const policy of answeringPolicies)
                if (/collection installation complete/i.test(policy.match.source))
                  policy.button = /^done$/i;
            if (
              collectionTerminalFailure(
                native,
                ref.gameId,
                ownedCollectionId,
                optionalMods,
                optionalIncomplete,
              )
            )
              return false; // The completion poll records warnings and fails the attempt.
            return !(optionalMods === "install" && optionalRoundStarted && optionalIncomplete);
          },
          onAnswer: (a) => {
            if (/^install optional mods$/i.test(a.clicked)) {
              optionalRoundStarted = true;
              for (const policy of answeringPolicies)
                if (/collection installation complete/i.test(policy.match.source))
                  policy.button = /^done$/i;
            }
            answeredDialogs.push(a);
            report(`answered [${a.clicked}] ${a.dialog.slice(0, 55)}`);
          },
          onUnanswerable: (d, wanted) =>
            report(`STUCK: no button matching ${wanted} in "${d.slice(0, 60)}"`),
        }).catch((error: unknown) => {
          recordAutomationFailure(error);
          return [];
        });
  // Member mods ship FOMOD installers that block the driver until someone picks
  // options. Unattended is the whole point of this function, so accept their
  // defaults; the collection manifest already encodes the curator's choices.
  const advancing =
    options.autoAnswer === false
      ? Promise.resolve()
      : autoAdvanceFomods(mcp, {
          signal: controller.signal,
          onAdvance: (label) => report(`fomod step [${label}]`),
        }).catch((error: unknown) => {
          recordAutomationFailure(error);
          return 0;
        });
  let operationFailed = false;
  try {
    const resolved = await resolveCollection(ref);
    assertAutomationHealthy();
    if (ref.revision !== undefined && resolved.revisionNumber !== ref.revision)
      throw new CollectionError("Nexus resolved a different revision than the requested pin");
    if (
      options.expectedListedMods !== undefined &&
      resolved.modCount !== options.expectedListedMods
    )
      throw new CollectionError(
        `Pinned collection listed count differs: expected ${options.expectedListedMods}, received ${resolved.modCount}`,
      );
    report(
      `${resolved.name} — revision ${String(resolved.revisionNumber)}, ${String(resolved.modCount)} mods`,
    );
    const downloadThreads = await maximizeDownloadThreads(mcp);
    report(`Download threads: ${String(downloadThreads.threads)} (account-supported maximum)`);

    const exactRef = { ...ref, revision: resolved.revisionNumber };
    const existing = await findCollectionMod(mcp, exactRef);
    if (existing === undefined) {
      assertAutomationHealthy();
      const url = toNxmUrl({ ...ref, revision: resolved.revisionNumber });
      report(`downloading ${url}`);
      await startCollectionDownload(mcp, ref, resolved, url);
      await waitForCollectionMod(mcp, exactRef, Math.min(remaining(), 15 * 60 * 1000), report);
    } else {
      report("collection already added");
    }

    const collectionMod = await waitForCollectionMod(
      mcp,
      exactRef,
      Math.min(remaining(), 60_000),
      report,
    );
    const optionalCount = await selectOptionalMembers(mcp, exactRef, collectionMod, optionalMods);
    ownedCollectionId = collectionMod.id;
    report(
      `${optionalMods === "install" ? "Selected" : "Skipped"} ${optionalCount} optional members`,
    );
    if (options.autoAnswer !== false)
      answeredDialogs.push(...(await confirmCollectionProfile(mcp)));
    await observeCollectionWarnings(
      mcp,
      previousErrors,
      ref.gameId,
      collectionMod.id,
      observeWarning,
    );
    assertAutomationHealthy();
    await startInstallDriver(
      mcp,
      ref,
      collectionMod.id,
      report,
      deadline,
      assertAutomationHealthy,
      existing === undefined,
    );

    const expected = requiredMemberCount(collectionMod, resolved.modCount);
    if (expected !== resolved.modCount) {
      report(`${String(expected)} of the ${String(resolved.modCount)} listed mods are required`);
    }
    const status = await waitForCompletion(
      mcp,
      exactRef,
      collectionMod.id,
      remaining(),
      report,
      previousErrors,
      async () => {
        assertAutomationHealthy();
        options.verifyProgress?.();
        if (options.autoAnswer !== false)
          answeredDialogs.push(...(await confirmCollectionProfile(mcp)));
      },
      optionalMods,
      { required: expected, optional: optionalCount },
      observeWarning,
    );
    assertNoFailedCollectionMembers(
      await observeCollectionWarnings(
        mcp,
        previousErrors,
        ref.gameId,
        collectionMod.id,
        observeWarning,
      ),
    );
    if (options.autoAnswer !== false) {
      for (const dialog of (await snapshot(mcp)).activeDialogs) {
        if (/collection installation complete/i.test(dialog))
          // Best effort: the dialog watcher answers the same prompt if this misses it.
          await clickInsideDialog(
            mcp,
            dialog,
            optionalMods === "install" ? /^done$/i : /^(no thanks|done)$/i,
            { required: false },
          );
      }
    }

    await options.verifyCompletion?.(collectionMod.id, remaining());
    const finalState = await observeCollectionWarnings(
      mcp,
      previousErrors,
      ref.gameId,
      collectionMod.id,
      observeWarning,
    );
    assertNoFailedCollectionMembers(finalState);
    if (warnings.length > 0 && options.verifyCompletion === undefined) {
      throw new CollectionError(
        "Collection has warnings but no final functional/UI completion verifier. Supply verifyCompletion to accept warnings; member counts alone cannot confirm a fully installed collection.",
      );
    }
    assertAutomationHealthy();
    remaining();

    return {
      warnings,
      ref,
      modId: collectionMod.id,
      modCount: status.satisfied,
      expectedModCount: status.required,
      complete: status.complete,
      answeredDialogs,
      downloadThreads,
      optionalMods,
      optionalCount,
      optionalSatisfied: status.optionalSatisfied,
    };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    controller.abort();
    await answering;
    await advancing;
    if (!operationFailed) assertAutomationHealthy();
  }
}

/** Use the same durable rule action as Vortex's optional-member selection UI. */
export async function selectOptionalMembers(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  collection: CollectionMod,
  choice: "skip" | "install",
): Promise<number> {
  const optional = (collection.rules ?? []).filter((rule) => rule.type === "recommends");
  const required = (collection.rules ?? []).filter((rule) => rule.type === "requires");
  if (
    optional.some((rule) =>
      required.some((member) => referencesMayReplace(rule.reference, member.reference)),
    )
  )
    throw new CollectionError(
      "Optional selection overlaps a required reference; refusing to replace a required rule",
    );
  const ignored = choice === "skip";
  for (const rule of optional) {
    if (rule.ignored === ignored) continue;
    await mcp.call("vortex_dispatch", {
      action: "addModRule",
      args: [ref.gameId, collection.id, { ...rule, ignored }],
    });
  }
  const actual = await findCollectionMod(mcp, ref);
  const rules = (actual?.rules ?? []).filter((rule) => rule.type === "recommends");
  if (
    JSON.stringify((actual?.rules ?? []).filter((rule) => rule.type === "requires")) !==
    JSON.stringify(required)
  )
    throw new CollectionError(
      "Optional selection changed required collection rules; installation is not verified",
    );
  if (
    actual?.id !== collection.id ||
    rules.length !== optional.length ||
    rules.some((rule) => rule.ignored !== ignored)
  )
    throw new CollectionError("Vortex did not persist the requested optional-member policy");
  return optional.length;
}

/** Conservative guard for stock addModRule's private referenceEqual contract.
 * Helper fields never distinguish rules. Equal IDs also block a write, even when
 * extra matching fields would distinguish them in a particular stock release.
 * Installed-member verification still uses the app's own findModByRef matcher.
 */
function referencesMayReplace(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  if (left.id !== undefined && left.id === right.id) return true;
  const important = ["fileMD5", "logicalFileName", "fileExpression", "versionMatch", "repo", "tag"];
  const pick = (reference: Record<string, unknown>) =>
    Object.fromEntries(
      important.filter((key) => reference[key] !== undefined).map((key) => [key, reference[key]]),
    );
  return isDeepStrictEqual(pick(left), pick(right));
}

/** Only the collection-added prompt asking to use its curated profile is approved.
 * Install-during-download and plugin-rule settings retain their existing defaults.
 */
export async function confirmCollectionProfile(mcp: VortexMcpClient): Promise<AnsweredDialog[]> {
  return withUiLock(mcp, async () => {
    // Summaries only decide whether a scoped inspection is needed; curator text
    // and truncated prefixes never authorize the click or identify its modal.
    if (!((await openDialogs(mcp)) ?? []).some((text) => /collection added/i.test(text))) return [];
    for (const selector of ['[role="dialog"]', ".modal.in", ".modal.show", "dialog[open]"]) {
      for (let index = 0; index < 4; index++) {
        const scoped = await snapshotIfPresent(mcp, selector, index);
        if (!scoped || scoped.nodeCount === 0) break;
        const buttons = findNodes(scoped, { role: "button", name: /^yes$/i });
        const button = buttons[0];
        if (buttons.length !== 1 || button === undefined) continue;

        try {
          const clicked = await mcp.call<{ name: string }>("ui_click", {
            ref: button.ref,
            confirmation: {
              titleSuffix: "collection added",
              question: "Do you want to switch to this profile?",
              button: "Yes",
              alternative: "No",
            },
          });
          if (clicked.name !== "Yes")
            throw new CollectionError("Profile confirmation clicked an unexpected control");
          return [
            {
              dialog: (scoped.rootText ?? "Collection profile confirmation").slice(0, 160),
              clicked: clicked.name,
              because:
                "Use the pinned collection's curated profile after its explicit collection-added confirmation",
            },
          ];
        } catch (error) {
          // The host rejects a mismatched candidate before clicking anything.
          // Continue inspecting other dialogs, but never repeat a failed action.
          if (
            !(error instanceof Error) ||
            !error.message.startsWith("Dialog confirmation rejected:")
          )
            throw error;
        }
      }
    }
    return [];
  });
}

async function startCollectionDownload(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  resolved: ResolvedCollection,
  url: string,
): Promise<void> {
  await mcp.call(
    "vortex_dispatch",
    {
      action: "start-download",
      args: [
        [url],
        {
          game: ref.gameId,
          source: "nexus",
          name: resolved.name,
          // Exactly what Vortex's own "Add to Vortex" button sends. These ids
          // are what make it a *collection* download rather than an archive.
          nexus: {
            ids: {
              gameId: ref.gameId,
              collectionId: resolved.collectionId,
              revisionId: resolved.revisionId,
              collectionSlug: ref.slug,
              revisionNumber: resolved.revisionNumber,
            },
          },
        },
        // fileName. Vortex's own collections code passes `undefined`, but newer
        // builds validate this event's arguments with zod and require a string —
        // and a rejected argument list means the handler never runs, so the
        // download silently never starts and the awaited callback never fires.
        `${ref.slug}-rev${String(resolved.revisionNumber)}.7z`,
        "__CALLBACK__",
      ],
    },
    15 * 60 * 1000,
  );
}

/**
 * Get the install driver moving.
 *
 * A newly installed manifest already opens Vortex's query flow. Observe its
 * exact driver instead of emitting a redundant resume, which generates a warning.
 * An existing manifest with an idle driver can be started once. Failed actions
 * propagate; waiting for the driver's normal startup does not repeat them.
 */
async function startInstallDriver(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  modId: string,
  report: (message: string) => void,
  deadline: number,
  assertAutomationHealthy: () => void,
  newlyAdded: boolean,
): Promise<void> {
  type Driver = {
    found?: boolean;
    collectionId?: string;
    lastCollectionId?: string;
    step?: string;
    installDone?: boolean;
    preparing?: boolean | null;
  };
  const observe = async (): Promise<Driver> => {
    assertAutomationHealthy();
    const state = await mcp.call<{ driver?: Driver }>("collection_install_state");
    const driver = state.driver ?? {};
    if (driver.found && driver.collectionId !== undefined && driver.collectionId !== modId)
      throw new CollectionError(
        "Another collection owns the install driver; doodlebot will not start or click its controls",
      );
    return driver;
  };
  const waitingUntil = Math.min(deadline, Date.now() + 60_000);
  let requestedView = false;
  let driver: Driver;
  for (;;) {
    driver = await observe();
    if (
      driver.found &&
      driver.preparing === false &&
      (driver.collectionId === modId ||
        (!newlyAdded &&
          driver.collectionId === undefined &&
          (driver.step === "prepare" || (driver.step === "review" && driver.installDone === true))))
    )
      break;
    if (Date.now() >= waitingUntil)
      throw new CollectionError(
        "The requested collection's install driver did not become observable before startup timeout",
      );
    if (!requestedView) {
      await mcp.call("vortex_dispatch", { action: "view-collection", args: [modId] });
      requestedView = true;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, waitingUntil - Date.now())));
  }
  if (driver.collectionId === undefined) {
    if (Date.now() >= deadline)
      throw new CollectionError("Collection installation exceeded the overall timeout");
    await mcp.call(
      "vortex_dispatch",
      { action: "resume-collection", args: [ref.gameId, modId] },
      Math.min(120_000, deadline - Date.now()),
    );
  } else report("Vortex already owns this collection's install flow");

  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(4_000, Math.max(0, deadline - Date.now()))),
  );
  if (Date.now() >= deadline)
    throw new CollectionError("Collection installation exceeded the overall timeout");

  driver = await observe();
  while (driver.preparing !== false) {
    if (Date.now() >= waitingUntil)
      throw new CollectionError(
        "Collection driver preparation did not become observable and settle before startup timeout",
      );
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, waitingUntil - Date.now())));
    driver = await observe();
  }
  if (
    !driver.found ||
    (driver.collectionId !== modId &&
      !(
        driver.collectionId === undefined &&
        driver.lastCollectionId === modId &&
        driver.step === "review" &&
        driver.installDone === true
      ))
  )
    throw new CollectionError(
      "The install driver does not own the requested collection after startup",
    );
  if (driver.step === "query") {
    await withUiLock(mcp, async () => {
      const dialogs = (await openDialogs(mcp)).filter((text) => /collection added/i.test(text));
      if (dialogs.length !== 1)
        throw new CollectionError(
          `Expected one collection-added dialog before starting installation, found ${String(dialogs.length)}`,
        );
      // Large mod libraries exhaust a full-page snapshot before the modal footer.
      // Scope the lookup to the owned driver's dialog and make only one click.
      const dialogText = dialogs[0]!;
      for (const selector of ['[role="dialog"]', ".modal.in", ".modal.show", "dialog[open]"]) {
        const matches: number[] = [];
        for (let index = 0; index <= 4; index++) {
          const scoped = await snapshotIfPresent(mcp, selector, index);
          if (scoped === undefined || scoped.nodeCount === 0) break;
          if (index === 4)
            throw new CollectionError(
              "Too many open dialog containers to identify collection startup",
            );
          if (snapshotIsDialog(scoped, dialogText)) matches.push(index);
        }
        // Active dialog text is deduplicated; inspect physical containers too.
        if (matches.length > 1)
          throw new CollectionError("Ambiguous collection-added dialog containers");
        if (matches.length === 0) continue;
        // Scanning invalidates refs. Re-snapshot and revalidate before the one action.
        const scoped = await snapshot(mcp, selector, matches[0]);
        if (!snapshotIsDialog(scoped, dialogText))
          throw new CollectionError("Collection-added dialog changed before startup");
        const target = findOne(scoped, { role: "button", name: /^install now$/i });
        const currentDriver = await observe();
        if (
          currentDriver.found !== true ||
          currentDriver.collectionId !== modId ||
          currentDriver.preparing !== false ||
          currentDriver.step !== "query"
        )
          throw new CollectionError("Collection install driver changed before startup click");
        const clicked = await mcp.call<{ name?: string; role?: string }>("ui_click", {
          ref: target.ref,
        });
        if (clicked?.role !== "button" || !/^install now$/i.test(clicked.name ?? ""))
          throw new CollectionError("Collection startup click did not target Install Now");
        return;
      }
      throw new CollectionError("Collection-added dialog container is missing");
    });
    report("clicked Install Now");
  } else report("driver already started; no additional start action");
}

export async function findCollectionMod(
  mcp: VortexMcpClient,
  ref: CollectionRef,
): Promise<CollectionMod | undefined> {
  const mods = await mcp.call<Record<string, CollectionMod> | null>("vortex_query", {
    path: ["persistent", "mods", ref.gameId],
  });
  return Object.values(mods ?? {}).find(
    (m) =>
      m.type === "collection" &&
      m.attributes?.collectionSlug === ref.slug &&
      (ref.revision === undefined || Number(m.attributes.revisionNumber) === ref.revision),
  );
}

async function waitForCollectionMod(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  timeoutMs: number,
  report: (message: string) => void,
): Promise<CollectionMod> {
  const started = Date.now();
  for (;;) {
    const found = await findCollectionMod(mcp, ref);
    if (found !== undefined) return found;
    if (Date.now() - started > timeoutMs) {
      throw new CollectionError(
        `The collection archive for "${ref.slug}" never finished downloading. ` +
          `Check list_notifications and list_dialogs — a modal may be waiting.`,
      );
    }
    report("waiting for the collection archive");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

export interface CollectionRuleStatus {
  reference: string;
  modId?: string;
  satisfied: boolean;
  installedButDisabled: boolean;
}

export interface CollectionCompleteness {
  collectionModId: string;
  name: string;
  complete: boolean;
  required: number;
  satisfied: number;
  unsatisfied: CollectionRuleStatus[];
  optional: number;
  optionalSatisfied: number;
  optionalIgnored: number;
  optionalSelected: number;
  optionalUnsatisfied: CollectionRuleStatus[];
}

/**
 * Wait until Vortex itself calls the collection complete.
 *
 * Counting installed mods is not the same question, and getting that wrong is
 * what made this report success on a half-finished install. Vortex resolves
 * every required rule through its own reference matcher and additionally
 * requires the matched mod to be enabled in the active profile, so a collection
 * can have every member installed, correctly named, with nothing left
 * installing — and still be Incomplete.
 *
 * `collection_status` runs that exact check inside the app, so this waits on
 * the same answer the Collections page displays rather than a proxy for it.
 */
async function waitForCompletion(
  mcp: VortexMcpClient,
  ref: CollectionRef,
  collectionModId: string,
  timeoutMs: number,
  report: (message: string) => void,
  previousErrors: Set<string>,
  confirmProfile?: () => Promise<void>,
  optionalMods: "skip" | "install" = "skip",
  expectedMembers?: { required: number; optional: number },
  observeWarning: (warning: CollectionWarning) => void = () => undefined,
): Promise<CollectionCompleteness> {
  const started = Date.now();
  let last = "";
  let lastChange = Date.now();
  const verifyCounts = (counts: { required: number; optional: number }) => {
    if (
      expectedMembers !== undefined &&
      (counts.required !== expectedMembers.required || counts.optional !== expectedMembers.optional)
    )
      throw new CollectionError("Collection member counts changed during installation");
  };

  for (;;) {
    if (Date.now() - started > timeoutMs)
      throw new CollectionError("Collection installation exceeded the overall timeout");
    const observation = await observeCollectionWarnings(
      mcp,
      previousErrors,
      ref.gameId,
      collectionModId,
      observeWarning,
    );
    await confirmProfile?.();
    const all = await mcp.call<CollectionCompleteness[]>("collection_status", {
      gameId: ref.gameId,
    });
    let status = all.find((entry) => entry.collectionModId === collectionModId);

    if (status !== undefined) {
      verifyCounts(status);
      const terminalFailure = collectionTerminalFailure(
        observation.native,
        ref.gameId,
        collectionModId,
        optionalMods,
        status.optionalSatisfied < status.optional,
      );
      if (terminalFailure)
        throw new CollectionError(
          `${terminalFailure}: ${status.satisfied}/${status.required} required members; ` +
            `${status.optionalSatisfied}/${status.optional} optional members installed. ` +
            "Doodlebot does not retry failed installs. The profile, downloads and warning evidence are preserved.",
        );
      const selectionApplied =
        optionalMods === "skip"
          ? status.optionalIgnored === status.optional
          : status.optionalSelected === status.optional;
      if (!selectionApplied) {
        // Released Vortex can regenerate rules after resume-collection, dropping
        // the earlier selection. Repair only this exact manifest, then poll the
        // actual status again; an absent flag is not an explicit AE selection.
        const refreshed = await mcp.call<CollectionMod | undefined>("vortex_query", {
          path: ["persistent", "mods", ref.gameId, collectionModId],
        });
        if (
          refreshed?.id !== collectionModId ||
          refreshed.type !== "collection" ||
          refreshed.attributes?.collectionSlug !== ref.slug ||
          Number(refreshed.attributes.revisionNumber) !== ref.revision
        )
          throw new CollectionError("Collection identity changed during optional selection");
        verifyCounts({
          required: (refreshed.rules ?? []).filter((rule) => rule.type === "requires").length,
          optional: (refreshed.rules ?? []).filter((rule) => rule.type === "recommends").length,
        });
        if (
          (refreshed.rules ?? []).some((rule) => rule.type === "requires" && rule.ignored === true)
        )
          throw new CollectionError("Required collection member was ignored during installation");
        await selectOptionalMembers(mcp, ref, refreshed, optionalMods);
        report(`Reapplied ${optionalMods} policy after collection rules refreshed`);
        const repaired = await mcp.call<CollectionCompleteness[]>("collection_status", {
          gameId: ref.gameId,
        });
        status = repaired.find((entry) => entry.collectionModId === collectionModId);
        if (status === undefined)
          throw new CollectionError("Collection disappeared after optional selection");
        verifyCounts(status);
      }
      const optionalsDone =
        optionalMods === "skip"
          ? status.optionalIgnored === status.optional
          : status.optionalSelected === status.optional &&
            status.optionalIgnored === 0 &&
            status.optionalSatisfied === status.optional;
      if (status.complete && optionalsDone) {
        assertNoFailedCollectionMembers(observation);
        if (Date.now() - started >= timeoutMs)
          throw new CollectionError("Collection installation exceeded the overall timeout");
        report(`${String(status.satisfied)}/${String(status.required)} required mods — complete`);
        return status;
      }
      const line = `${status.satisfied}/${status.required} required mods satisfied; ${status.optionalSatisfied}/${status.optional} optional members installed (${optionalMods})`;
      if (line !== last) {
        last = line;
        lastChange = Date.now();
        report(line);
      }
    }

    if (Date.now() - started > timeoutMs) {
      const missing = [
        ...(status?.unsatisfied ?? []),
        ...(optionalMods === "install" ? (status?.optionalUnsatisfied ?? []) : []),
      ]
        .map(
          (u) => `    ${u.reference}${u.installedButDisabled ? "  (installed but disabled)" : ""}`,
        )
        .join("\n");
      throw new CollectionError(
        `"${ref.slug}" is still incomplete after ` +
          `${String(Math.round(timeoutMs / 60000))} minutes.\n\n` +
          `  Vortex still considers these rules unsatisfied:\n${missing}\n\n` +
          `  "installed but disabled" means the mod is there and switched off, which satisfies\n` +
          `  nothing; anything else never installed. Check list_dialogs for an installer waiting\n` +
          `  on input, and list_notifications for failures.\n`,
      );
    }

    // A long stall almost always means a modal appeared that no policy matched.
    if (Date.now() - lastChange > 5 * 60 * 1000) {
      lastChange = Date.now();
      report(`no progress for 5 minutes at ${last} — check for a modal`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/** Detect install errors independently of timing, without retrying or dismissing them. */
function assertNoFailedCollectionMembers(state: {
  failedMembers: number;
  failures: unknown[];
}): void {
  if (state.failedMembers > 0 || state.failures.length > 0)
    throw new CollectionError(
      "Collection still has failed members at the completion boundary. Doodlebot does not retry failed installs.",
    );
}

async function observeCollectionWarnings(
  mcp: VortexMcpClient,
  previous: Set<string>,
  gameId: string,
  collectionModId: string,
  observeWarning: (warning: CollectionWarning) => void,
) {
  for (const notice of await collectionErrors(mcp, previous))
    observeWarning({
      source: "notification",
      id: noticeIdentity(notice),
      at: Date.now(),
      originalSeverity: notice.type === "warning" ? "warning" : "error",
      message: `${notice.title ?? "Collection issue"}: ${notice.message ?? ""}`,
    });
  const native = await mcp.call<CollectionInstallObservation>("collection_install_state");
  const failedMembers = native.session?.statusCounts.failed ?? 0;
  if (
    native.session?.collectionId === collectionModId &&
    native.session.gameId === gameId &&
    failedMembers > 0
  )
    observeWarning({
      source: "session",
      id: collectionModId + "-" + failedMembers,
      at: Date.now(),
      originalSeverity: "error",
      message: "Collection install failed for " + failedMembers + " members",
    });
  const failures = await mcp.call<{ downloadId: string; reference: string }[]>(
    "collection_download_failures",
    { gameId, collectionModId },
  );
  for (const member of failures)
    observeWarning({
      source: "download",
      id: member.downloadId,
      at: Date.now(),
      originalSeverity: "error",
      message: "Collection member download failed: " + member.reference,
    });
  return {
    native,
    failedMembers:
      native.session?.collectionId === collectionModId && native.session.gameId === gameId
        ? failedMembers
        : 0,
    failures,
  };
}

/** Detect new relevant error notices, including Vortex's message-only installer errors. */
async function collectionErrors(mcp: VortexMcpClient, previous: Set<string>) {
  const notices =
    await mcp.call<{ id: string; type: string; title?: string; message?: string }[]>(
      "list_notifications",
    );
  return notices.filter(
    (notice) =>
      !previous.has(noticeIdentity(notice)) &&
      (notice.type === "error" || notice.type === "warning") &&
      /dependency|download|collection|install|extract|archive|deploy|nexus|login|logged in|authentication/i.test(
        `${notice.title ?? ""} ${notice.message ?? ""}`,
      ),
  );
}
export async function throwOnCollectionErrors(
  mcp: VortexMcpClient,
  previous: Set<string>,
): Promise<void> {
  const failures = await collectionErrors(mcp, previous);
  if (failures.length)
    throw new CollectionError(
      "Vortex cannot continue this collection: " +
        failures
          .map((notice) => `${notice.title ?? "Collection error"}: ${notice.message ?? ""}`)
          .join("; ") +
        ". Doodlebot does not retry failed installs. The profile and downloads are preserved. Inspect notifications/logs before starting a separate run.",
    );
}
