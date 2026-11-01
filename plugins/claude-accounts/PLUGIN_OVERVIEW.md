Run Claude Code threads on different Claude accounts: a work account for one
project, a personal one for another, and a switch per thread when you need it.

## What you get

- **Settings → Claude accounts**: add accounts as a Claude config folder
  (`~/.claude-work`), a `claude setup-token` token, or both. Each one shows
  whether it is logged in on every machine.
- **Defaults**: one for all projects, one per project.
- **New-thread picker**: choose a different account for the thread you are
  about to start, or make it the project's default.
- **Thread menu → Claude account**: switch a thread. If it already has a
  conversation, bb asks first, then copies the conversation to the new account
  so it continues where it left off.
- **Thread Info**: shows each thread's account and where it came from.
- `bb claude-accounts` commands for the same things.

## How it works

Each thread is pinned to an account on its first run. bb then starts Claude
Code with that account's config folder, or a small wrapper that supplies its
token. Tokens stay on the bb server and never appear in the thread timeline.
Without any accounts, threads use the machine's own Claude login as before.
