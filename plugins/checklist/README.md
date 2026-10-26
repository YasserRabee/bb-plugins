# bb-plugin-checklist

A per-thread live checklist for bb. Agents call `todo_write` (each call
replaces the thread's list); the thread's **Checklist** tab and a header
progress pill update over realtime.

- `server.ts` — the `todo_write` tool, kv storage keyed by thread id, the
  `checklist_get` RPC, and the `checklist-changed` realtime signal.
- `app.tsx` — the fixed thread tab, the header progress pill, and a
  composer banner pinned above the input box.
- `skills/checklist/SKILL.md` — tool and UI notes injected into threads.

```sh
npm install
npm test           # tool validation + replace semantics
npm run typecheck
bb plugin build
bb plugin install .
```
