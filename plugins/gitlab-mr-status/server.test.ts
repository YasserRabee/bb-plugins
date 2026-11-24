import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGlabFailure,
  isPending,
  parseGlabHosts,
  parseRemote,
  mergeability,
  normalizeMergeRequest,
  pickMergeRequest,
  pipelineState,
  rawMergeRequestSchema,
  type RawMergeRequest,
} from "./lib/gitlab.ts";
import { summary } from "./lib/present.ts";
import { findRefs, parseRef, sameMergeRequest } from "./lib/refs.ts";
import { createService, ttlMs } from "./server.ts";

const raw = (overrides: Partial<RawMergeRequest> = {}): RawMergeRequest =>
  rawMergeRequestSchema.parse({
    iid: 12,
    title: "Add custom fields",
    web_url: "https://gitlab.com/g/p/-/merge_requests/12",
    state: "opened",
    draft: false,
    source_branch: "feat",
    target_branch: "master",
    author: { username: "yasser" },
    detailed_merge_status: "mergeable",
    has_conflicts: false,
    merge_when_pipeline_succeeds: false,
    blocking_discussions_resolved: true,
    head_pipeline: { status: "success", web_url: "https://gitlab.com/p/1" },
    user: { can_merge: true },
    ...overrides,
  });

test("an open, green, mergeable MR is ready", () => {
  const mr = normalizeMergeRequest(raw(), null);
  assert.equal(mr.state, "open");
  assert.equal(mr.attention, "ready");
  assert.equal(mr.pipeline.state, "passed");
  assert.equal(mr.mergeability.state, "mergeable");
  assert.equal(mr.canMerge, true);
  assert.equal(mr.approvals, null);
});

test("states: draft, merged, closed", () => {
  assert.equal(normalizeMergeRequest(raw({ draft: true }), null).state, "draft");
  assert.equal(normalizeMergeRequest(raw({ draft: true }), null).attention, "none");
  assert.equal(normalizeMergeRequest(raw({ state: "merged" }), null).state, "merged");
  assert.equal(normalizeMergeRequest(raw({ state: "closed" }), null).attention, "none");
});

test("attention ranks conflicts, failures, review, then waiting", () => {
  const at = (overrides: Partial<RawMergeRequest>, approvals = null as never) =>
    normalizeMergeRequest(raw(overrides), approvals).attention;
  assert.equal(at({ has_conflicts: true, head_pipeline: { status: "failed" } }), "conflicts");
  assert.equal(at({ head_pipeline: { status: "failed" } }), "pipeline_failed");
  assert.equal(at({ detailed_merge_status: "requested_changes" }), "changes_requested");
  assert.equal(at({ blocking_discussions_resolved: false }), "discussions_open");
  assert.equal(at({ head_pipeline: { status: "running" }, detailed_merge_status: "ci_still_running" }), "pipeline_running");
  assert.equal(
    at({ detailed_merge_status: "not_approved" }, { approvals_left: 1, approved_by: [] } as never),
    "needs_approval",
  );
});

test("approvals count approvers plus approvals left", () => {
  const mr = normalizeMergeRequest(
    raw(),
    { approvals_left: 1, approved_by: [{ user: { username: "a" } }] },
  );
  assert.deepEqual(mr.approvals, { approved: 1, required: 2, by: ["a"] });
  // No rule at all: nothing to show.
  assert.equal(normalizeMergeRequest(raw(), { approvals_left: 0, approved_by: [] }).approvals, null);
});

test("mergeability falls back to merge_status for old GitLab", () => {
  assert.equal(mergeability(raw({ detailed_merge_status: null, merge_status: "can_be_merged" })), "mergeable");
  assert.equal(mergeability(raw({ detailed_merge_status: null, merge_status: "cannot_be_merged" })), "conflicts");
  assert.equal(mergeability(raw({ detailed_merge_status: null, merge_status: null })), "unknown");
  assert.equal(mergeability(raw({ detailed_merge_status: "checking" })), "checking");
  assert.equal(mergeability(raw({ detailed_merge_status: "need_rebase" })), "blocked");
});

test("pipeline statuses collapse to a few states", () => {
  assert.equal(pipelineState("waiting_for_resource"), "pending");
  assert.equal(pipelineState("success"), "passed");
  assert.equal(pipelineState("skipped"), "none");
  assert.equal(pipelineState(undefined), "none");
});

test("the open MR wins, else the newest", () => {
  assert.equal(pickMergeRequest([{ state: "merged" }, { state: "opened" }])?.state, "opened");
  assert.equal(pickMergeRequest([{ state: "merged" }, { state: "closed" }])?.state, "merged");
  assert.equal(pickMergeRequest([]), undefined);
});

test("glab failures sort into absent, auth, missing, other", () => {
  assert.equal(
    classifyGlabFailure("none of the git remotes configured for this repository point to a known GitLab host. Please use `glab auth login`"),
    "absent",
  );
  // glab hard-wraps this message mid-phrase.
  assert.equal(
    classifyGlabFailure("  ERROR  \n  Unable to expand placeholder in path: none of the git remotes configured for this repository point to a known GitLab\n  host. Please use `glab auth login` to authenticate"),
    "absent",
  );
  assert.equal(classifyGlabFailure("401 Unauthorized"), "unauthenticated");
  assert.equal(classifyGlabFailure("spawn glab ENOENT"), "missing");
  assert.equal(classifyGlabFailure("boom"), "other");
});

test("pending MRs poll fast, merged ones barely", () => {
  const running = normalizeMergeRequest(raw({ head_pipeline: { status: "running" } }), null);
  const merged = normalizeMergeRequest(raw({ state: "merged" }), null);
  assert.equal(isPending(running), true);
  assert.equal(ttlMs({ outcome: "available", mergeRequest: running }), 20_000);
  assert.ok(ttlMs({ outcome: "available", mergeRequest: merged }) >= 60 * 60_000);
  assert.ok(ttlMs({ outcome: "unavailable", message: "x" }) < ttlMs({ outcome: "absent" }));
});

test("summary reads as one tooltip line", () => {
  assert.equal(
    summary(normalizeMergeRequest(raw(), null)),
    "!12 Add custom fields — Open, Pipeline passed, Ready to merge",
  );
});

test("remotes parse to host and project path", () => {
  assert.deepEqual(parseRemote("git@gitlab.com:salzify/salzify-fe.git"), { host: "gitlab.com", path: "salzify/salzify-fe" });
  assert.deepEqual(parseRemote("https://gitlab.example.com/a/b/c.git\n"), { host: "gitlab.example.com", path: "a/b/c" });
  assert.deepEqual(parseRemote("ssh://git@git.corp.io:2222/team/app"), { host: "git.corp.io", path: "team/app" });
  assert.equal(parseRemote("/home/me/repo"), null);
  assert.equal(parseRemote("https://github.com/onlyowner"), null);
});

test("glab auth status yields its hosts", () => {
  const out = "gitlab.com\n  ✓ Logged in to gitlab.com as yasserrabee (/home/x/config.yml)\n  ✓ Git operations configured\ngit.corp.io\n  x failed\n";
  assert.deepEqual(parseGlabHosts(out), ["gitlab.com", "git.corp.io"]);
});

test("message refs: MR URLs on any host and bare !n tokens, in order", () => {
  const text =
    "See https://git.corp.io:8443/team/sub/app/-/merge_requests/7/diffs#note_1 and !12, (!13) or [!14](x).\n" +
    "Also https://gitlab.com/g/p/-/merge_requests/12 and !12 again.";
  assert.deepEqual(findRefs(text), [
    "https://git.corp.io:8443/team/sub/app/-/merge_requests/7",
    "!12",
    "!13",
    "!14",
    "https://gitlab.com/g/p/-/merge_requests/12",
  ]);
});

test("message refs: no false positives from code, prose or other syntax", () => {
  const text = [
    "Great!1 x!2 $!3 !4abc !5-x !6.5 !== !! ![img](a.png)",
    "`!7` and `https://gitlab.com/g/p/-/merge_requests/8`",
    "```sh\ngit log !9\nhttps://gitlab.com/g/p/-/merge_requests/10\n```",
    "https://github.com/o/r/pull/11 https://gitlab.com/g/p/-/issues/12",
    '::gitlab-mr{ref="https://gitlab.com/g/p/-/merge_requests/13"}',
  ].join("\n");
  assert.deepEqual(findRefs(text), []);
});

test("message refs: at most ten", () => {
  assert.equal(findRefs(Array.from({ length: 20 }, (_, i) => `!${i + 1}`).join(" ")).length, 10);
});

test("parseRef and sameMergeRequest", () => {
  assert.deepEqual(parseRef(" !12 "), { iid: 12 });
  assert.deepEqual(parseRef("https://GitLab.com/g/p/-/merge_requests/3?tab=x"), { host: "gitlab.com", path: "g/p", iid: 3 });
  assert.equal(parseRef("!x"), null);
  assert.equal(parseRef("https://gitlab.com/g/p/-/merge_requests/3 trailing"), null);
  const url = "https://gitlab.com/g/p/-/merge_requests/12";
  assert.equal(sameMergeRequest(url, 12, { iid: 12 }), true);
  assert.equal(sameMergeRequest(url, 12, { iid: 13 }), false);
  assert.equal(sameMergeRequest(url, 12, { host: "gitlab.com", path: "g/p", iid: 12 }), true);
  assert.equal(sameMergeRequest(url, 12, { host: "gitlab.com", path: "g/other", iid: 12 }), false);
});

test("message refs walk message pages back from the newest message", async () => {
  // 45 messages with seq 1..45; message i says "!i". Pages hold 20 before + the target.
  const all = Array.from({ length: 45 }, (_, i) => ({ id: `m${i + 1}`, text: `fix !${i + 1}`, messageSeq: i + 1 }));
  let pages = 0;
  const bb = {
    hosts: { experimental_client: () => ({}) },
    log: { warn() {} },
    sdk: {
      threads: {
        events: { list: async () => [{ type: "item/completed", seq: 45, data: { item: { type: "agentMessage" } } }] },
        message: async ({ seq, before }: { seq: number; before: number }) => {
          pages += 1;
          const at = seq - 1;
          return { before: all.slice(Math.max(0, at - before), at), message: all[at], after: [] };
        },
      },
    },
  } as never;
  const service = createService(bb);
  assert.deepEqual(await service.messageRefs("thr m3"), ["!3"]);
  assert.equal(pages, 3);
  assert.deepEqual(await service.messageRefs("thr m44"), ["!44"]);
  assert.equal(pages, 3, "known messages need no new read");
  assert.deepEqual(await service.messageRefs("thr missing"), []);
  assert.deepEqual(await service.messageRefs("bad-key"), []);
});
