# bb-plugin-gitlab-mr-status

GitLab merge request status for each environment's branch: the GitLab
counterpart of bb's bundled GitHub PR Status.

| Surface | Slot |
| --- | --- |
| Status bar above the composer, with actions | `app.composer.customize({ banners })` |
| MR rows in the thread context card (experimental) | `experimental_threadContextCardRow` |
| MR row in the thread Info tab | `experimental_threadInfoRow` |
| `!12` badge on thread rows | `experimental_threadRowMetadata` |
| `bb merge-request show/ready/draft/merge` | `bb.cli` |

- `lib/contract.ts` is the RPC contract and data shapes, shared by both sides.
- `lib/gitlab.ts` maps GitLab's merge request JSON to the plugin's shape (pure,
  fully tested). `lib/present.ts` is how each state looks.
- `host.ts` runs `glab` on the machine that owns the environment, resolving the
  GitLab project from its git remote and finding the MR by upstream branch,
  remote branch at HEAD, local branch, then commit. `server.ts` caches each row (20s while a pipeline runs, minutes
  otherwise, an hour once merged), and polls while a client watches.
- `app.tsx` reads the keyed `mergeRequests` method.

## Thread-list badge

The `!12` badge shows in bb's built-in thread list and in any list plugin that
renders `experimental_ThreadRowMetadata`. A list plugin that reads
`bb--github-pr-status` directly (Cursor Sidebar does) needs a small change to
show GitLab MRs: read this plugin's `mergeRequests` method the same way.

## Requirements

`glab` installed and logged in on each machine that has GitLab environments
(`glab auth login`). The plugin runs glab on the environment's own machine (`host.ts`), so each machine needs glab installed and logged in.

## Develop

```sh
npm install
npm test
npm run typecheck
bb plugin build
bb plugin install .
```
