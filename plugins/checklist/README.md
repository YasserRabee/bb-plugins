# bb-plugin-checklist

A per-thread live checklist for bb. Agents call `todo_write` (each call
replaces the thread's list); the thread's **Checklist** tab and a `done/total`
badge on its thread row update over realtime. The badge shows when Organize →
Rows → Metadata is on.

- `server.ts` — the `todo_write` tool, kv storage keyed by thread id, the
  `checklist_get` and keyed `checklist_progress` RPCs, and the `checklist-changed` realtime signal. It also
  keeps the agent on its list: `todo_write` returns the whole list, a new or
  resumed session gets the open list in its instructions, and a compaction
  during a turn steers the agent with an agent-only reminder.
- `app.tsx` — the fixed thread tab, the thread-row progress badge, and a
  composer banner pinned above the input box.
- `skills/checklist/SKILL.md` — tool and UI notes injected into threads.

```sh
npm install
npm test           # tool validation, replace semantics, compaction reminder
npm run typecheck
bb plugin build
bb plugin install .
```
