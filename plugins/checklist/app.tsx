// bb-plugin-checklist — the thread's Checklist tab, a progress badge on its
// thread row, and a list pinned above the composer. All read the list over RPC and refetch on the server's
// "checklist-changed" signal for their thread.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_useAppPanel,
  experimental_usePluginId,
  experimental_useRpcKeyedQuery,
  useRealtime,
  useComposer,
  useRpc,
  type ExperimentalThreadRowMetadataDataInput,
  type ExperimentalThreadRowMetadataProps,
} from "@get-bb/plugin-sdk/app";
import { CHECKLIST_CHANGED, rpcContract, type Todo } from "@/lib/contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const TAB = {
  id: "checklist",
  context: { kind: "thread" },
  availability: "fixed",
} as const;

function useChecklist(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("checklist_get", { threadId }).then(
      (result) => {
        setTodos(result.todos);
        setPinned(result.pinned);
        setError(null);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime(CHECKLIST_CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) {
      refetch();
    }
  });
  return { todos, pinned, error };
}

const STATUS_ICON = {
  pending: { name: "Circle", className: "text-muted-foreground" },
  in_progress: { name: "Loading", className: "animate-spin text-primary" },
  completed: { name: "CircleCheck", className: "text-muted-foreground" },
} as const;

function ChecklistTab({ threadId }: { threadId: string }) {
  const { todos, error } = useChecklist(threadId);
  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (todos === null || todos.length === 0) {
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
      >
        {todos === null
          ? "Loading checklist…"
          : "No checklist yet. The agent creates one for multi-step work."}
      </div>
    );
  }
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <div className="text-sm">
      <p className="mb-2 text-xs text-muted-foreground">
        {done} of {todos.length} done
      </p>
      <TodoList todos={todos} />
    </div>
  );
}

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="space-y-1.5">
      {todos.map((todo, index) => {
        const icon = STATUS_ICON[todo.status];
        return (
          <li key={index} className="flex items-start gap-2">
            <Icon
              name={icon.name}
              className={cn("mt-0.5 size-4 shrink-0", icon.className)}
              aria-label={todo.status.replace("_", " ")}
            />
            <span
              className={cn(
                "min-w-0 break-words",
                todo.status === "completed" &&
                  "text-muted-foreground line-through",
                todo.status === "in_progress" && "font-medium",
              )}
            >
              {todo.status === "in_progress"
                ? (todo.activeForm ?? todo.content)
                : todo.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// The banner shows the step in progress and the next few; the tab has the rest.
const UPCOMING = 3;

// Each thread remembers whether its banner is open, in this browser only.
function useOpenState(threadId: string, defaultOpen: boolean) {
  const storageKey = `${experimental_usePluginId()}:open:${threadId}`;
  const read = useCallback((): boolean | null => {
    try {
      const value = localStorage.getItem(storageKey);
      return value === null ? null : value === "1";
    } catch {
      return null;
    }
  }, [storageKey]);
  const [saved, setSaved] = useState(read);
  useEffect(() => setSaved(read()), [read]);
  const setOpen = (open: boolean) => {
    setSaved(open);
    try {
      localStorage.setItem(storageKey, open ? "1" : "0");
    } catch {
      // Private mode or blocked storage: the choice lasts until reload.
    }
  };
  return [saved ?? defaultOpen, setOpen] as const;
}

// Pinned above the thread's composer like Claude's todo list. A finished list
// stays until the thread's next turn starts (the server then unpins it).
function ComposerChecklist() {
  const { scope } = useComposer();
  const threadId = scope.kind === "thread" ? scope.threadId : "";
  const { todos, pinned } = useChecklist(threadId);
  const panel = experimental_useAppPanel();
  const done = todos?.filter((todo) => todo.status === "completed").length ?? 0;
  const allDone = todos !== null && done === todos.length;
  const [open, setOpen] = useOpenState(threadId, !allDone);
  if (todos === null || todos.length === 0 || !pinned) return null;
  const active = todos.find((todo) => todo.status === "in_progress");
  const remaining = todos.filter((todo) => todo.status !== "completed");
  const shown = remaining.slice(0, (active ? 1 : 0) + UPCOMING);
  const more = remaining.length - shown.length;
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <Icon name={allDone ? "CircleCheck" : "ListTodo"} className="size-3.5 shrink-0" />
        <span className="tabular-nums">
          {done}/{todos.length}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {allDone
            ? `All ${todos.length} done`
            : open
              ? "Checklist"
              : (active?.activeForm ?? active?.content ?? "Checklist")}
        </span>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0" />
      </button>
      {open ? (
        <div className="space-y-1.5 px-3 pb-2.5">
          {allDone ? (
            <div className="max-h-48 overflow-y-auto">
              <TodoList todos={todos} />
            </div>
          ) : (
            <>
              {done > 0 ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Icon name="CircleCheck" className="size-4 shrink-0" />
                  {done} completed
                </p>
              ) : null}
              <TodoList todos={shown} />
              {more > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    panel.openTab({ tab: TAB })
                  }
                  className="pl-6 text-xs text-muted-foreground hover:text-foreground"
                >
                  +{more} more
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

type Progress = Record<string, { done: number; total: number; active?: string }> | undefined;

function useProgress({ threads }: ExperimentalThreadRowMetadataDataInput): Progress {
  const keys = threads.map((thread) => thread.id);
  const { data } = experimental_useRpcKeyedQuery({
    contract: rpcContract,
    method: "checklist_progress",
    keys,
    enabled: keys.length > 0,
  });
  return data;
}

// The thread row's metadata line: "3/5" while a list exists.
function ProgressBadge({ thread, data }: ExperimentalThreadRowMetadataProps<Progress>) {
  const progress = data?.[thread.id];
  if (!progress || progress.total === 0) return null;
  const finished = progress.done === progress.total;
  return (
    <span
      title={progress.active ? `Checklist: ${progress.active}` : "Checklist"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs tabular-nums",
        finished ? "text-muted-foreground" : "text-foreground",
      )}
    >
      <Icon name={finished ? "CircleCheck" : "ListTodo"} className="size-3" />
      {progress.done}/{progress.total}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    ...TAB,
    title: "Checklist",
    icon: "ListTodo",
    component: ChecklistTab,
  });
  app.slots.experimental_threadRowMetadata<Progress>({
    id: "checklist-progress",
    order: 30,
    useData: useProgress,
    component: ProgressBadge,
  });
  app.composer.customize({
    id: "checklist",
    scopes: ["thread"],
    banners: [{ id: "checklist", component: ComposerChecklist }],
  });
});
