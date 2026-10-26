---
name: checklist
description: How the Checklist plugin's `todo_write` tool and thread Checklist tab work. Use when planning multi-step work, when the user gives several tasks, or when the user asks about the thread's checklist or progress.
---

# Checklist

The Checklist plugin gives every thread one live checklist. The agent writes
it with the `todo_write` tool; the user sees it in the thread's **Checklist**
tab, as a `done/total` pill in the thread header, and pinned above the
composer. A fully completed list stays pinned until the thread's next turn
starts; the tab keeps it after that.

## The tool

`todo_write({ todos: [{ content, status, activeForm? }] })`

- `status` is `pending`, `in_progress`, or `completed`.
- `activeForm` is the present-continuous label ("Running tests") shown while
  the item is `in_progress`.
- Each call **replaces the whole list** for this thread. Always send every item.
- Send `todos: []` to clear the list.
- Limits: at most 50 items; `content` and `activeForm` are 1–300 characters.
- Returns a short summary such as `3/7 done; now: Running tests`.

## Rules

- Use it for work with 3 or more steps, or when the user gives several tasks.
  Skip it for trivial one-step work.
- Keep exactly one item `in_progress` while working.
- Mark an item `completed` as soon as it is finished; don't batch updates.

## Constraints

- The tool attaches when a provider session starts, so threads already running
  when the plugin was installed or updated don't have it until their session
  restarts.
- The list lives in the plugin's storage on the BB server, keyed by thread id.
  The UI is read-only.
