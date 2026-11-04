// Runs `glab` on the machine that owns an environment, so merge requests of
// environments on any enrolled machine resolve with that machine's own glab
// login and git remotes.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { hostContract } from "./lib/host-contract.ts";
import { classifyGlabFailure, parseGlabHosts, parseRemote, pickMergeRequest, rawListItemSchema } from "./lib/gitlab.ts";

const GLAB_TIMEOUT_MS = 20_000;

class GlabError extends Error {
  readonly failure: ReturnType<typeof classifyGlabFailure>;
  constructor(failure: ReturnType<typeof classifyGlabFailure>, message: string) {
    super(message);
    this.failure = failure;
  }
}

const tidy = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

function run(command: string, cwd: string, args: string[], signal: AbortSignal, withStderr = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: GLAB_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        signal,
        env: { ...process.env, NO_COLOR: "1", GLAB_NO_PROMPT: "1" },
      },
      (error, stdout, stderr) => {
        // `glab api` can print an ERROR block with exit 0.
        if (!error && /^\s*ERROR\b/.test(stdout)) {
          return reject(new GlabError(classifyGlabFailure(stdout), tidy(stdout)));
        }
        if (!error) return resolve(withStderr ? `${stdout}\n${stderr}` : stdout);
        const text = [stderr, stdout, error.message].filter(Boolean).join("\n");
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new GlabError(missing ? "missing" : classifyGlabFailure(text), tidy(text)));
      },
    );
  });
}

// glab runs from a neutral directory with an explicit host and project: some
// glab versions fail to read a linked git worktree's config (`.git` is a file
// there), and the remote already names the project.
const glab = (args: string[], signal: AbortSignal, withStderr = false) => run("glab", tmpdir(), args, signal, withStderr);

let hostsCache: { at: number; hosts: string[]; output: string } | undefined;
async function glabHosts(signal: AbortSignal): Promise<{ hosts: string[]; output: string }> {
  if (hostsCache && Date.now() - hostsCache.at < 60_000) return hostsCache;
  // `glab auth status` exits non-zero when any host fails; its text still lists them.
  const output = await glab(["auth", "status"], signal, true).catch((cause) => (cause instanceof GlabError ? cause.message : ""));
  hostsCache = { at: Date.now(), hosts: parseGlabHosts(output), output: tidy(output) };
  return hostsCache;
}

/** The environment's GitLab project, from its git remotes (origin first). */
async function project(cwd: string, signal: AbortSignal) {
  const names = (await run("git", cwd, ["remote"], signal).catch(() => "")).split(/\s+/).filter(Boolean);
  names.sort((a, b) => Number(b === "origin") - Number(a === "origin"));
  const { hosts: known, output } = await glabHosts(signal);
  let gitlabLike: { host: string; path: string } | null = null;
  for (const name of names) {
    const url = (await run("git", cwd, ["remote", "get-url", name], signal).catch(() => "")).trim();
    const parsed = parseRemote(url);
    if (!parsed) continue;
    if (known.includes(parsed.host)) return { ...parsed, loggedIn: true };
    if (/gitlab/i.test(parsed.host)) gitlabLike ??= parsed;
  }
  return gitlabLike ? { ...gitlabLike, loggedIn: false, status: output } : null;
}

/**
 * Source branch names an environment's work may be pushed as. A bb worktree's
 * local branch (`bb/…-thr_…`) is often pushed under another name, so ask git
 * for the upstream and for remote branches at HEAD before the local name.
 */
async function candidateBranches(cwd: string, branch: string, signal: AbortSignal): Promise<string[]> {
  const git = (args: string[]) => run("git", cwd, args, signal).catch(() => "");
  const stripRemote = (ref: string) => ref.replace(/^[^/]+\//, "");
  const upstream = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
  const atHead = (await git(["for-each-ref", "--points-at", "HEAD", "--format=%(refname:short)", "refs/remotes"]))
    .split(/\s+/)
    .filter((ref) => ref.includes("/") && !ref.endsWith("/HEAD"));
  return [...new Set([upstream, ...atHead].filter(Boolean).map(stripRemote).concat(branch))];
}

const failed = (cause: unknown) =>
  cause instanceof GlabError
    ? { failure: cause.failure, message: cause.message }
    : { failure: "other" as const, message: tidy(String(cause)) };

const ACTION_ARGS = {
  ready: ["--ready"],
  draft: ["--draft"],
} as const;

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    lookup: async ({ cwd, branch }, { signal }) => {
      try {
        const found = await project(cwd, signal);
        if (!found) return { kind: "none" as const };
        if (!found.loggedIn) {
          return { kind: "failed" as const, failure: "unauthenticated" as const, message: `no glab login for ${found.host}${"status" in found ? ` (glab auth status: ${found.status.slice(0, 160)})` : ""}` };
        }
        const query = new URLSearchParams({
          source_branch: branch,
          state: "all",
          order_by: "updated_at",
          sort: "desc",
          per_page: "10",
        });
        const base = `projects/${encodeURIComponent(found.path)}/merge_requests`;
        const api = (path: string) => glab(["api", "--hostname", found.host, path], signal);
        let picked: { iid: number; state: string } | undefined;
        for (const name of await candidateBranches(cwd, branch, signal)) {
          query.set("source_branch", name);
          picked = pickMergeRequest(z.array(rawListItemSchema).parse(JSON.parse(await api(`${base}?${query}`))));
          if (picked) break;
        }
        if (!picked) {
          // Last resort: the MRs GitLab associates with the checked-out commit.
          const sha = (await run("git", cwd, ["rev-parse", "HEAD"], signal).catch(() => "")).trim();
          if (/^[0-9a-f]{7,64}$/i.test(sha)) {
            const byCommit = await api(`projects/${encodeURIComponent(found.path)}/repository/commits/${sha}/merge_requests`).catch(() => "[]");
            picked = pickMergeRequest(z.array(rawListItemSchema).parse(JSON.parse(byCommit)));
          }
        }
        if (!picked) return { kind: "none" as const };
        const [detail, approvals] = await Promise.all([
          api(`${base}/${picked.iid}`),
          // Approval rules are a paid tier: a failure only hides the count.
          api(`${base}/${picked.iid}/approvals`).catch(() => null),
        ]);
        return { kind: "found" as const, detail, approvals };
      } catch (cause) {
        const failure = failed(cause);
        if (failure.failure === "absent") return { kind: "none" as const };
        return { kind: "failed" as const, ...failure };
      }
    },
    act: async ({ cwd, iid, action }, { signal }) => {
      try {
        const found = await project(cwd, signal);
        if (!found?.loggedIn) {
          return { ok: false as const, failure: "unauthenticated" as const, message: "no glab login for this remote" };
        }
        const repo = ["-R", `${found.host}/${found.path}`];
        const args =
          action === "ready" || action === "draft"
            ? ["mr", "update", String(iid), ...ACTION_ARGS[action], ...repo]
            : ["mr", "merge", String(iid), "--yes", ...(action === "squash" ? ["--squash"] : action === "rebase" ? ["--rebase"] : []), ...repo];
        await glab(args, signal);
        return { ok: true as const };
      } catch (cause) {
        return { ok: false as const, ...failed(cause) };
      }
    },
  },
});
