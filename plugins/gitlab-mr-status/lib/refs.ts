// Merge request references in chat text: full MR URLs on any host, and bare
// `!12` meaning the thread environment's own GitLab project. Pure, so the
// server, the app and the tests share it.

export type MergeRequestRef =
  | { iid: number }
  | { host: string; path: string; iid: number };

const MAX_REFS = 10;
const URL_RE = /https?:\/\/([a-z0-9.-]+(?::\d+)?)\/((?:[\w.-]+\/)+?[\w.-]+)\/-\/merge_requests\/(\d+)/gi;
// `!12` only as its own token: after start, whitespace or an opening bracket,
// and not followed by a word character, `-` or `.digit` (so `x!1`, `!12abc`,
// `!=`, `$!` and `!1.5` never match).
const BARE_RE = /(?<=^|[\s([{])!(\d{1,7})(?![\w-]|\.\d)/g;

/**
 * Text with fenced and inline code removed, so refs inside code stay literal,
 * and `::gitlab-mr{…}` directives removed, since they render their own chip.
 */
function prose(text: string): string {
  return text
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/::gitlab-mr\{[^}\n]*\}/g, " ");
}

/** Canonical form of one reference: `!12` or `https://host/group/proj/-/merge_requests/12`. */
export function formatRef(ref: MergeRequestRef): string {
  return "host" in ref ? `https://${ref.host}/${ref.path}/-/merge_requests/${ref.iid}` : `!${ref.iid}`;
}

/** Parses one reference (a canonical key or a directive attribute), or null. */
export function parseRef(text: string): MergeRequestRef | null {
  const value = text.trim();
  const bare = /^!(\d{1,7})$/.exec(value);
  if (bare) return { iid: Number(bare[1]) };
  const url = new RegExp(`^${URL_RE.source}(?:[/?#].*)?$`, "i").exec(value);
  if (!url) return null;
  return { host: url[1]!.toLowerCase(), path: url[2]!, iid: Number(url[3]) };
}

/** Distinct references in a message, in order, at most ten. */
export function findRefs(text: string): string[] {
  const body = prose(text);
  const found: Array<{ at: number; ref: string }> = [];
  for (const match of body.matchAll(URL_RE)) {
    found.push({ at: match.index, ref: formatRef({ host: match[1]!.toLowerCase(), path: match[2]!, iid: Number(match[3]) }) });
  }
  for (const match of body.matchAll(BARE_RE)) found.push({ at: match.index, ref: `!${match[1]}` });
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((item) => item.ref))].slice(0, MAX_REFS);
}

/** Whether a reference names this merge request (bare refs mean its project). */
export function sameMergeRequest(url: string, iid: number, ref: MergeRequestRef): boolean {
  if (!("host" in ref)) return ref.iid === iid;
  const own = parseRef(url);
  return own !== null && formatRef(own).toLowerCase() === formatRef(ref).toLowerCase();
}
