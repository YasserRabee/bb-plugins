// bb-plugin-gitlab-mr-status — GitLab merge request status for each
// environment's branch, the GitLab counterpart of bb's GitHub PR Status.
//
// The MR is found by running the bb server machine's `glab` in the
// environment's workspace, so glab's host list, login and remote detection
// (gitlab.com and self-hosted alike) all apply. The app surfaces (composer
// banner, thread context card, Info rows, thread row badge) read the keyed
// `mergeRequests` method; the `bb merge-request` CLI and the actions use the
// same functions.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import {
  MERGE_METHODS,
  rpcContract,
  type MergeMethod,
  type MergeRequest,
  type MergeRequestRow,
} from "./lib/contract.ts";
import { hostContract } from "./lib/host-contract.ts";
import {
  isPending,
  isSettled,
  normalizeMergeRequest,
  rawApprovalsSchema,
  rawMergeRequestSchema,
} from "./lib/gitlab.ts";
import { findRefs, parseRef, sameMergeRequest } from "./lib/refs.ts";

export { rpcContract } from "./lib/contract.ts";

const POLL_MS = 20_000;
/** Message pages read per walk (20 messages each) and threads kept. */
const MAX_PAGES = 50;
const PAGE = 20;
const MAX_THREADS = 50;

export const MESSAGE_REFERENCE_MODES = ["both", "chips", "directive", "off"] as const;
export type MessageReferenceMode = (typeof MESSAGE_REFERENCE_MODES)[number];

export const DIRECTIVE_INSTRUCTIONS =
  'When a reply mentions a GitLab merge request, write it as the directive ::gitlab-mr{ref="!12"} for the ' +
  "thread's own project, or ::gitlab-mr{ref=\"https://<host>/<group>/<project>/-/merge_requests/12\"} for any " +
  "other project, on a line of its own, instead of a bare link. bb renders it as a live MR chip with a hover card. " +
  "Never put it inside code.";
const MAX_CONCURRENT = 4;

/** How long a cached row answers reads before glab is asked again. */
export function ttlMs(row: MergeRequestRow): number {
  if (row.outcome === "unavailable") return 15_000;
  if (row.outcome === "absent") return 2 * 60_000;
  if (isSettled(row.mergeRequest)) return 60 * 60_000;
  return isPending(row.mergeRequest) ? 20_000 : 2 * 60_000;
}

const tidy = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

type Failure = "absent" | "unauthenticated" | "missing" | "other";

function describe(failure: Failure, message: string): string {
  if (failure === "missing") return "glab is not installed on the environment's machine.";
  if (failure === "unauthenticated") {
    return `glab is not logged in for this GitLab host (${message}). Run \`glab auth login\` on the environment's machine.`;
  }
  return `glab failed: ${message}`;
}

type HostResult =
  | { kind: "found"; detail: string; approvals: string | null }
  | { kind: "none" }
  | { kind: "failed"; failure: Failure; message: string };

interface Workspace {
  cwd: string;
  branch: string;
  hostId: string;
}

export function createService(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const cache = new Map<string, { row: MergeRequestRow; at: number }>();
  const inflight = new Map<string, Promise<MergeRequestRow>>();
  let running = 0;
  const waiting: Array<() => void> = [];

  async function limited<T>(work: () => Promise<T>): Promise<T> {
    if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  /** The environment's checkout, or the reason there is none to read. */
  async function workspace(
    environmentId: string,
  ): Promise<Workspace | { absent: true } | { unavailable: string }> {
    const environment = await bb.sdk.environments.get({ environmentId });
    if (!environment.path || !environment.isGitRepo || !environment.branchName) {
      return { absent: true };
    }
    return { cwd: environment.path, branch: environment.branchName, hostId: environment.hostId };
  }

  /** A host answer as a row; a failed host call means the machine is offline or asleep. */
  async function toRow(call: () => Promise<HostResult>): Promise<MergeRequestRow> {
    try {
      const result = await call();
      if (result.kind === "none") return { outcome: "absent" };
      if (result.kind === "failed") {
        return result.failure === "absent"
          ? { outcome: "absent" }
          : { outcome: "unavailable", message: describe(result.failure, result.message) };
      }
      const approvals =
        result.approvals === null ? null : rawApprovalsSchema.safeParse(JSON.parse(result.approvals));
      return {
        outcome: "available",
        mergeRequest: normalizeMergeRequest(
          rawMergeRequestSchema.parse(JSON.parse(result.detail)),
          approvals?.success ? approvals.data : null,
        ),
      };
    } catch (cause) {
      return {
        outcome: "unavailable",
        message: `Could not reach the environment's machine: ${tidy(String(cause))}`,
      };
    }
  }

  async function lookup(environmentId: string): Promise<MergeRequestRow> {
    const space = await workspace(environmentId);
    if ("absent" in space) return { outcome: "absent" };
    if ("unavailable" in space) return { outcome: "unavailable", message: space.unavailable };
    return toRow(() => host.call("lookup", { cwd: space.cwd, branch: space.branch }, { hostId: space.hostId }));
  }

  /** `<environmentId> <ref>`: the environment's own MR when it matches, else glab on its machine. */
  async function lookupRef(key: string): Promise<MergeRequestRow> {
    const split = key.indexOf(" ");
    const ref = split > 0 ? parseRef(key.slice(split + 1)) : null;
    if (!ref) return { outcome: "absent" };
    const environmentId = key.slice(0, split);
    const own = await read(environmentId);
    if (own.outcome === "available" && sameMergeRequest(own.mergeRequest.url, own.mergeRequest.iid, ref)) return own;
    const environment = await bb.sdk.environments.get({ environmentId });
    const cwd = environment.path && environment.isGitRepo ? environment.path : null;
    if (!("host" in ref) && !cwd) return { outcome: "absent" };
    return toRow(() => limited(() => host.call("fetch", { cwd, ...ref }, { hostId: environment.hostId })));
  }

  /**
   * One cached, de-duplicated read of a row: an environment id (its branch's
   * merge request) or `<environmentId> <ref>` (a referenced one).
   */
  function read(key: string, options: { force?: boolean } = {}): Promise<MergeRequestRow> {
    const hit = cache.get(key);
    if (!options.force && hit && Date.now() - hit.at < ttlMs(hit.row)) {
      return Promise.resolve(hit.row);
    }
    const pending = inflight.get(key);
    if (pending) return pending;
    // A ref reads its environment's row first, so only its glab call takes a slot.
    const work = (key.includes(" ") ? lookupRef(key) : limited(() => lookup(key)))
      .catch((cause): MergeRequestRow => ({
        outcome: "unavailable",
        message: `Could not read the merge request: ${tidy(String(cause))}`,
      }))
      .then((row) => {
        const previous = cache.get(key)?.row;
        cache.delete(key);
        cache.set(key, { row, at: Date.now() });
        // Referenced MRs add keys without bound: drop the least recently read.
        if (cache.size > 2000) cache.delete(cache.keys().next().value!);
        if (JSON.stringify(previous) !== JSON.stringify(row)) {
          bb.rpc.experimental_invalidate([`mr:${key}`]);
        }
        return row;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, work);
    return work;
  }

  // Message text by timeline message id, per thread. The metadata slot gives a
  // message's id but not its seq, so a walk pages back from the newest message.
  // shortcut: an edited message keeps its first text until the server restarts.
  const texts = new Map<string, Map<string, string>>();
  const walks = new Map<string, Promise<void>>();

  /** Seqs of the thread's newest message events (user requests and agent replies). */
  async function newestMessageSeqs(threadId: string): Promise<number[]> {
    const events = await bb.sdk.threads.events.list({
      threadId,
      types: ["item/completed", "client/turn/requested"],
      order: "desc",
      limit: "40",
    });
    return events
      .filter((event) => event.type === "client/turn/requested" || (event.data as { item?: { type?: string } }).item?.type === "agentMessage")
      .map((event) => Number(event.seq))
      .slice(0, 3);
  }

  /** Reads message pages from the newest back until a page brings nothing new. */
  async function walk(threadId: string): Promise<void> {
    const known = texts.get(threadId) ?? new Map<string, string>();
    texts.delete(threadId);
    texts.set(threadId, known);
    if (texts.size > MAX_THREADS) texts.delete(texts.keys().next().value!);
    let page: Awaited<ReturnType<typeof bb.sdk.threads.message>> | null = null;
    for (const seq of await newestMessageSeqs(threadId)) {
      // A request that was rejected has no message: try the next newest.
      page = await bb.sdk.threads.message({ threadId, seq, before: PAGE }).catch(() => null);
      if (page) break;
    }
    for (let pages = 1; page; pages += 1) {
      const rows = [...page.before, page.message, ...page.after];
      const fresh = rows.filter((row) => !known.has(row.id)).length;
      for (const row of rows) known.set(row.id, row.text);
      // Stop at known messages, the thread's start (a short page), or the cap.
      if (fresh === 0 || page.before.length < PAGE || pages >= MAX_PAGES) break;
      page = await bb.sdk.threads.message({ threadId, seq: page.before[0]!.messageSeq, before: PAGE });
    }
  }

  /** `<threadId> <messageId>`: the merge request refs in that message. */
  async function messageRefs(key: string): Promise<string[]> {
    const split = key.indexOf(" ");
    if (split <= 0) return [];
    const threadId = key.slice(0, split);
    const messageId = key.slice(split + 1);
    if (!texts.get(threadId)?.has(messageId)) {
      let pending = walks.get(threadId);
      if (!pending) {
        pending = walk(threadId).finally(() => walks.delete(threadId));
        walks.set(threadId, pending);
      }
      await pending.catch((cause) => bb.log.warn(`Reading thread ${threadId} messages failed: ${tidy(String(cause))}`));
    }
    const text = texts.get(threadId)?.get(messageId);
    return text ? findRefs(text) : [];
  }

  /** Marks one environment stale and tells the open clients to re-read it. */
  function forget(environmentId: string) {
    cache.delete(environmentId);
    bb.rpc.experimental_invalidate([`mr:${environmentId}`]);
  }

  async function requireAvailable(environmentId: string): Promise<{ space: Workspace; mr: MergeRequest }> {
    const space = await workspace(environmentId);
    if ("absent" in space) throw new PluginCliError("This environment has no git branch.", { code: "no_branch" });
    if ("unavailable" in space) throw new PluginCliError(space.unavailable, { code: "unavailable" });
    const row = await read(environmentId, { force: true });
    if (row.outcome === "unavailable") throw new PluginCliError(row.message, { code: "unavailable" });
    if (row.outcome === "absent") {
      throw new PluginCliError(`No merge request found for branch ${space.branch}.`, { code: "no_merge_request" });
    }
    return { space, mr: row.mergeRequest };
  }

  async function act(
    environmentId: string,
    check: (mr: MergeRequest) => string | null,
    action: "ready" | "draft" | "merge" | "squash" | "rebase",
  ): Promise<MergeRequest> {
    const { space, mr } = await requireAvailable(environmentId);
    const refusal = check(mr);
    if (refusal) throw new PluginCliError(refusal, { code: "not_allowed" });
    const done = await host.call("act", { cwd: space.cwd, iid: mr.iid, action }, { hostId: space.hostId });
    if (!done.ok) throw new PluginCliError(describe(done.failure, done.message), { code: "glab_failed" });
    const row = await read(environmentId, { force: true });
    forget(environmentId);
    if (row.outcome !== "available") {
      throw new PluginCliError("The merge request could not be re-read after the change.", { code: "unavailable" });
    }
    return row.mergeRequest;
  }

  return {
    read,
    messageRefs,
    forget,
    cache,
    markReady: (environmentId: string) =>
      act(
        environmentId,
        (mr) => (mr.state === "draft" ? null : `Only a draft can be marked ready (this one is ${mr.state}).`),
        "ready",
      ),
    markDraft: (environmentId: string) =>
      act(
        environmentId,
        (mr) => (mr.state === "open" ? null : `Only an open merge request can be made a draft (this one is ${mr.state}).`),
        "draft",
      ),
    merge: (environmentId: string, method: MergeMethod = "merge") =>
      act(
        environmentId,
        (mr) =>
          mr.state !== "open"
            ? `Only an open merge request can be merged (this one is ${mr.state}).`
            : mr.mergeability.state !== "mergeable"
              ? `GitLab does not report this merge request as mergeable (${mr.mergeability.detail || mr.mergeability.state}).`
              : null,
        method,
      ),
  };
}

/** `bb merge-request show` output. */
export function formatMergeRequest(mr: MergeRequest): string {
  const lines = [
    `!${mr.iid} ${mr.title}`,
    `State: ${mr.state}${mr.autoMerge ? " (auto-merge on)" : ""}`,
    `Branch: ${mr.sourceBranch} -> ${mr.targetBranch}`,
    `URL: ${mr.url}`,
    `Attention: ${mr.attention}`,
    `Pipeline: ${mr.pipeline.state}`,
    `Approvals: ${mr.approvals ? `${mr.approvals.approved}/${mr.approvals.required}` : "none required"}`,
    `Discussions: ${mr.discussionsResolved ? "resolved" : "unresolved"}`,
    `Mergeability: ${mr.mergeability.state}${mr.mergeability.detail ? ` (${mr.mergeability.detail})` : ""}`,
  ];
  return lines.join("\n");
}

const environmentArg = [
  { name: "environment", description: "Environment id", required: true },
] as const;

export default function (bb: BbPluginApi) {
  const service = createService(bb);
  const settings = bb.settings.define({
    messageReferences: {
      type: "select",
      label: "Merge requests in messages",
      options: [...MESSAGE_REFERENCE_MODES],
      experimental_optionLabels: {
        both: "Chips and agent directive (default)",
        chips: "Chips above messages that mention an MR",
        directive: "Agent writes ::gitlab-mr directives",
        off: "Off",
      },
      default: "both",
    },
  });
  // agents.configure is synchronous: keep the current mode at hand.
  let mode: MessageReferenceMode = "both";
  void settings.get().then((values) => { mode = values.messageReferences as MessageReferenceMode; });
  settings.onChange((values) => { mode = values.messageReferences as MessageReferenceMode; });

  bb.rpc.register(rpcContract, {
    mergeRequests: async ({ keys }) => {
      const rows = await Promise.all(keys.map((key) => service.read(key)));
      return Object.fromEntries(keys.map((key, index) => [key, rows[index]!]));
    },
    mergeRequestRefs: async ({ keys }) => {
      const rows = await Promise.all(keys.map((key) => (key.includes(" ") ? service.read(key) : { outcome: "absent" as const })));
      return Object.fromEntries(keys.map((key, index) => [key, rows[index]!]));
    },
    messageRefs: async ({ keys }) => {
      const refs = await Promise.all(keys.map((key) => service.messageRefs(key)));
      return Object.fromEntries(keys.map((key, index) => [key, { refs: refs[index]! }]));
    },
    markReady: async ({ environmentId }) => ({ mergeRequest: await service.markReady(environmentId) }),
    markDraft: async ({ environmentId }) => ({ mergeRequest: await service.markDraft(environmentId) }),
    merge: async ({ environmentId, method }) => ({ mergeRequest: await service.merge(environmentId, method) }),
  });

  // While a client watches a row, keep it fresh: `read` honors each row's TTL
  // (20s while a pipeline runs, minutes otherwise, an hour once merged).
  for (const method of ["mergeRequests", "mergeRequestRefs"] as const) {
    bb.rpc.experimental_whileWatched(method, async (watched, signal) => {
      if (!("key" in watched)) return;
      while (!signal.aborted) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, POLL_MS);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
        });
        if (signal.aborted) return;
        await service.read(watched.key);
      }
    });
  }

  // A finished turn often pushed a branch or opened an MR: look again.
  bb.events.on("thread.idle", async ({ thread }) => {
    const environmentId = (thread as { environmentId?: string | null }).environmentId;
    if (environmentId) service.forget(environmentId);
  });

  const json = { json: { type: "boolean", description: "Print machine-readable JSON" } } as const;
  const print = (mr: MergeRequest, asJson: boolean | undefined) =>
    asJson ? JSON.stringify({ outcome: "available", mergeRequest: mr }, null, 2) : formatMergeRequest(mr);

  bb.cli.register(
    defineCli({
      name: "merge-request",
      summary: "Inspect and manage an environment's GitLab merge request",
      commands: {
        show: cliCommand({
          summary: "Show the merge request for the environment's branch",
          positionals: [...environmentArg],
          options: json,
          async run(input) {
            const row = await service.read(input.positionals.environment, { force: true });
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(row, null, 2) };
            if (row.outcome === "available") return { exitCode: 0, stdout: formatMergeRequest(row.mergeRequest) };
            return {
              exitCode: row.outcome === "absent" ? 0 : 1,
              stdout: row.outcome === "absent" ? "No merge request for this branch." : row.message,
            };
          },
        }),
        ready: cliCommand({
          summary: "Mark a draft merge request ready",
          positionals: [...environmentArg],
          options: json,
          async run(input) {
            const mr = await service.markReady(input.positionals.environment);
            return { exitCode: 0, stdout: print(mr, input.options.json) };
          },
        }),
        draft: cliCommand({
          summary: "Mark an open merge request as a draft",
          positionals: [...environmentArg],
          options: json,
          async run(input) {
            const mr = await service.markDraft(input.positionals.environment);
            return { exitCode: 0, stdout: print(mr, input.options.json) };
          },
        }),
        merge: cliCommand({
          summary: "Merge an open, mergeable merge request",
          positionals: [...environmentArg],
          options: {
            method: { type: "enum", values: [...MERGE_METHODS], default: "merge", description: "How to merge" },
            ...json,
          },
          async run(input) {
            const mr = await service.merge(input.positionals.environment, input.options.method);
            return { exitCode: 0, stdout: print(mr, input.options.json) };
          },
        }),
      },
    }),
  );

  bb.agents.configure(() => ({
    tools: [],
    skills: ["gitlab-mr-status"],
    ...(mode === "both" || mode === "directive" ? { instructions: DIRECTIVE_INSTRUCTIONS } : {}),
  }));
}
