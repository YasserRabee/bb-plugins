// Pure helpers: GitLab's merge request JSON -> the plugin's MergeRequest.
// No I/O here, so server.test.ts can cover every mapping.
import { z } from "zod";
import type {
  Attention,
  MergeRequest,
  Mergeability,
  PipelineState,
} from "./contract.ts";

const nullableString = z.string().nullish();

/** The parts of GitLab's `GET /projects/:id/merge_requests/:iid` we read. */
export const rawMergeRequestSchema = z.object({
  iid: z.number(),
  title: z.string(),
  web_url: z.string(),
  state: z.string(),
  draft: z.boolean().nullish(),
  source_branch: z.string(),
  target_branch: z.string(),
  author: z.object({ username: z.string() }).nullish(),
  detailed_merge_status: nullableString,
  merge_status: nullableString,
  has_conflicts: z.boolean().nullish(),
  merge_when_pipeline_succeeds: z.boolean().nullish(),
  blocking_discussions_resolved: z.boolean().nullish(),
  head_pipeline: z
    .object({ status: z.string(), web_url: nullableString })
    .nullish(),
  user: z.object({ can_merge: z.boolean().nullish() }).nullish(),
});
export type RawMergeRequest = z.infer<typeof rawMergeRequestSchema>;

/** `GET .../approvals`; absent on tiers without approval rules. */
export const rawApprovalsSchema = z.object({
  approvals_left: z.number().nullish(),
  approved_by: z
    .array(z.object({ user: z.object({ username: z.string() }) }))
    .nullish(),
});
export type RawApprovals = z.infer<typeof rawApprovalsSchema>;

/** One row of the branch lookup (`?source_branch=`); only what ranking needs. */
export const rawListItemSchema = z.object({
  iid: z.number(),
  state: z.string(),
});

/**
 * The open merge request wins; otherwise the most recently updated one (the
 * list is requested newest first), so a merged MR still shows for its branch.
 */
export function pickMergeRequest<T extends { state: string }>(
  list: readonly T[],
): T | undefined {
  return (
    list.find((item) => item.state === "opened" || item.state === "locked") ??
    list[0]
  );
}

const PIPELINE: Record<string, PipelineState> = {
  created: "pending",
  waiting_for_resource: "pending",
  preparing: "pending",
  pending: "pending",
  scheduled: "pending",
  running: "running",
  success: "passed",
  failed: "failed",
  canceled: "canceled",
  canceling: "canceled",
  manual: "manual",
};

export function pipelineState(status: string | undefined): PipelineState {
  return (status && PIPELINE[status]) || "none";
}

const CHECKING = new Set(["checking", "unchecked", "preparing", "approvals_syncing"]);

export function mergeability(raw: RawMergeRequest): Mergeability {
  if (raw.has_conflicts) return "conflicts";
  const detail = raw.detailed_merge_status;
  if (detail) {
    if (detail === "mergeable") return "mergeable";
    if (CHECKING.has(detail)) return "checking";
    return "blocked";
  }
  if (raw.merge_status === "can_be_merged") return "mergeable";
  if (raw.merge_status === "cannot_be_merged") return "conflicts";
  return "unknown";
}

export function attention(input: {
  state: MergeRequest["state"];
  mergeability: Mergeability;
  pipeline: PipelineState;
  changesRequested: boolean;
  discussionsResolved: boolean;
  approvals: MergeRequest["approvals"];
}): Attention {
  if (input.state !== "open") return "none";
  if (input.mergeability === "conflicts") return "conflicts";
  if (input.pipeline === "failed") return "pipeline_failed";
  if (input.changesRequested) return "changes_requested";
  if (!input.discussionsResolved) return "discussions_open";
  if (input.approvals && input.approvals.approved < input.approvals.required) {
    return "needs_approval";
  }
  if (input.pipeline === "pending" || input.pipeline === "running") {
    return "pipeline_running";
  }
  return input.mergeability === "mergeable" ? "ready" : "none";
}

export function normalizeMergeRequest(
  raw: RawMergeRequest,
  approvals: RawApprovals | null,
): MergeRequest {
  const state: MergeRequest["state"] =
    raw.state === "merged"
      ? "merged"
      : raw.state === "closed"
        ? "closed"
        : raw.draft
          ? "draft"
          : "open";
  const by = approvals?.approved_by?.map((entry) => entry.user.username) ?? [];
  const required = by.length + Math.max(0, approvals?.approvals_left ?? 0);
  const review: MergeRequest["approvals"] =
    approvals && required > 0 ? { approved: by.length, required, by } : null;
  const merge = mergeability(raw);
  const pipeline = pipelineState(raw.head_pipeline?.status);
  const discussionsResolved = raw.blocking_discussions_resolved !== false;
  return {
    iid: raw.iid,
    title: raw.title,
    url: raw.web_url,
    state,
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    author: raw.author?.username ?? null,
    attention: attention({
      state,
      mergeability: merge,
      pipeline,
      changesRequested: raw.detailed_merge_status === "requested_changes",
      discussionsResolved,
      approvals: review,
    }),
    pipeline: { state: pipeline, url: raw.head_pipeline?.web_url ?? null },
    approvals: review,
    mergeability: { state: merge, detail: raw.detailed_merge_status ?? "" },
    autoMerge: raw.merge_when_pipeline_succeeds === true,
    discussionsResolved,
    canMerge: raw.user?.can_merge === true,
  };
}

/** Whether a merge request is still worth re-checking on a timer. */
export function isSettled(mergeRequest: MergeRequest): boolean {
  return mergeRequest.state === "merged" || mergeRequest.state === "closed";
}

/** Whether something is pending that will change without anyone acting. */
export function isPending(mergeRequest: MergeRequest): boolean {
  return (
    mergeRequest.autoMerge ||
    mergeRequest.pipeline.state === "pending" ||
    mergeRequest.pipeline.state === "running" ||
    mergeRequest.mergeability.state === "checking" ||
    mergeRequest.mergeability.state === "unknown"
  );
}

/** glab's "this directory is not a GitLab repo" and similar non-errors. */
export function classifyGlabFailure(
  text: string,
): "absent" | "unauthenticated" | "missing" | "other" {
  if (/known\s+GitLab\s+host|not a git repository|no git remotes?/i.test(text)) {
    return "absent";
  }
  if (/401|unauthorized|authenticate|glab auth login/i.test(text)) {
    return "unauthenticated";
  }
  if (/ENOENT|not found: glab|command not found/i.test(text)) return "missing";
  return "other";
}

/** `git@host:group/proj.git`, `ssh://git@host:22/group/proj`, `https://host/group/proj.git`. */
export function parseRemote(url: string): { host: string; path: string } | null {
  const text = url.trim();
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text);
  let host: string | undefined;
  let path: string | undefined;
  if (/^[a-z+]+:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1];
    path = scp[2];
  }
  path = path?.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return host && path && path.includes("/") ? { host: host.toLowerCase(), path } : null;
}

/** Hostnames `glab auth status` reports (one per unindented line). */
export function parseGlabHosts(output: string): string[] {
  return [...output.matchAll(/^([a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+|localhost)\s*$/gim)].map((m) => m[1]!.toLowerCase());
}
