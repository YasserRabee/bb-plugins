# bb-plugin-claude-accounts

Use several Claude Code accounts in bb: a default account per project, and a
per-thread override. Each Claude Code command a thread runs gets its
account's `CLAUDE_CONFIG_DIR` (and, for accounts with a `claude setup-token`
token or a Console API key, a wrapper as `BB_CLAUDE_CODE_EXECUTABLE` that
exports `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) through
`bb.providers.experimental_contributeEnv("claude-code", …)`.

- `resolve.ts`: profile shapes, token and API key validation, the pinning
  order, and the wrapper script. Pure, shared by every entry.
- `server.ts`: profiles and defaults in kv, tokens in kv (server-only), the
  env resolver, thread pinning in thread plugin metadata, the RPC methods, and
  the `bb claude-accounts` CLI.
- `host.ts` and `contract.ts`: work on the thread's machine: home dir, login
  check, token wrapper, and copying a session transcript between config dirs.
- `app.tsx`: the Settings section, the thread menu's "Claude account" submenu
  with its consent dialog, the Thread Info row, and the new-thread composer
  picker.
- `skills/claude-accounts/SKILL.md`: commands and rules injected into threads.

```sh
npm install
npm test           # pinning order, consent, secrets never exposed, transcript copy
npm run typecheck
bb plugin build
bb plugin install .
```
