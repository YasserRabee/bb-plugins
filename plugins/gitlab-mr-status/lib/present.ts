// How a merge request looks: icon, tone and words. Shared by every surface so
// the banner, the card, the Info tab and the thread-row badge agree.
import type { Attention, MergeRequest, PipelineState } from "./contract";

export interface Look {
  icon: string;
  tone: string;
  label: string;
}

export function stateLook(state: MergeRequest["state"]): Look {
  switch (state) {
    case "merged":
      return { icon: "gitlab-mr-status/git-merge", tone: "text-purple-500", label: "Merged" };
    case "closed":
      return { icon: "gitlab-mr-status/git-pull-request-closed", tone: "text-red-500", label: "Closed" };
    case "draft":
      return { icon: "gitlab-mr-status/git-pull-request-draft", tone: "text-muted-foreground", label: "Draft" };
    default:
      return { icon: "gitlab-mr-status/git-pull-request", tone: "text-emerald-500", label: "Open" };
  }
}

export function pipelineLook(state: PipelineState): Look | null {
  switch (state) {
    case "passed":
      return { icon: "gitlab-mr-status/circle-check", tone: "text-emerald-500", label: "Pipeline passed" };
    case "failed":
      return { icon: "gitlab-mr-status/circle-x", tone: "text-red-500", label: "Pipeline failed" };
    case "running":
    case "pending":
      return { icon: "gitlab-mr-status/circle-dot", tone: "text-yellow-500", label: state === "running" ? "Pipeline running" : "Pipeline pending" };
    case "manual":
      return { icon: "gitlab-mr-status/circle-play", tone: "text-muted-foreground", label: "Pipeline waiting for a manual job" };
    case "canceled":
      return { icon: "gitlab-mr-status/circle-slash", tone: "text-muted-foreground", label: "Pipeline canceled" };
    default:
      return null;
  }
}

const ATTENTION: Record<Attention, string | null> = {
  none: null,
  conflicts: "Has conflicts",
  pipeline_failed: "Pipeline failed",
  changes_requested: "Changes requested",
  discussions_open: "Unresolved discussions",
  needs_approval: "Needs approval",
  pipeline_running: "Pipeline running",
  ready: "Ready to merge",
};

export const attentionLabel = (attention: Attention) => ATTENTION[attention];

export function approvalsLabel(mr: MergeRequest): string | null {
  return mr.approvals ? `${mr.approvals.approved}/${mr.approvals.required} approved` : null;
}

/** One line for tooltips: `!12 Title — Open, Pipeline passed`. */
export function summary(mr: MergeRequest): string {
  const parts = [
    stateLook(mr.state).label,
    pipelineLook(mr.pipeline.state)?.label,
    approvalsLabel(mr),
    attentionLabel(mr.attention),
  ].filter(Boolean);
  return `!${mr.iid} ${mr.title} — ${parts.join(", ")}`;
}
