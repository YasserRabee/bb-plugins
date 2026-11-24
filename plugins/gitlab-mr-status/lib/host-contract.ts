// The contract between server.ts and host.ts. The host entry runs `glab` on
// the machine that owns the environment; it returns GitLab's raw JSON and the
// server normalizes it (lib/gitlab.ts), so host.ts stays a thin runner.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const failureKindSchema = z.enum([
  "absent",
  "unauthenticated",
  "missing",
  "other",
]);

export const MR_ACTIONS = ["ready", "draft", "merge", "squash", "rebase"] as const;

export const hostContract = defineRpcContract({
  lookup: {
    input: z.object({
      cwd: z.string().min(1),
      branch: z.string().min(1),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("found"),
        detail: z.string(),
        approvals: z.string().nullable(),
      }),
      z.object({ kind: z.literal("none") }),
      z.object({
        kind: z.literal("failed"),
        failure: failureKindSchema,
        message: z.string(),
      }),
    ]),
    experimental_retryable: true,
  },
  /** One merge request by number: in `host`/`path`, or in `cwd`'s GitLab project. */
  fetch: {
    input: z.object({
      cwd: z.string().min(1).nullable(),
      host: z.string().min(1).max(253).optional(),
      path: z.string().min(1).max(400).optional(),
      iid: z.number().int().positive(),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("found"),
        detail: z.string(),
        approvals: z.string().nullable(),
      }),
      z.object({ kind: z.literal("none") }),
      z.object({
        kind: z.literal("failed"),
        failure: failureKindSchema,
        message: z.string(),
      }),
    ]),
    experimental_retryable: true,
  },
  act: {
    input: z.object({
      cwd: z.string().min(1),
      iid: z.number().int().positive(),
      action: z.enum(MR_ACTIONS),
    }),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({
        ok: z.literal(false),
        failure: failureKindSchema,
        message: z.string(),
      }),
    ]),
  },
});
