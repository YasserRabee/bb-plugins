// bb-plugin-checklist — a per-thread live checklist the agent keeps with the
// `todo_write` tool. Each call replaces the thread's whole list (the same
// model as Claude Desktop's TodoWrite). Lists live in this plugin's kv on the
// BB server, keyed by thread id, so threads on any machine share one store.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CHECKLIST_CHANGED,
  MAX_TODOS,
  rpcContract,
  todoWriteParameters,
  type Todo,
} from "./lib/contract.ts";

export {
  CHECKLIST_CHANGED,
  MAX_TODOS,
  rpcContract,
  todoWriteParameters,
  type Todo,
} from "./lib/contract.ts";

const MAX_INSTRUCTIONS = 4096;

const key = (threadId: string) => `list:${threadId}`;
const unpinnedKey = (threadId: string) => `unpinned:${threadId}`;
// When the list was last written (epoch ms), and the seq of the last
// compaction the agent was reminded about.
const writtenKey = (threadId: string) => `written:${threadId}`;
const remindedKey = (threadId: string) => `reminded:${threadId}`;

const NUDGE =
  "Mark each item completed as soon as it is done, and call todo_write again whenever the plan changes.";

export function summarize(todos: Todo[]): string {
  if (todos.length === 0) return "Checklist cleared.";
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  const now = active ? `; now: ${active.activeForm ?? active.content}` : "";
  return `${done}/${todos.length} done${now}`.slice(0, 400);
}

const MARK = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;

/** The list as `[x] / [>] / [ ]` lines, for the agent to read back. */
export function renderList(todos: Todo[]): string {
  return todos.map((todo) => `${MARK[todo.status]} ${todo.content}`).join("\n");
}

const unfinished = (todos: Todo[]) =>
  todos.some((todo) => todo.status !== "completed");

/** What todo_write returns: the summary, then the list while work remains. */
export function toolResult(todos: Todo[]): string {
  const summary = summarize(todos);
  if (!unfinished(todos)) return summary;
  return `${summary}\n${renderList(todos)}\n${NUDGE}`;
}

/** Instructions that hand an unfinished list back to a new or resumed session. */
export function listInstructions(todos: Todo[]): string | undefined {
  if (!unfinished(todos)) return undefined;
  return [
    "This thread already has a checklist. Keep it current with `todo_write` (send the whole list), or clear it with an empty list if the work is no longer relevant:",
    renderList(todos),
  ]
    .join("\n")
    .slice(0, MAX_INSTRUCTIONS);
}

/** The agent-only steer sent after a compaction with work still open. */
export function compactionReminder(todos: Todo[]): string {
  return [
    "Your context was just compacted. This thread's checklist is still open:",
    renderList(todos),
    `Keep it current with todo_write (send the whole list). ${NUDGE}`,
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  // configure() is synchronous, so it reads lists from this cache. It fills
  // on every write and whenever a thread starts a turn or emits events.
  const cache = new Map<string, Todo[]>();
  async function readList(threadId: string): Promise<Todo[]> {
    const cached = cache.get(threadId);
    if (cached) return cached;
    const todos = (await bb.storage.kv.get<Todo[]>(key(threadId))) ?? [];
    cache.set(threadId, todos);
    return todos;
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
      "After your context is compacted, send the list again with its current statuses.",
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
      cache.set(threadId, todos);
      await bb.storage.kv.set(writtenKey(threadId), Date.now());
      await bb.storage.kv.delete(unpinnedKey(threadId));
      bb.realtime.publish(CHECKLIST_CHANGED, { threadId });
      bb.rpc.experimental_invalidate([`list:${threadId}`]);
      return toolResult(todos);
    },
  });

  bb.agents.configure(({ thread }) => ({
    tools: ["todo_write"],
    skills: ["checklist"],
    instructions: listInstructions(cache.get(thread.id) ?? []),
  }));

  // ponytail: "next turn" = thread.active, so any turn (a user prompt, or a
  // subthread report waking it) unpins a finished list; SDK has no prompt event.
  bb.events.on("thread.active", async ({ thread }) => {
    const todos = await readList(thread.id);
    if (todos.length === 0 || unfinished(todos)) return;
    await bb.storage.kv.set(unpinnedKey(thread.id), true);
    bb.realtime.publish(CHECKLIST_CHANGED, { threadId: thread.id });
  });

  // After a compaction mid-turn, steer the agent with its open list. Only an
  // active thread gets one: a steer to an idle thread would start a turn.
  const checking = new Set<string>();
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (thread.status !== "active" || checking.has(thread.id)) return;
    checking.add(thread.id);
    try {
      const todos = await readList(thread.id);
      if (!unfinished(todos)) return;
      const [compaction] = await bb.sdk.threads.events.list({
        threadId: thread.id,
        types: ["thread/compacted"],
        order: "desc",
        limit: "1",
      });
      if (!compaction) return;
      const written = (await bb.storage.kv.get<number>(writtenKey(thread.id))) ?? 0;
      const reminded = (await bb.storage.kv.get<number>(remindedKey(thread.id))) ?? 0;
      if (compaction.createdAt <= written || compaction.seq <= reminded) return;
      await bb.storage.kv.set(remindedKey(thread.id), compaction.seq);
      await bb.sdk.threads.send({
        threadId: thread.id,
        mode: "steer",
        input: [
          { type: "text", text: compactionReminder(todos), mentions: [], visibility: "agent-only" },
        ],
      });
    } catch (error) {
      bb.log.warn(`checklist: compaction reminder failed for ${thread.id}: ${String(error)}`);
    } finally {
      checking.delete(thread.id);
    }
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    cache.delete(thread.id);
    for (const k of [key, unpinnedKey, writtenKey, remindedKey]) {
      await bb.storage.kv.delete(k(thread.id));
    }
  });

  bb.rpc.register(rpcContract, {
    checklist_get: async ({ threadId }) => ({
      todos: await readList(threadId),
      pinned: !(await bb.storage.kv.get<boolean>(unpinnedKey(threadId))),
    }),
    checklist_progress: async ({ keys }) =>
      Object.fromEntries(
        await Promise.all(
          keys.map(async (threadId) => {
            const todos = await readList(threadId);
            const active = todos.find((todo) => todo.status === "in_progress");
            return [
              threadId,
              {
                done: todos.filter((todo) => todo.status === "completed").length,
                total: todos.length,
                // RPC results must be JSON: omit the key rather than send undefined.
                ...(active ? { active: active.activeForm ?? active.content } : {}),
              },
            ] as const;
          }),
        ),
      ),
  });
}
