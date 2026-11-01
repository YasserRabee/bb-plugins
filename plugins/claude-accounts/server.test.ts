import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

const TOKEN = "sk-ant-oat01-secret-value";

function setup() {
  const metadata = new Map<string, Record<string, unknown>>();
  const threads = new Map<string, { projectId: string; sourceThreadId: string | null }>();
  const sessions = new Map<string, string>();
  const hostCalls: { method: string; input: any }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "claude-accounts",
    experimental_callHostRpc: ({ method, input }) => {
      hostCalls.push({ method, input });
      if (method === "describe") return { homeDir: "/home/me", defaultConfigDir: "/home/me/.claude" };
      if (method === "ensureTokenWrapper") return { wrapperPath: `/data/${(input as any).profileId}/claude` };
      if (method === "migrateTranscript") return { found: true, copied: 2 };
      if (method === "checkProfile") return { configDir: (input as any).configDir ?? "/home/me/.claude", exists: true, loggedIn: true, email: "me@example.com" };
      if (method === "removeProfile") return { removed: true };
      throw new Error(`unexpected host call ${method}`);
    },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId)!;
          return makeThreadResponse({ id: threadId, environmentId: "env_1", ...thread });
        },
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set: Record<string, unknown> }) => {
          metadata.set(threadId, { ...metadata.get(threadId), ...set });
          return metadata.get(threadId)!;
        },
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds.filter((id) => metadata.has(id)).map((threadId) => ({ threadId, metadata: metadata.get(threadId)! })),
        }),
        events: {
          list: async ({ threadId }: { threadId: string }) =>
            sessions.has(threadId)
              ? [{ type: "provider.env-resolved", data: { providerThreadId: sessions.get(threadId) } }]
              : [],
        },
      },
      environments: { get: async () => ({ id: "env_1", hostId: "host_a" }) },
      hosts: { list: async () => [{ id: "host_a", name: "laptop" }] },
    } as any,
  });
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<any>;
  const env = (threadId: string | null, projectId: string | null = "proj_1") =>
    harness.resolveProviderEnv("claude-code", { threadId, projectId, hostId: "host_a" });
  return { bb, harness, rpc, env, metadata, threads, sessions, hostCalls };
}

test("threads pin to new-thread pick → fork source → project → global → machine login", async () => {
  const t = setup();
  await plugin(t.bb);
  const work = await t.rpc("accounts_save", { label: "Work", configDir: "~/.claude-work" });
  const home = await t.rpc("accounts_save", { label: "Home", configDir: "/abs/home" });
  assert.equal(work.id, "work");

  // No defaults: nothing contributed, bb's own login.
  t.threads.set("t0", { projectId: "proj_1", sourceThreadId: null });
  assert.deepEqual(await t.env("t0"), []);
  assert.equal(t.metadata.get("t0")?.source, "system");

  await t.rpc("accounts_set_default", { projectId: null, profileId: "home" });
  t.threads.set("t1", { projectId: "proj_1", sourceThreadId: null });
  assert.deepEqual(await t.env("t1"), [{ name: "CLAUDE_CONFIG_DIR", value: "/abs/home", reason: "Claude account: Home" }]);

  await t.rpc("accounts_set_default", { projectId: "proj_1", profileId: "work" });
  t.threads.set("t2", { projectId: "proj_1", sourceThreadId: null });
  assert.equal((await t.env("t2"))[0]?.value, "/home/me/.claude-work"); // ~ expanded on the thread's machine
  // Pinned: a later default change leaves a started thread alone.
  await t.rpc("accounts_set_default", { projectId: "proj_1", profileId: "home" });
  assert.equal((await t.env("t2"))[0]?.value, "/home/me/.claude-work");
  assert.equal((await t.env("t1"))[0]?.value, "/abs/home");

  // A new-thread pick wins once, then expires with its first use.
  await t.rpc("accounts_set_pending", { projectId: "proj_1", profileId: "work" });
  t.threads.set("t3", { projectId: "proj_1", sourceThreadId: null });
  t.threads.set("t4", { projectId: "proj_1", sourceThreadId: null });
  assert.equal((await t.env("t3"))[0]?.value, "/home/me/.claude-work");
  assert.equal(t.metadata.get("t3")?.source, "new-thread");
  assert.equal((await t.env("t4"))[0]?.value, "/abs/home");

  // A fork follows its source even though the project default differs.
  t.threads.set("f1", { projectId: "proj_1", sourceThreadId: "t2" });
  assert.equal((await t.env("f1"))[0]?.value, "/home/me/.claude-work");
  assert.equal(t.metadata.get("f1")?.source, "fork");

  // Model listing serves no thread: the project default.
  assert.equal((await t.env(null))[0]?.value, "/abs/home");
  assert.equal(home.hasToken, false);
  await t.harness.lifecycle.dispose();
});

test("token profiles use a wrapper and never expose the token", async () => {
  const t = setup();
  await plugin(t.bb);
  const bot = await t.rpc("accounts_save", { label: "CI bot", configDir: null, token: TOKEN });
  assert.deepEqual(bot, { id: "ci-bot", label: "CI bot", configDir: null, hasToken: true });
  await t.rpc("accounts_set_default", { projectId: null, profileId: "ci-bot" });
  t.threads.set("t1", { projectId: "proj_1", sourceThreadId: null });
  const entries = await t.env("t1");
  assert.deepEqual(entries, [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/data/ci-bot/claude", reason: "Claude account: CI bot" }]);
  await t.env("t1"); // cached: no second wrapper write
  assert.equal(t.hostCalls.filter((c) => c.method === "ensureTokenWrapper").length, 1);

  const listed = JSON.stringify(await t.rpc("accounts_list", null));
  const cli = JSON.stringify(await t.harness.runCli(["list", "--json"]));
  for (const output of [JSON.stringify(entries), listed, cli, JSON.stringify(await t.rpc("accounts_threads", { threadIds: ["t1"] }))]) {
    assert.ok(!output.includes(TOKEN), output);
  }

  await assert.rejects(t.rpc("accounts_save", { label: "Empty", configDir: null }));
  await t.rpc("accounts_remove", { id: "ci-bot" });
  // A removed profile fails loudly instead of using another login.
  assert.match(String((await t.env("t1"))[0]?.value), /missing-profile/);
  await t.harness.lifecycle.dispose();
});

test("switching a started thread needs consent and copies its transcript", async () => {
  const t = setup();
  await plugin(t.bb);
  await t.rpc("accounts_save", { label: "Work", configDir: "~/.claude-work" });
  await t.rpc("accounts_save", { label: "Home", configDir: "/abs/home" });
  t.threads.set("t1", { projectId: "proj_1", sourceThreadId: null });

  // Not started yet: switch freely, nothing to copy.
  assert.deepEqual(await t.rpc("accounts_switch", { threadId: "t1", profileId: "work", confirm: false }), { status: "switched", copied: 0 });
  await t.env("t1");
  t.sessions.set("t1", "sess-123");

  assert.equal((await t.rpc("accounts_switch", { threadId: "t1", profileId: "home", confirm: false })).status, "needs-confirm");
  assert.equal(t.metadata.get("t1")?.profileId, "work");
  const cli = await t.harness.runCli(["use", "home", "--thread", "t1"]);
  assert.notEqual(cli.exitCode, 0);

  assert.deepEqual(await t.rpc("accounts_switch", { threadId: "t1", profileId: "home", confirm: true }), { status: "switched", copied: 2 });
  const migrate = t.hostCalls.find((c) => c.method === "migrateTranscript");
  assert.deepEqual(migrate?.input, { fromDir: "/home/me/.claude-work", toDir: "/abs/home", sessionId: "sess-123" });
  assert.equal((await t.env("t1"))[0]?.value, "/abs/home");
  assert.deepEqual(t.metadata.get("t1"), { profileId: "home", source: "thread" });
  assert.equal((await t.rpc("accounts_switch", { threadId: "t1", profileId: "home", confirm: false })).status, "unchanged");
  await t.harness.lifecycle.dispose();
});
