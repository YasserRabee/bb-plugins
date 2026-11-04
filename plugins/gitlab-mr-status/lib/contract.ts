// The RPC contract and data shapes shared by server.ts and app.tsx. Kept free
// of server-only imports so the app bundle can import it as a value (a plain
// object, not defineRpcContract: a managed install has no SDK root to bundle).
import { z } from "zod";

export const mergeRequestStateSchema = z.enum([
  "draft",
  "open",
  "merged",
  "closed",
]);
export type MergeRequestState = z.infer<typeof mergeRequestStateSchema>;

export const pipelineStateSchema = z.enum([
  "none",
  "pending",
  "running",
  "passed",
  "failed",
  "canceled",
  "manual",
]);
export type PipelineState = z.infer<typeof pipelineStateSchema>;

export const mergeabilitySchema = z.enum([
  "mergeable",
  "conflicts",
  "blocked",
  "checking",
  "unknown",
]);
export type Mergeability = z.infer<typeof mergeabilitySchema>;

/** What needs the author's attention next, in the order the UI ranks it. */
export const attentionSchema = z.enum([
  "none",
  "conflicts",
  "pipeline_failed",
  "changes_requested",
  "discussions_open",
  "needs_approval",
  "pipeline_running",
  "ready",
]);
export type Attention = z.infer<typeof attentionSchema>;

export const mergeRequestSchema = z.object({
  iid: z.number(),
  title: z.string(),
  url: z.string(),
  state: mergeRequestStateSchema,
  sourceBranch: z.string(),
  targetBranch: z.string(),
  author: z.string().nullable(),
  attention: attentionSchema,
  pipeline: z.object({
    state: pipelineStateSchema,
    url: z.string().nullable(),
  }),
  approvals: z
    .object({
      approved: z.number(),
      required: z.number(),
      by: z.array(z.string()),
    })
    .nullable(),
  mergeability: z.object({
    state: mergeabilitySchema,
    /** GitLab's raw `detailed_merge_status`. */
    detail: z.string(),
  }),
  /** Auto-merge ("merge when pipeline succeeds") is set. */
  autoMerge: z.boolean(),
  discussionsResolved: z.boolean(),
  canMerge: z.boolean(),
});
export type MergeRequest = z.infer<typeof mergeRequestSchema>;

export const mergeRequestRowSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    mergeRequest: mergeRequestSchema,
  }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }),
]);
export type MergeRequestRow = z.infer<typeof mergeRequestRowSchema>;

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

const actionInput = z.object({ environmentId: z.string().min(1).max(200) });
const actionOutput = z.object({ mergeRequest: mergeRequestSchema });

export const rpcContract = {
  /** Keyed read: one row per environment id (up to 200). */
  mergeRequests: {
    input: z.object({ keys: z.array(z.string().max(200)).max(200) }),
    output: z.record(z.string(), mergeRequestRowSchema),
    keyTags: (key: string) => [`mr:${key}`],
  },
  markReady: { input: actionInput, output: actionOutput },
  markDraft: { input: actionInput, output: actionOutput },
  merge: {
    input: actionInput.extend({ method: z.enum(MERGE_METHODS).optional() }),
    output: actionOutput,
  },
} as const;
