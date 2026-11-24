# bb-plugin-gitlab-mr-status

GitLab merge request status for each environment's branch: the GitLab
counterpart of bb's bundled GitHub PR Status.

| Surface | Slot |
| --- | --- |
| Status bar above the composer, with actions | `app.composer.customize({ banners })` |
| MR rows in the thread context card (experimental) | `experimental_threadContextCardRow` |
| MR row in the thread Info tab | `experimental_threadInfoRow` |
| `!12` badge on thread rows | `experimental_threadRowMetadata` |
| MR chips with hover cards above messages that mention an MR | `experimental_messageMetadata` |
| `::gitlab-mr{ref="!12"}` chip with hover card in agent replies | `messageDirective` |
| `bb merge-request show/ready/draft/merge` | `bb.cli` |

- `lib/contract.ts` is the RPC contract and data shapes, shared by both sides.
- `lib/gitlab.ts` maps GitLab's merge request JSON to the plugin's shape (pure,
  fully tested). `lib/present.ts` is how each state looks.
- `host.ts` runs `glab` on the machine that owns the environment, resolving the
  GitLab project from its git remote and finding the MR by upstream branch,
  remote branch at HEAD, local branch, then commit. `server.ts` caches each row (20s while a pipeline runs, minutes
  otherwise, an hour once merged), and polls while a client watches.
- `app.tsx` reads the keyed `mergeRequests` method.

## Merge requests in messages

The Plugin SDK has no way to decorate text inside a chat message (no link
renderer, Markdown extension or hover-card slot), so the plugin offers two
supported surfaces instead, chosen by the **Merge requests in messages**
setting (`bb plugin config gitlab-mr-status set messageReferences <mode>`):

| Mode | What happens |
| --- | --- |
| `both` (default) | chips and directive |
| `chips` | A row of MR chips above any user or assistant message that mentions an MR. |
| `directive` | Agents are told (dynamic instructions) to write `::gitlab-mr{ref="!12"}` or `ref="<MR URL>"` on its own line; it renders as a chip. |
| `off` | Neither; existing directives render as plain text or a link. |

Hovering or focusing a chip shows a card with the title, state, pipeline,
approvals, source → target branch and author.

- `lib/refs.ts` finds references (pure, tested). Full MR URLs
  (`https://<host>/<group…>/<project>/-/merge_requests/<n>`) match on any
  host; the host must be one `glab auth status` lists to resolve. Bare `!n`
  means the thread environment's project and matches only as its own token
  (after a space, line start or opening bracket; not followed by a letter,
  digit, `-` or `.digit`), never inside inline code or fenced blocks, at most
  ten per message. A number that is not an MR (GitLab 404) shows nothing, so
  a stray `!3` costs one lookup, not a wrong chip.
- `messageRefs` (keyed `<threadId> <messageId>`) returns a message's refs. The
  metadata slot gives the message id but not its text or seq, so the server
  pages back through `sdk.threads.message` from the newest message event
  (20 messages per page, at most 50 pages) and caches text per thread.
- `mergeRequestRefs` (keyed `<environmentId> <ref>`) shares the
  `mergeRequests` cache, TTLs and polling. A ref to the thread's own MR is
  answered from that row; others run the host entry's `fetch` (glab on the
  environment's machine).

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
