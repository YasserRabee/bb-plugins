import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkProfile, ensureTokenWrapper, migrateTranscript, probeLogin } from "./host.ts";
import { parseProfile, parseUsage, usageLine } from "./usage.ts";
import { expandHome, normalizeApiKey, normalizeToken, slugify } from "./resolve.ts";

test("migrateTranscript copies one session, never clobbering a newer copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-profiles-"));
  const from = join(root, "a");
  const to = join(root, "b");
  const slug = "-home-me-repo";
  await mkdir(join(from, "projects", slug, "sess-1", "subagents"), { recursive: true });
  await writeFile(join(from, "projects", slug, "sess-1.jsonl"), "turn 1\n");
  await writeFile(join(from, "projects", slug, "sess-1", "subagents", "agent.jsonl"), "sub\n");
  await writeFile(join(from, "projects", slug, "other.jsonl"), "unrelated\n");

  assert.deepEqual(await migrateTranscript(from, to, "sess-1"), { found: true, copied: 2 });
  assert.equal(await readFile(join(to, "projects", slug, "sess-1.jsonl"), "utf8"), "turn 1\n");
  assert.equal(await readFile(join(to, "projects", slug, "sess-1", "subagents", "agent.jsonl"), "utf8"), "sub\n");
  await assert.rejects(stat(join(to, "projects", slug, "other.jsonl")));

  // Unchanged source: nothing to copy. Switching back copies the newer side.
  assert.equal((await migrateTranscript(from, to, "sess-1")).copied, 0);
  await writeFile(join(to, "projects", slug, "sess-1.jsonl"), "turn 1\nturn 2\n");
  const later = new Date(Date.now() + 5_000);
  await utimes(join(to, "projects", slug, "sess-1.jsonl"), later, later);
  assert.equal((await migrateTranscript(to, from, "sess-1")).copied, 1);
  assert.equal(await readFile(join(from, "projects", slug, "sess-1.jsonl"), "utf8"), "turn 1\nturn 2\n");

  assert.deepEqual(await migrateTranscript(from, to, "missing"), { found: false, copied: 0 });
});

test("token wrapper exports the token from a private file and runs claude", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-profiles-"));
  const { wrapperPath } = await ensureTokenWrapper(join(root, "data"), "work", "tok'en$1");
  const tokenFile = join(root, "data", "profiles", "work", "token");
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(wrapperPath)).mode & 0o777, 0o700);
  assert.ok(!(await readFile(wrapperPath, "utf8")).includes("tok'en$1"));

  // A fake `claude` on PATH proves the wrapper passes args and the token.
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), '#!/bin/sh\necho "$CLAUDE_CODE_OAUTH_TOKEN|$*"\n', { mode: 0o755 });
  const output = execFileSync(wrapperPath, ["--version", "x y"], {
    env: { PATH: `${join(root, "data", "profiles", "work")}:${bin}:/usr/bin:/bin` },
  }).toString();
  assert.equal(output, "tok'en$1|--version x y\n");
});

test("an API key wrapper exports ANTHROPIC_API_KEY and drops competing logins", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-profiles-"));
  const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
  const { wrapperPath } = await ensureTokenWrapper(join(root, "data"), "org", key);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "claude"),
    '#!/bin/sh\necho "$ANTHROPIC_API_KEY|${CLAUDE_CODE_OAUTH_TOKEN-unset}|${ANTHROPIC_AUTH_TOKEN-unset}|${CLAUDE_CODE_USE_BEDROCK-unset}"\n',
    { mode: 0o755 },
  );
  const output = execFileSync(wrapperPath, [], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CLAUDE_CODE_OAUTH_TOKEN: "machine-token",
      ANTHROPIC_AUTH_TOKEN: "machine-bearer",
      CLAUDE_CODE_USE_BEDROCK: "1",
    },
  }).toString();
  assert.equal(output, `${key}|unset|unset|unset\n`);
});

test("checkProfile reads a config dir's login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-profiles-"));
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const facts = async (d: string) => { const { login, ...rest } = await checkProfile(d, null, offline); return rest; };
  assert.deepEqual(await facts(dir), { configDir: dir, exists: true, loggedIn: false, email: null });
  await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }));
  assert.deepEqual(await facts(dir), { configDir: dir, exists: true, loggedIn: true, email: "me@example.com" });
  assert.equal((await facts(join(dir, "nope"))).exists, false);
});

test("helpers", () => {
  assert.equal(expandHome("~/.claude-work", "/home/me/"), "/home/me/.claude-work");
  assert.equal(expandHome("/abs", "/home/me"), "/abs");
  assert.equal(slugify("My Work Account!"), "my-work-account");
  assert.equal(slugify("system"), "account-system");
  assert.equal(slugify("!!!"), "account-1");
  const token = "sk-ant-oat01-abcdefghij_KLMNOPQRST-0123456789";
  assert.equal(normalizeToken(` ${token.slice(0, 30)}\n${token.slice(30)}\n`), token);
  // Only the last wrapped line of a token, or an API key.
  assert.throws(() => normalizeToken(token.slice(13)), /sk-ant-oat01-/);
  assert.throws(() => normalizeToken("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), /Console API key/);
  const key = "sk-ant-api03-abcdefghij_KLMNOPQRST-0123456789";
  assert.equal(normalizeApiKey(` ${key.slice(0, 30)}\n${key.slice(30)}\n`), key);
  assert.throws(() => normalizeApiKey(key.slice(13)), /sk-ant-api03-/);
  assert.throws(() => normalizeApiKey(token), /setup-token/);
  assert.throws(() => normalizeToken("abcdefghijklmnop#qrstuvwxyz0123456789"), /authentication code/);
});

// ---- Live login checks ------------------------------------------------------

const USAGE = {
  five_hour: { utilization: 37.4, resets_at: "2026-11-25T01:40:00.139289+00:00" },
  seven_day: { utilization: 51, resets_at: "2026-11-29T00:00:00.139321+00:00" },
  seven_day_opus: null,
  limits: [{ kind: "session", percent: 37 }],
};
const PROFILE = {
  account: { email: "me@example.com", has_claude_max: true, has_claude_pro: false },
  organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" },
};

/** A fetch stub answering by path, recording what it was asked. */
function fakeFetch(routes: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, headers: init?.headers as Record<string, string> });
    const route = routes[path];
    if (route === undefined) throw new Error(`unexpected ${path}`);
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status, headers: route.headers });
  }) as typeof fetch;
  return { impl, calls };
}

test("usage and profile parsing", () => {
  assert.deepEqual(parseUsage(USAGE), [
    { window: "5h", usedPercent: 37, resetsAt: "2026-11-25T01:40:00.139Z" },
    { window: "week", usedPercent: 51, resetsAt: "2026-11-29T00:00:00.139Z" },
  ]);
  assert.equal(parseUsage({ five_hour: null, seven_day: null }), null);
  assert.equal(parseUsage("nope"), null);
  assert.deepEqual(parseUsage({ five_hour: { utilization: 140, resets_at: "garbage" } }), [
    { window: "5h", usedPercent: 100, resetsAt: null },
  ]);
  assert.deepEqual(parseProfile(PROFILE), { email: "me@example.com", plan: "Max 5x" });
  assert.deepEqual(parseProfile({ account: { has_claude_pro: true } }), { email: null, plan: "Pro" });
  assert.deepEqual(parseProfile({ organization: { organization_type: "claude_team" } }), { email: null, plan: "Team" });
  assert.deepEqual(parseProfile(null), { email: null, plan: null });

  const now = new Date("2026-11-24T12:00:00Z");
  const soon = usageLine({ window: "5h", usedPercent: 82, resetsAt: "2026-11-24T14:00:00Z" }, now);
  assert.match(soon, /^82% of 5h · resets \d\d:\d\d/);
  assert.match(usageLine({ window: "week", usedPercent: 51, resetsAt: "2026-11-29T00:00:00Z" }, now), /^51% of week · resets \w+ /);
  assert.equal(usageLine({ window: "5h", usedPercent: 5, resetsAt: null }, now), "5% of 5h");
});

test("probeLogin: a config-dir login gets plan, email and usage", async () => {
  const secret = "sk-ant-oat01-access-token-value";
  const { impl, calls } = fakeFetch({
    "/api/oauth/profile": { status: 200, body: PROFILE },
    "/api/oauth/usage": { status: 200, body: USAGE },
  });
  const status = await probeLogin({ secret, expiresAt: Date.now() + 60_000 }, impl);
  assert.equal(status.verified, "ok");
  assert.equal(status.plan, "Max 5x");
  assert.equal(status.email, "me@example.com");
  assert.equal(status.usage?.length, 2);
  assert.equal(calls[0]?.headers.Authorization, `Bearer ${secret}`);
  assert.ok(!JSON.stringify(status).includes(secret));
});

test("probeLogin degrades quietly", async () => {
  // A setup-token: accepted (403 = no profile scope), usage throttled.
  const setupToken = fakeFetch({
    "/api/oauth/profile": { status: 403, body: { error: { type: "permission_error" } } },
    "/api/oauth/usage": { status: 429, headers: { "retry-after": "3592" } },
  });
  assert.deepEqual(await probeLogin({ secret: "sk-ant-oat01-setup", expiresAt: null }, setupToken.impl), {
    verified: "ok", note: null, email: null, plan: null, usage: null, retryAfterSec: 3592,
  });

  // Revoked: 401 from the profile call, and no usage call after it.
  const revoked = fakeFetch({ "/api/oauth/profile": { status: 401 } });
  const rejected = await probeLogin({ secret: "sk-ant-oat01-dead", expiresAt: null }, revoked.impl);
  assert.equal(rejected.verified, "rejected");
  assert.match(rejected.note ?? "", /revoked or expired/);
  assert.equal(revoked.calls.length, 1);

  // An expired access token: Claude Code refreshes it, so nothing is called.
  const untouched = fakeFetch({});
  const expired = await probeLogin({ secret: "sk-ant-oat01-old", expiresAt: Date.now() - 1 }, untouched.impl);
  assert.equal(expired.verified, "unknown");
  assert.equal(untouched.calls.length, 0);

  // API keys: the models list, never the OAuth endpoints, and no usage.
  const key = "sk-ant-api03-some-key";
  const keyOk = fakeFetch({ "/v1/models": { status: 200, body: { data: [] } } });
  assert.deepEqual(await probeLogin({ secret: key, expiresAt: null }, keyOk.impl), {
    verified: "ok", note: null, email: null, plan: null, usage: null, retryAfterSec: null,
  });
  assert.equal(keyOk.calls[0]?.headers["x-api-key"], key);
  const keyBad = fakeFetch({ "/v1/models": { status: 401 } });
  assert.equal((await probeLogin({ secret: key, expiresAt: null }, keyBad.impl)).verified, "rejected");

  // Offline, or no login at all.
  const offline = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
  const down = await probeLogin({ secret: "sk-ant-oat01-x", expiresAt: null }, offline);
  assert.equal(down.verified, "unknown");
  assert.match(down.note ?? "", /Could not reach Anthropic/);
  assert.equal((await probeLogin(null, offline)).verified, "unknown");
});

test("checkProfile checks the wrapper's secret over the config dir's login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-profiles-"));
  await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-dir-login", expiresAt: Date.now() + 60_000 } }));
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "sk-ant-api03-wrapper-key\n");
  const { impl, calls } = fakeFetch({ "/v1/models": { status: 200 } });
  const result = await checkProfile(dir, tokenFile, impl);
  assert.equal(result.login.verified, "ok");
  assert.equal(calls[0]?.headers["x-api-key"], "sk-ant-api03-wrapper-key");

  const dirLogin = fakeFetch({ "/api/oauth/profile": { status: 200, body: PROFILE }, "/api/oauth/usage": { status: 200, body: USAGE } });
  const viaDir = await checkProfile(dir, null, dirLogin.impl);
  assert.equal(dirLogin.calls[0]?.headers.Authorization, "Bearer sk-ant-oat01-dir-login");
  assert.equal(viaDir.email, "me@example.com");
  assert.ok(!JSON.stringify(viaDir).includes("sk-ant-"));
});
