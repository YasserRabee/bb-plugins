---
name: claude-profiles
description: How the Claude Profiles plugin picks which Claude Code account (profile) a thread runs on, and the `bb claude-profiles` commands to add accounts, set project defaults, and switch a thread. Use when the user asks which Claude account a thread or project uses, wants to add or change one, or a thread hits another account's usage limit.
---

# Claude Profiles

An account is a Claude Code profile with a `CLAUDE_CONFIG_DIR` on each
machine that runs threads, a secret, or both. The secret is either a
`claude setup-token` OAuth token (sk-ant-oat01-, billed to a Pro/Max
subscription) or an Anthropic Console API key (sk-ant-api03-, billed per
token to a Console org; lists show it as "API key"). A
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
bb claude-profiles list [--json]
bb claude-profiles add <label> --config-dir ~/.claude-work   # profile dir
echo "$TOKEN" | bb claude-profiles add <label> --token-stdin # token (never as an argument)
echo "$KEY" | bb claude-profiles add <label> --api-key-stdin  # Console API key, likewise
bb claude-profiles add <label> --id <id> ...                 # update one
bb claude-profiles check <id|system> [--json]                # live login check, plan, usage
bb claude-profiles default <id|system|none> [--project <project-id>]
bb claude-profiles status [--thread <id>] [--json]
bb claude-profiles use <id|system> [--thread <id>] [--confirm]
bb claude-profiles remove <id>
```

To log a config dir in, the user runs `CLAUDE_CONFIG_DIR=<dir> claude` and
then `/login` on that machine. Do not run that for them.

## Rules

- Switching a thread that already has a conversation copies its transcript
  into the new account's config dir, and the next turn runs and bills there.
  `use` refuses without `--confirm`. Pass `--confirm` only when the user has
  explicitly agreed to switch that thread.
- Never put a token or API key in a command argument, file, or chat; pipe it
  with `--token-stdin` or `--api-key-stdin`. An account holds one of the
  two: adding either replaces the other.
- Do not change defaults or switch threads unless the user asked.

## Limits and login checks

`check` asks Anthropic, on each machine, whether the account's login is
accepted, and reports "revoked or expired" apart from missing files. For
`/login` accounts it also shows the plan (Pro, Max 5x…) and the 5h and
weekly usage, e.g. "82% of 5h · resets 14:00"; the pickers show the 5h line.
Setup-tokens show only accepted or revoked, and API keys have no such limits.
When a thread hits a usage limit, run `check` on the other accounts and
suggest one with room; switch only if the user agrees.

## Constraints

- A config dir is a path on the thread's machine; it must exist and be logged
  in on every machine where it is used. `check` reports each machine.
- Tokens and API keys stay on the bb server. Each machine gets a 0600 file
  and a wrapper set as `BB_CLAUDE_CODE_EXECUTABLE`, so the secret never
  appears in the thread timeline. The wrapper exports it as
  `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, unsets the env
  credentials Claude Code would prefer (`ANTHROPIC_AUTH_TOKEN`, the other
  secret, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`), and runs `claude` from
  `PATH`. `ANTHROPIC_API_KEY` already beats `apiKeyHelper` and a `/login`
  subscription; an `env` block in the config dir's `settings.json` (or
  managed settings) that sets those variables can still override it.
- A removed account makes its pinned threads fail to start rather than
  silently using another login; switch those threads to another account.
- Only Claude Code threads are affected.
