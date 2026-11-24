# bb-plugin-claude-profiles

Use several Claude Code accounts in bb: a default account per project, and a
per-thread override. Each Claude Code command a thread runs gets its
account's `CLAUDE_CONFIG_DIR` (and, for accounts with a `claude setup-token`
token or a Console API key, a wrapper as `BB_CLAUDE_CODE_EXECUTABLE` that
exports `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) through
`bb.providers.experimental_contributeEnv("claude-code", …)`.

## Formerly claude-accounts

This plugin was called `claude-accounts` up to 0.2.2. bb keeps a plugin's
saved data under its id, so accounts, defaults and thread picks don't carry
over. Re-add each account with `bb claude-profiles add` (or Settings → Claude
profiles) and set the defaults again. Threads pinned under the old plugin are
pinned again on their next run.

The old plugin also left files on each machine that ran its threads: the
token or API key file and wrapper for each token account, in
`~/.bb/plugins/claude-accounts/host-data/profiles/<id>/`. Uninstall
`claude-accounts`, then delete that folder if it is still there.

- `resolve.ts`: profile shapes, token and API key validation, the pinning
  order, and the wrapper script. Pure, shared by every entry.
- `server.ts`: profiles and defaults in kv, tokens in kv (server-only), the
  env resolver, thread pinning in thread plugin metadata, the RPC methods, and
  the `bb claude-profiles` CLI.
- `host.ts` and `contract.ts`: work on the thread's machine: home dir, login
  check, token wrapper, and copying a session transcript between config dirs.
- `app.tsx`: the Settings section, the thread menu's "Claude account" submenu
  with its consent dialog, the Thread Info row, and the new-thread composer
  picker.
- `skills/claude-profiles/SKILL.md`: commands and rules injected into threads.

```sh
npm install
npm test           # pinning order, consent, secrets never exposed, transcript copy
npm run typecheck
bb plugin build
bb plugin install .
```
