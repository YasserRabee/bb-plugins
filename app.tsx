// bb-plugin-checklist — the thread's Checklist tab, a progress pill in the
// thread header, and a list pinned above the composer. All read the list over RPC and refetch on the server's
// "checklist-changed" signal for their thread.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_useAppPanel,
  useRealtime,
  useComposer,
  useRpc,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Todo } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// Must match CHECKLIST_CHANGED in server.ts (a value import would bundle it).
const CHECKLIST_CHANGED = "checklist-changed";

const TAB = {
  id: "checklist",
  context: { kind: "thread" },
  availability: "fixed",
} as const;

function useChecklist(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("checklist_get", { threadId }).then(
      (result) => {
        setTodos(result.todos);
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
  return { todos, error };
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

// Pinned above the thread's composer while any item is unfinished, like
// Claude's todo list; it disappears once everything is done.
function ComposerChecklist() {
  const { scope } = useComposer();
  const threadId = scope.kind === "thread" ? scope.threadId : "";
  const { todos } = useChecklist(threadId);
  const [open, setOpen] = useState(true);
  if (todos === null || todos.every((todo) => todo.status === "completed")) {
    return null;
  }
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <Icon name="ListTodo" className="size-3.5 shrink-0" />
        <span className="tabular-nums">
          {done}/{todos.length}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {open ? "Checklist" : (active?.activeForm ?? active?.content ?? "Checklist")}
        </span>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0" />
      </button>
      {open ? (
        <div className="max-h-48 overflow-y-auto px-3 pb-2.5">
          <TodoList todos={todos} />
        </div>
      ) : null}
    </div>
  );
}

// ponytail: thread tabs have no badge API in SDK 0.6.79 (experimental_useBadge
// is nav-panel only), so progress shows here; move it onto the tab if one lands.
function ProgressPill({ threadId }: PluginThreadHeaderActionProps) {
  const { todos } = useChecklist(threadId);
  const panel = experimental_useAppPanel();
  if (todos === null || todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <button
      type="button"
      onClick={() => panel.experimental_openTab({ surface: { kind: "current" }, tab: TAB })}
      aria-label={`Checklist: ${done} of ${todos.length} done`}
      title="Open checklist"
      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon name="ListTodo" className="size-3.5" />
      {done}/{todos.length}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    ...TAB,
    title: "Checklist",
    icon: "ListTodo",
    component: ChecklistTab,
  });
  app.slots.experimental_threadHeaderAction({
    id: "checklist-progress",
    title: "Checklist progress",
    component: ProgressPill,
  });
  app.composer.customize({
    id: "checklist",
    scopes: ["thread"],
    banners: [{ id: "checklist", component: ComposerChecklist }],
  });
});
