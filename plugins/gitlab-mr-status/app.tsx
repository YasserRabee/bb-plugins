// bb-plugin-gitlab-mr-status — GitLab merge request status in four places:
// a banner above the composer, rows in the thread context card (and the Info
// tab), and a badge on thread rows. All read the keyed `mergeRequests` method.
import { useState } from "react";
import {
  UrlLink,
  definePluginApp,
  experimental_DetailRow as DetailRow,
  experimental_THREAD_INFO_ROW_GROUPS as ROW_GROUPS,
  experimental_ThreadContextCardRow as ContextCardRow,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useSidebarThreads as useSidebarThreads,
  useComposer,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadInfoProps,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
} from "@get-bb/plugin-sdk/app";
import {
  MERGE_METHODS,
  rpcContract,
  type MergeMethod,
  type MergeRequest,
  type MergeRequestRow,
} from "./lib/contract";
import {
  approvalsLabel,
  attentionLabel,
  pipelineLook,
  stateLook,
  summary,
} from "./lib/present";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Rows for the given environments, one batched request for all of them. */
function useRows(environmentIds: readonly string[]) {
  const keys = [...new Set(environmentIds)];
  const { data } = useRpcKeyedQuery({
    contract: rpcContract,
    method: "mergeRequests",
    keys,
    enabled: keys.length > 0,
  });
  return data as Record<string, MergeRequestRow> | undefined;
}

function useRow(environmentId: string | null | undefined) {
  const rows = useRows(environmentId ? [environmentId] : []);
  return environmentId ? rows?.[environmentId] : undefined;
}

function useMergeRequest(environmentId: string | null | undefined) {
  const row = useRow(environmentId);
  return row?.outcome === "available" ? row.mergeRequest : null;
}

function useThreadEnvironmentId(threadId: string): string | null {
  const { threads } = useSidebarThreads();
  return threads.find((thread) => thread.id === threadId)?.environment?.id ?? null;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// ── Composer banner ─────────────────────────────────────────────────────

function Chip({ look, children }: { look: { icon: string; tone: string }; children: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <Icon name={look.icon} className={cn("size-3.5", look.tone)} />
      {children}
    </span>
  );
}

function ActionButton({ label, onClick, disabled, primary }: { label: string; onClick(): void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-6 shrink-0 rounded-md px-2 text-xs disabled:opacity-50",
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function MergeRequestActions({ environmentId, mr }: { environmentId: string; mr: MergeRequest }) {
  const ready = useRpcMutation({ contract: rpcContract, method: "markReady" });
  const draft = useRpcMutation({ contract: rpcContract, method: "markDraft" });
  const merge = useRpcMutation({ contract: rpcContract, method: "merge" });
  const [method, setMethod] = useState<MergeMethod>("merge");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = ready.isPending || draft.isPending || merge.isPending;
  const run = (work: Promise<unknown>) => {
    setError(null);
    work.catch((cause: unknown) => setError(errorText(cause)));
  };
  const mergeable = mr.state === "open" && mr.mergeability.state === "mergeable" && mr.canMerge;
  return (
    <>
      {error ? (
        <span className="max-w-48 truncate text-red-500" title={error}>
          {error}
        </span>
      ) : null}
      {mr.state === "draft" ? (
        <ActionButton label="Mark ready" disabled={busy} onClick={() => run(ready.mutate({ environmentId }))} primary />
      ) : null}
      {mr.state === "open" ? (
        <ActionButton label="Draft" disabled={busy} onClick={() => run(draft.mutate({ environmentId }))} />
      ) : null}
      {mergeable ? (
        confirming ? (
          <>
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value as MergeMethod)}
              className="h-6 rounded-md border bg-transparent px-1 text-xs"
              aria-label="Merge method"
            >
              {MERGE_METHODS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <ActionButton label="Confirm merge" primary disabled={busy} onClick={() => { setConfirming(false); run(merge.mutate({ environmentId, method })); }} />
            <ActionButton label="Cancel" onClick={() => setConfirming(false)} />
          </>
        ) : (
          <ActionButton label="Merge" primary disabled={busy} onClick={() => setConfirming(true)} />
        )
      ) : null}
    </>
  );
}

function MergeRequestBanner() {
  const { scope } = useComposer();
  const threadId = scope.kind === "thread" ? scope.threadId : "";
  const environmentId = useThreadEnvironmentId(threadId);
  const row = useRow(environmentId);
  if (row?.outcome === "unavailable") {
    // A failure is shown, not hidden: a missing login or an offline machine
    // would otherwise look the same as a branch with no merge request.
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" title={row.message}>
        <Icon name="TriangleAlert" className="size-3.5 shrink-0 text-yellow-500" />
        <span className="min-w-0 truncate">GitLab merge request unavailable: {row.message}</span>
      </div>
    );
  }
  const mr = row?.outcome === "available" ? row.mergeRequest : null;
  if (!mr || !environmentId) return null;
  const look = stateLook(mr.state);
  const pipeline = pipelineLook(mr.pipeline.state);
  const attention = attentionLabel(mr.attention);
  const approvals = approvalsLabel(mr);
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <UrlLink href={mr.url} title={summary(mr)} className="flex min-w-0 flex-1 items-center gap-2 hover:text-foreground">
        <Icon name={look.icon} className={cn("size-3.5 shrink-0", look.tone)} />
        <span className="shrink-0 tabular-nums">!{mr.iid}</span>
        <span className="min-w-0 truncate">{mr.title}</span>
      </UrlLink>
      {mr.autoMerge ? <Chip look={{ icon: "GitMerge", tone: "text-emerald-500" }}>Auto-merge</Chip> : null}
      {pipeline ? <Chip look={pipeline}>{mr.pipeline.state}</Chip> : null}
      {approvals ? <span className="shrink-0">{approvals}</span> : null}
      {attention && mr.state !== "merged" ? <span className="shrink-0">{attention}</span> : null}
      {mr.state === "merged" || mr.state === "closed" ? (
        <span className={cn("shrink-0", look.tone)}>{look.label}</span>
      ) : null}
      <MergeRequestActions environmentId={environmentId} mr={mr} />
    </div>
  );
}

// ── Thread context card and Info tab ────────────────────────────────────

function MergeRequestCardRows({ environment }: ExperimentalThreadContextCardProps) {
  const row = useRow(environment?.id);
  if (row?.outcome === "unavailable") {
    return <ContextCardRow icon={"TriangleAlert" as never} label="Merge request unavailable" title={row.message} />;
  }
  const mr = row?.outcome === "available" ? row.mergeRequest : null;
  if (!mr) return null;
  const look = stateLook(mr.state);
  const pipeline = pipelineLook(mr.pipeline.state);
  const approvals = approvalsLabel(mr);
  const open = () => window.open(mr.url, "_blank", "noopener,noreferrer");
  return (
    <>
      <ContextCardRow
        icon={look.icon as never}
        label={`!${mr.iid} ${mr.title}`}
        trailing={<span className={look.tone}>{look.label}</span>}
        title={summary(mr)}
        onClick={open}
      />
      {pipeline ? (
        <ContextCardRow
          icon={pipeline.icon as never}
          label={pipeline.label}
          trailing={approvals ?? attentionLabel(mr.attention) ?? undefined}
          onClick={mr.pipeline.url ? () => window.open(mr.pipeline.url!, "_blank", "noopener,noreferrer") : undefined}
        />
      ) : null}
    </>
  );
}

function MergeRequestInfoRow({ environment }: ExperimentalThreadInfoProps) {
  const mr = useMergeRequest(environment?.id);
  if (!mr) return null;
  const look = stateLook(mr.state);
  return (
    <DetailRow label="Merge request" icon={look.icon as never}>
      <UrlLink href={mr.url} title={summary(mr)} className="hover:underline">
        !{mr.iid} · {look.label}
      </UrlLink>
    </DetailRow>
  );
}

// ── Thread row badge ────────────────────────────────────────────────────

type RowData = Record<string, MergeRequestRow> | undefined;

function useRowData({ threads }: ExperimentalThreadRowMetadataDataInput): RowData {
  return useRows(threads.flatMap((thread) => (thread.environment?.id ? [thread.environment.id] : [])));
}

function MergeRequestBadge({ thread, data }: ExperimentalThreadRowMetadataProps<RowData>) {
  const row = thread.environment?.id ? data?.[thread.environment.id] : undefined;
  if (row?.outcome !== "available") return null;
  const mr = row.mergeRequest;
  const look = stateLook(mr.state);
  const pipeline = pipelineLook(mr.pipeline.state);
  const trouble = mr.pipeline.state === "failed" || mr.mergeability.state === "conflicts";
  return (
    <span title={summary(mr)} className={cn("inline-flex shrink-0 items-center gap-1 text-xs tabular-nums", look.tone)}>
      <Icon name={look.icon} className="size-3" />!{mr.iid}
      {mr.state === "open" || mr.state === "draft" ? (
        trouble ? (
          <Icon name="CircleX" className="size-3 text-red-500" />
        ) : pipeline && (mr.pipeline.state === "running" || mr.pipeline.state === "pending") ? (
          <Icon name="CircleDot" className="size-3 text-yellow-500" />
        ) : null
      ) : null}
    </span>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "gitlab-mr-status",
    scopes: ["thread"],
    banners: [{ id: "merge-request", component: MergeRequestBanner }],
  });
  app.slots.experimental_threadContextCardRow({
    id: "merge-request",
    group: ROW_GROUPS.pullRequest,
    order: 20,
    component: MergeRequestCardRows,
  });
  app.slots.experimental_threadInfoRow({
    id: "merge-request",
    group: ROW_GROUPS.pullRequest,
    order: 20,
    component: MergeRequestInfoRow,
  });
  app.slots.experimental_threadRowMetadata<RowData>({
    id: "merge-request",
    order: 20,
    useData: useRowData,
    component: MergeRequestBadge,
  });
});
