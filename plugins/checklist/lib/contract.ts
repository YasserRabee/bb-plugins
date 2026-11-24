// Shared by server.ts and app.tsx: imports only zod, so the app bundle stays small.
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

// A plain object (not defineRpcContract) so the app bundle can import it.
export const rpcContract = {
  checklist_get: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    // `pinned` drives the banner above the composer: a fully completed list
    // stays pinned until the thread's next turn starts.
    output: z.object({ todos: z.array(todoSchema), pinned: z.boolean() }),
  },
  /** Keyed read for thread rows: progress per thread id (up to 200). */
  checklist_progress: {
    input: z.object({ keys: z.array(z.string().max(200)).max(200) }),
    output: z.record(
      z.string(),
      z.object({ done: z.number(), total: z.number(), active: z.string().optional() }),
    ),
    keyTags: (threadId: string) => [`list:${threadId}`],
  },
};

/** Realtime channel; payload `{ threadId }` names the list that changed. */
export const CHECKLIST_CHANGED = "checklist-changed";
