// bb-plugin-checklist — a per-thread live checklist the agent keeps with the
// `todo_write` tool. Each call replaces the thread's whole list (the same
// model as Claude Desktop's TodoWrite). Lists live in this plugin's kv on the
// BB server, keyed by thread id, so threads on any machine share one store.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_TODOS = 50;
const MAX_TEXT = 300;

const todoSchema = z.object({
  content: z.string().trim().min(1).max(MAX_TEXT),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().trim().min(1).max(MAX_TEXT).optional(),
});
export type Todo = z.infer<typeof todoSchema>;

export const todoWriteParameters = z.object({
  todos: z.array(todoSchema).max(MAX_TODOS),
});

export const rpcContract = defineRpcContract({
  checklist_get: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: z.object({ todos: z.array(todoSchema) }),
  },
});

/** Realtime channel; payload `{ threadId }` names the list that changed. */
export const CHECKLIST_CHANGED = "checklist-changed";

const key = (threadId: string) => `list:${threadId}`;

export function summarize(todos: Todo[]): string {
  if (todos.length === 0) return "Checklist cleared.";
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  const now = active ? `; now: ${active.activeForm ?? active.content}` : "";
  return `${done}/${todos.length} done${now}`.slice(0, 400);
}

export default async function plugin(bb: BbPluginApi) {
  async function readList(threadId: string): Promise<Todo[]> {
    return (await bb.storage.kv.get<Todo[]>(key(threadId))) ?? [];
  }

  bb.agents.registerTool({
    name: "todo_write",
    description:
      "Replace this thread's checklist with the given todos. The user sees it live in the thread's Checklist tab. Send the full list every call.",
    instructions: [
      "Use `todo_write` to keep a visible checklist when the work has 3 or more steps or the user gives several tasks.",
      "Each call replaces the whole list, so always send every item.",
      "Keep exactly one item `in_progress` while working, with `activeForm` in present continuous (\"Running tests\").",
      "Mark an item `completed` immediately after finishing it; don't batch completions.",
      "Don't use it for trivial one-step work. Send an empty list to clear it.",
    ].join("\n"),
    presentation: {
      label: { pending: "Updating checklist", completed: "Updated checklist" },
      icon: { glyph: "ListTodo" },
      suppress: true,
    },
    parameters: todoWriteParameters,
    async execute({ todos }, { threadId }) {
      if (todos.length === 0) await bb.storage.kv.delete(key(threadId));
      else await bb.storage.kv.set(key(threadId), todos);
      bb.realtime.publish(CHECKLIST_CHANGED, { threadId });
      return summarize(todos);
    },
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    await bb.storage.kv.delete(key(thread.id));
  });

  bb.rpc.register(rpcContract, {
    checklist_get: async ({ threadId }) => ({ todos: await readList(threadId) }),
  });
}
