---
name: claude-accounts
description: How the Claude Accounts plugin picks which Claude Code account (profile) a thread runs on, and the `bb claude-accounts` commands to add accounts, set project defaults, and switch a thread. Use when the user asks which Claude account a thread or project uses, wants to add or change one, or a thread hits another account's usage limit.
---

# Claude Accounts

An account is a Claude Code profile with a `CLAUDE_CONFIG_DIR` on each
machine that runs threads, a `claude setup-token` OAuth token, or both. A
thread is pinned to one account on its first run and keeps it until someone
switches it:

1. the account picked in the new-thread composer,
2. for a fork, its source thread's account,
3. the project's default,
4. the global default,
5. otherwise `system`, the machine's own Claude login (bb's normal behavior).

Changing a default affects only threads started afterwards.

## Commands

```sh
bb claude-accounts list [--json]
bb claude-accounts add <label> --config-dir ~/.claude-work   # profile dir
echo "$TOKEN" | bb claude-accounts add <label> --token-stdin # token (never as an argument)
bb claude-accounts add <label> --id <id> ...                 # update one
bb claude-accounts check <id|system> [--json]                # login per machine
bb claude-accounts default <id|system|none> [--project <project-id>]
bb claude-accounts status [--thread <id>] [--json]
bb claude-accounts use <id|system> [--thread <id>] [--confirm]
bb claude-accounts remove <id>
```

To log a config dir in, the user runs `CLAUDE_CONFIG_DIR=<dir> claude` and
then `/login` on that machine. Do not run that for them.

## Rules

- Switching a thread that already has a conversation copies its transcript
  into the new account's config dir, and the next turn runs and bills there.
  `use` refuses without `--confirm`. Pass `--confirm` only when the user has
  explicitly agreed to switch that thread.
- Never put a token in a command argument, file, or chat; pipe it with
  `--token-stdin`.
- Do not change defaults or switch threads unless the user asked.

## Constraints

- A config dir is a path on the thread's machine; it must exist and be logged
  in on every machine where it is used. `check` reports each machine.
- Tokens stay on the bb server. Each machine gets a 0600 token file and a
  wrapper set as `BB_CLAUDE_CODE_EXECUTABLE`, so the token never appears in
  the thread timeline. The wrapper runs `claude` from `PATH`.
- A removed account makes its pinned threads fail to start rather than
  silently using another login; switch those threads to another account.
- Only Claude Code threads are affected.
