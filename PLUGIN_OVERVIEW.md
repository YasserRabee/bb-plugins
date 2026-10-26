Give every thread a live checklist the agent keeps as it works, like Claude
Desktop's todo list.

## What you get

- A `todo_write` tool for every agent provider (Claude Code, Codex, Pi). The
  agent sends the whole list each time it plans or finishes a step.
- A **Checklist** tab on each thread showing pending, in-progress, and done
  items, updating live.
- The list pinned above the input box while work is unfinished, collapsible
  to one line showing the current step.
- A `done/total` pill in the thread header that opens the tab.

## How it works

Each thread's list lives in this plugin's own storage on the BB server, so it
works for threads on any machine. Nothing leaves the server, and the plugin
needs no account or API key.
