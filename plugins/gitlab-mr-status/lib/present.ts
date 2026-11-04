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
      return { icon: "GitMerge", tone: "text-purple-500", label: "Merged" };
    case "closed":
      return { icon: "GitPullRequestClosed", tone: "text-red-500", label: "Closed" };
    case "draft":
      return { icon: "GitPullRequestDraft", tone: "text-muted-foreground", label: "Draft" };
    default:
      return { icon: "GitPullRequest", tone: "text-emerald-500", label: "Open" };
  }
}

export function pipelineLook(state: PipelineState): Look | null {
  switch (state) {
    case "passed":
      return { icon: "CircleCheck", tone: "text-emerald-500", label: "Pipeline passed" };
    case "failed":
      return { icon: "CircleX", tone: "text-red-500", label: "Pipeline failed" };
    case "running":
    case "pending":
      return { icon: "CircleDot", tone: "text-yellow-500", label: state === "running" ? "Pipeline running" : "Pipeline pending" };
    case "manual":
      return { icon: "CirclePlay", tone: "text-muted-foreground", label: "Pipeline waiting for a manual job" };
    case "canceled":
      return { icon: "CircleSlash", tone: "text-muted-foreground", label: "Pipeline canceled" };
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
