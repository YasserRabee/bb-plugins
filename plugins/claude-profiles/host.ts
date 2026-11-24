// bb-plugin-claude-profiles — the host entry. Runs on the machine that runs a
// thread, so config dirs, token files, and transcripts are touched on the
// right disk even for enrolled remote machines.
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract.ts";
import { secretEnvName, wrapperScript } from "./resolve.ts";
import { parseProfile, parseUsage, type LoginStatus } from "./usage.ts";

export function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

const API = "https://api.anthropic.com";
const OAUTH_HEADERS = { "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" };

/**
 * Ask Anthropic about a credential with the calls Claude Code makes itself:
 * the OAuth profile (also says whether the token is accepted) and usage, or
 * the models list for an API key. The credential never leaves this function.
 */
export async function probeLogin(
  credential: { secret: string; expiresAt: number | null } | null,
  fetchImpl: typeof fetch = fetch,
): Promise<LoginStatus> {
  const status: LoginStatus = { verified: "unknown", note: null, email: null, plan: null, usage: null, retryAfterSec: null };
  if (credential === null) return { ...status, note: "No login found to check" };
  const call = (path: string, headers: Record<string, string>) =>
    fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  try {
    if (credential.secret.startsWith("sk-ant-api")) {
      const response = await call("/v1/models?limit=1", { "x-api-key": credential.secret, "anthropic-version": "2023-06-01" });
      if (response.status === 401) return { ...status, verified: "rejected", note: "Anthropic rejected this API key: revoked or expired" };
      return response.ok ? { ...status, verified: "ok" } : { ...status, note: `Anthropic answered HTTP ${response.status}` };
    }
    if (credential.expiresAt !== null && Date.now() >= credential.expiresAt) {
      // Claude Code refreshes it on its next run; refreshing here would rotate its tokens under it.
      return { ...status, note: "Access token expired; Claude Code refreshes it on its next run" };
    }
    const auth = { ...OAUTH_HEADERS, Authorization: `Bearer ${credential.secret}` };
    const profile = await call("/api/oauth/profile", auth);
    if (profile.status === 401) return { ...status, verified: "rejected", note: "Anthropic rejected this login: revoked or expired" };
    // 403: accepted, but without the profile scope (setup-tokens).
    if (profile.ok) Object.assign(status, { verified: "ok" }, parseProfile(await profile.json()));
    else if (profile.status === 403) status.verified = "ok";
    else status.note = `Anthropic answered HTTP ${profile.status}`;
    const usage = await call("/api/oauth/usage", auth);
    if (usage.ok) status.usage = parseUsage(await usage.json());
    else if (usage.status === 429) status.retryAfterSec = Number(usage.headers.get("retry-after")) || null;
    return status;
  } catch (cause) {
    return { ...status, note: `Could not reach Anthropic: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/** Login facts the same way Claude Code finds them for a config dir. */
export async function checkProfile(configDir: string | null, tokenFile: string | null = null, fetchImpl: typeof fetch = fetch) {
  const dir = configDir ?? defaultConfigDir();
  const isDefault = configDir === null && !process.env.CLAUDE_CONFIG_DIR?.trim();
  const credentials = await readJson(join(dir, ".credentials.json"));
  const oauth = credentials?.claudeAiOauth as { accessToken?: unknown; expiresAt?: unknown } | undefined;
  const globalConfig =
    (await readJson(join(dir, ".config.json"))) ??
    (await readJson(isDefault ? join(homedir(), ".claude.json") : join(dir, ".claude.json")));
  const account = globalConfig?.oauthAccount as { emailAddress?: unknown } | undefined;
  const email = typeof account?.emailAddress === "string" ? account.emailAddress : null;
  // The wrapper's secret wins over the config dir's login, as it does in Claude Code.
  const secret = tokenFile === null ? null : (await readFile(tokenFile, "utf8").catch(() => "")).trim();
  // shortcut: macOS keeps the config dir's login in the Keychain, so it isn't probed there; read it with `security` if Mac hosts need limits.
  const credential = secret
    ? { secret, expiresAt: null }
    : typeof oauth?.accessToken === "string"
      ? { secret: oauth.accessToken, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null }
      : null;
  const login = await probeLogin(credential, fetchImpl);
  return {
    configDir: dir,
    exists: await isDir(dir),
    // macOS keeps the token in the keychain, so an account record counts too.
    loggedIn: typeof oauth?.accessToken === "string" || email !== null,
    // With a token or API key the config dir's email belongs to another login: only trust Anthropic's answer.
    email: login.email ?? (secret ? null : email),
    login,
  };
}

/** Copy `src` over `dest` when dest is missing or older. */
async function copyIfNewer(src: string, dest: string): Promise<number> {
  const [from, to] = await Promise.all([stat(src), stat(dest).catch(() => null)]);
  if (from.isDirectory()) {
    await mkdir(dest, { recursive: true });
    let copied = 0;
    for (const entry of await readdir(src)) {
      copied += await copyIfNewer(join(src, entry), join(dest, entry));
    }
    return copied;
  }
  // 1ms slack: utimes keeps only millisecond precision.
  if (to !== null && to.mtimeMs >= from.mtimeMs - 1) return 0;
  await copyFile(src, dest);
  // Keep the source's mtime so switching back copies only what changed.
  await utimes(dest, from.atime, from.mtime);
  return 1;
}

/**
 * Make one Claude Code session resumable from another config dir: copy its
 * transcript (`projects/<cwd slug>/<id>.jsonl`) and its subagent folder.
 * Searching by session id avoids re-deriving Claude Code's cwd slug rule.
 */
export async function migrateTranscript(fromDir: string, toDir: string, sessionId: string) {
  if (fromDir === toDir) return { found: true, copied: 0 };
  const projects = join(fromDir, "projects");
  const slugs = await readdir(projects).catch(() => [] as string[]);
  for (const slug of slugs) {
    const transcript = join(projects, slug, `${sessionId}.jsonl`);
    if (!(await stat(transcript).catch(() => null))?.isFile()) continue;
    const target = join(toDir, "projects", slug);
    await mkdir(target, { recursive: true });
    let copied = await copyIfNewer(transcript, join(target, `${sessionId}.jsonl`));
    if (await isDir(join(projects, slug, sessionId))) {
      copied += await copyIfNewer(join(projects, slug, sessionId), join(target, sessionId));
    }
    return { found: true, copied };
  }
  return { found: false, copied: 0 };
}

export async function ensureTokenWrapper(dataDir: string, profileId: string, token: string) {
  const dir = join(dataDir, "profiles", profileId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tokenFile = join(dir, "token");
  const wrapperPath = join(dir, "claude");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  await writeFile(wrapperPath, wrapperScript(tokenFile, wrapperPath, secretEnvName(token)), { mode: 0o700 });
  await chmod(wrapperPath, 0o700);
  return { wrapperPath };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    describe: () => ({ homeDir: homedir(), defaultConfigDir: defaultConfigDir() }),
    checkProfile: ({ configDir, profileId }, context) =>
      checkProfile(
        configDir,
        profileId === null ? null : join(context.experimental_paths.dataDir, "profiles", profileId, "token"),
      ),
    ensureTokenWrapper: ({ profileId, token }, context) =>
      ensureTokenWrapper(context.experimental_paths.dataDir, profileId, token),
    removeProfile: async ({ profileId }, context) => {
      const dir = join(context.experimental_paths.dataDir, "profiles", profileId);
      const existed = await isDir(dir);
      await rm(dir, { recursive: true, force: true });
      return { removed: existed };
    },
    migrateTranscript: ({ fromDir, toDir, sessionId }) =>
      migrateTranscript(fromDir ?? defaultConfigDir(), toDir ?? defaultConfigDir(), sessionId),
  },
});
