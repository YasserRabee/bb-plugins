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

export { rpcContract } from "./lib/contract.ts";

const POLL_MS = 20_000;
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

  async function lookup(environmentId: string): Promise<MergeRequestRow> {
    const space = await workspace(environmentId);
    if ("absent" in space) return { outcome: "absent" };
    if ("unavailable" in space) return { outcome: "unavailable", message: space.unavailable };
    try {
      const result = await host.call(
        "lookup",
        { cwd: space.cwd, branch: space.branch },
        { hostId: space.hostId },
      );
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
      // The host call itself failed: the machine is offline or asleep.
      return {
        outcome: "unavailable",
        message: `Could not reach the environment's machine: ${tidy(String(cause))}`,
      };
    }
  }

  /** One cached, de-duplicated read of an environment's merge request. */
  function read(environmentId: string, options: { force?: boolean } = {}): Promise<MergeRequestRow> {
    const hit = cache.get(environmentId);
    if (!options.force && hit && Date.now() - hit.at < ttlMs(hit.row)) {
      return Promise.resolve(hit.row);
    }
    const pending = inflight.get(environmentId);
    if (pending) return pending;
    const work = limited(() => lookup(environmentId))
      .catch((cause): MergeRequestRow => ({
        outcome: "unavailable",
        message: `Could not read the merge request: ${tidy(String(cause))}`,
      }))
      .then((row) => {
        const previous = cache.get(environmentId)?.row;
        cache.set(environmentId, { row, at: Date.now() });
        if (JSON.stringify(previous) !== JSON.stringify(row)) {
          bb.rpc.experimental_invalidate([`mr:${environmentId}`]);
        }
        return row;
      })
      .finally(() => inflight.delete(environmentId));
    inflight.set(environmentId, work);
    return work;
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

  bb.rpc.register(rpcContract, {
    mergeRequests: async ({ keys }) => {
      const rows = await Promise.all(keys.map((key) => service.read(key)));
      return Object.fromEntries(keys.map((key, index) => [key, rows[index]!]));
    },
    markReady: async ({ environmentId }) => ({ mergeRequest: await service.markReady(environmentId) }),
    markDraft: async ({ environmentId }) => ({ mergeRequest: await service.markDraft(environmentId) }),
    merge: async ({ environmentId, method }) => ({ mergeRequest: await service.merge(environmentId, method) }),
  });

  // While a client watches a row, keep it fresh: `read` honors each row's TTL
  // (20s while a pipeline runs, minutes otherwise, an hour once merged).
  bb.rpc.experimental_whileWatched("mergeRequests", async (watched, signal) => {
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

  bb.agents.configure(() => ({ tools: [], skills: ["gitlab-mr-status"] }));
}
