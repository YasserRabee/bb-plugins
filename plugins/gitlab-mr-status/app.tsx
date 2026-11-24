// bb-plugin-gitlab-mr-status — GitLab merge request status in four places:
// a banner above the composer, rows in the thread context card (and the Info
// tab), and a badge on thread rows. All read the keyed `mergeRequests` method.
// Chat messages get MR chips with hover cards: chips above messages that
// mention an MR (`messageRefs`) and the agent's `::gitlab-mr` directive, both
// reading `mergeRequestRefs`.
import { useState, type ReactNode } from "react";
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
  useSettings,
  type ExperimentalMessageMetadataProps,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadInfoProps,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
  type PluginMessageDirectiveProps,
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
import { formatRef, parseRef } from "./lib/refs";
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
        <Icon name="gitlab-mr-status/triangle-alert" className="size-3.5 shrink-0 text-yellow-500" />
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
      {mr.autoMerge ? <Chip look={{ icon: "gitlab-mr-status/git-merge", tone: "text-emerald-500" }}>Auto-merge</Chip> : null}
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
    return <ContextCardRow icon={"gitlab-mr-status/triangle-alert" as never} label="Merge request unavailable" title={row.message} />;
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
          <Icon name="gitlab-mr-status/circle-x" className="size-3 text-red-500" />
        ) : pipeline && (mr.pipeline.state === "running" || mr.pipeline.state === "pending") ? (
          <Icon name="gitlab-mr-status/circle-dot" className="size-3 text-yellow-500" />
        ) : null
      ) : null}
    </span>
  );
}

// ── Merge requests in chat messages ────────────────────────────────────

/** The `messageReferences` setting: "both" while loading, like its default. */
function useMode() {
  const mode = useSettings().values?.messageReferences;
  return {
    chips: mode === undefined || mode === "both" || mode === "chips",
    directive: mode === undefined || mode === "both" || mode === "directive",
  };
}

/** Everything the composer banner shows, as a hover card under the chip. */
function MergeRequestCard({ mr }: { mr: MergeRequest }) {
  const look = stateLook(mr.state);
  const pipeline = pipelineLook(mr.pipeline.state);
  const approvals = approvalsLabel(mr);
  const attention = mr.state === "open" || mr.state === "draft" ? attentionLabel(mr.attention) : null;
  const ref = parseRef(mr.url);
  return (
    <span
      role="tooltip"
      className="pointer-events-none invisible absolute left-0 top-full z-50 mt-1 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5 rounded-lg border bg-popover p-3 text-left text-xs text-popover-foreground opacity-0 shadow-lg transition-opacity group-focus-within/mr:visible group-focus-within/mr:opacity-100 group-hover/mr:visible group-hover/mr:opacity-100"
    >
      <span className="truncate text-muted-foreground">
        {ref && "path" in ref ? ref.path : ""}!{mr.iid}
        {mr.author ? ` · ${mr.author}` : ""}
      </span>
      <span className="text-sm font-medium leading-snug">{mr.title}</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Chip look={look}>{look.label}</Chip>
        {pipeline ? <Chip look={pipeline}>{pipeline.label}</Chip> : null}
        {approvals ? <span>{approvals}</span> : null}
        {mr.autoMerge ? <Chip look={{ icon: "gitlab-mr-status/git-merge", tone: "text-emerald-500" }}>Auto-merge</Chip> : null}
      </span>
      <span className="truncate font-mono text-muted-foreground">
        {mr.sourceBranch} → {mr.targetBranch}
      </span>
      {attention ? <span>{attention}</span> : null}
    </span>
  );
}

/** One referenced MR as a chip with its hover card, or `fallback` until it resolves. */
function RefChip({ environmentId, refText, fallback }: { environmentId: string; refText: string; fallback: ReactNode }) {
  const key = `${environmentId} ${refText}`;
  const { data } = useRpcKeyedQuery({ contract: rpcContract, method: "mergeRequestRefs", keys: [key] });
  const row = (data as Record<string, MergeRequestRow> | undefined)?.[key];
  if (row?.outcome !== "available") return <>{fallback}</>;
  const mr = row.mergeRequest;
  const look = stateLook(mr.state);
  return (
    <span className="group/mr relative inline-flex max-w-full align-middle">
      <UrlLink
        href={mr.url}
        aria-label={summary(mr)}
        className="inline-flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs no-underline hover:bg-accent"
      >
        <Icon name={look.icon} className={cn("size-3.5 shrink-0", look.tone)} />
        <span className={cn("shrink-0 tabular-nums", look.tone)}>!{mr.iid}</span>
        <span className="min-w-0 max-w-64 truncate text-foreground">{mr.title}</span>
      </UrlLink>
      <MergeRequestCard mr={mr} />
    </span>
  );
}

/** Chips above a message for each MR it mentions; refs that do not resolve show nothing. */
function MessageMergeRequests({ message }: ExperimentalMessageMetadataProps) {
  const { chips } = useMode();
  const environmentId = useThreadEnvironmentId(message.threadId);
  const key = `${message.threadId} ${message.id}`;
  const enabled = chips && environmentId !== null;
  const { data } = useRpcKeyedQuery({ contract: rpcContract, method: "messageRefs", keys: enabled ? [key] : [], enabled });
  const refs = enabled ? ((data as Record<string, { refs: string[] }> | undefined)?.[key]?.refs ?? []) : [];
  if (!environmentId || refs.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-1">
      {refs.map((ref) => (
        <RefChip key={ref} environmentId={environmentId} refText={ref} fallback={null} />
      ))}
    </div>
  );
}

/** `::gitlab-mr{ref="!12"}` or `ref="https://…/-/merge_requests/12"`, written by the agent. */
function MergeRequestDirective({ attributes, source, message }: PluginMessageDirectiveProps) {
  const { directive } = useMode();
  const environmentId = useThreadEnvironmentId(message.threadId);
  const ref = parseRef(attributes.ref ?? "");
  if (!ref) return <>{source}</>;
  const text = formatRef(ref);
  const plain = "host" in ref ? <UrlLink href={text}>{text}</UrlLink> : <span>{text}</span>;
  if (!directive || !environmentId) return <div>{plain}</div>;
  return (
    <div>
      <RefChip environmentId={environmentId} refText={text} fallback={plain} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_messageMetadata({
    id: "merge-requests",
    placement: "above",
    component: MessageMergeRequests,
  });
  app.slots.messageDirective({ id: "gitlab-mr", component: MergeRequestDirective });
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
