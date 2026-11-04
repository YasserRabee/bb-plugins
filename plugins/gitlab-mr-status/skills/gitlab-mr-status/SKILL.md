---
name: gitlab-mr-status
description: Inspect an environment's GitLab merge request, mark it ready or draft, or merge it from the bb CLI. Use when a thread's branch has a GitLab MR or the user asks about its pipeline, approvals or mergeability.
---

# GitLab MR Status

The plugin finds the merge request for an environment's current branch by
running `glab` in the environment's workspace on the machine that owns the
environment, so that machine's `glab` login and host list apply (gitlab.com and self-hosted). The composer
banner, thread context card, Info tab and thread-row badge read from it.

```sh
bb merge-request show <environment-id> [--json]
bb merge-request ready <environment-id> [--json]
bb merge-request draft <environment-id> [--json]
bb merge-request merge <environment-id> [--method merge|squash|rebase] [--json]
```

- `show` prints the MR number, state, branches, attention, pipeline,
  approvals and mergeability. `--json` prints `{ "outcome": "available",
  "mergeRequest" }`, `{ "outcome": "absent" }` or `{ "outcome":
  "unavailable", "message" }`.
- `ready` needs a draft, `draft` needs an open MR, and `merge` needs an open MR
  GitLab reports as mergeable. Each re-reads the MR first and fails with the
  reason otherwise.
- An offline machine, or `glab` missing or logged out there, reports
  `unavailable` with the reason. `glab` must be installed and logged in on each
  machine that has GitLab environments.
- Other plugins can read the keyed `mergeRequests` RPC method; run
  `bb plugin rpc inspect gitlab-mr-status` for its schema.
