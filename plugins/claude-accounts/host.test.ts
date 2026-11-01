import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkProfile, ensureTokenWrapper, migrateTranscript } from "./host.ts";
import { expandHome, slugify } from "./resolve.ts";

test("migrateTranscript copies one session, never clobbering a newer copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-accounts-"));
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
  const root = await mkdtemp(join(tmpdir(), "claude-accounts-"));
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

test("checkProfile reads a config dir's login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-accounts-"));
  assert.deepEqual(await checkProfile(dir), { configDir: dir, exists: true, loggedIn: false, email: null });
  await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }));
  assert.deepEqual(await checkProfile(dir), { configDir: dir, exists: true, loggedIn: true, email: "me@example.com" });
  assert.equal((await checkProfile(join(dir, "nope"))).exists, false);
});

test("helpers", () => {
  assert.equal(expandHome("~/.claude-work", "/home/me/"), "/home/me/.claude-work");
  assert.equal(expandHome("/abs", "/home/me"), "/abs");
  assert.equal(slugify("My Work Account!"), "my-work-account");
  assert.equal(slugify("system"), "account-system");
  assert.equal(slugify("!!!"), "account-1");
});
