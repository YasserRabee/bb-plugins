import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { MAX_TODOS } from "./server.ts";

test("todo_write validates, replaces per thread, and publishes", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "checklist",
    agentSkillIds: ["checklist"],
  });
  await plugin(bb);
  const write = (todos: unknown, threadId = "t1") =>
    harness.behavior.callAgentTool("todo_write", { todos }, { threadId });
  const read = async (threadId: string) =>
    (await harness.behavior.callRpc("checklist_get", { threadId })) as any;
  const get = async (threadId: string) => (await read(threadId)).todos;
  const turnStarts = (id: string) =>
    harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id }),
    });

  assert.equal(
    await write([
      { content: "Plan", status: "completed" },
      { content: "Build", status: "in_progress", activeForm: "Building" },
      { content: "Ship", status: "pending" },
    ]),
    "1/3 done; now: Building\n[x] Plan\n[>] Build\n[ ] Ship\n" +
      "Mark each item completed as soon as it is done, and call todo_write again whenever the plan changes.",
  );
  // A new or resumed session gets the open list in its instructions.
  const configure = (id: string) =>
    harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id } }),
    );
  const configured = await configure("t1");
  assert.deepEqual(configured.tools.map((tool) => tool.name), ["todo_write"]);
  assert.match(configured.instructions ?? "", /\[>\] Build\n\[ \] Ship/);
  assert.equal((await configure("t9")).instructions, null);

  await write([{ content: "Other thread", status: "pending" }], "t2");
  // A second call replaces the whole list rather than merging.
  assert.equal(await write([{ content: "Ship", status: "completed" }]), "1/1 done");
  assert.deepEqual(await get("t1"), [{ content: "Ship", status: "completed" }]);
  assert.equal((await get("t2")).length, 1);
  assert.equal(harness.realtimeSignals.length, 3);

  // A finished list stays pinned until the next turn; unfinished ones stay put.
  assert.equal((await read("t1")).pinned, true);
  await turnStarts("t2");
  assert.equal((await read("t2")).pinned, true);
  await turnStarts("t1");
  assert.equal((await read("t1")).pinned, false);
  assert.equal((await get("t1")).length, 1); // the tab still has it
  await write([{ content: "Next", status: "pending" }]);
  assert.equal((await read("t1")).pinned, true);

  // Bad input is rejected and leaves the stored list alone.
  for (const bad of [
    [{ content: "", status: "pending" }],
    [{ content: "x".repeat(301), status: "pending" }],
    [{ content: "x", status: "done" }],
    Array.from({ length: MAX_TODOS + 1 }, () => ({ content: "x", status: "pending" })),
  ]) {
    await assert.rejects(async () => {
      const result = await write(bad);
      if (typeof result !== "string" && result.isError) throw new Error("tool error");
    });
  }
  assert.equal((await get("t1")).length, 1);

  assert.equal(await write([]), "Checklist cleared.");
  assert.deepEqual(await get("t1"), []);
  await harness.lifecycle.dispose();
});

test("a compaction mid-turn steers the agent with its open list, once", async () => {
  let compactedAt = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "checklist",
    agentSkillIds: ["checklist"],
    sdk: {
      threads: {
        events: {
          list: async () =>
            compactedAt ? [{ type: "thread/compacted", seq: 7, createdAt: compactedAt }] : [],
        },
        send: async () => ({ delivery: "sent" }),
      },
    },
  });
  await plugin(bb);
  const events = (status: "active" | "idle", id = "t1") =>
    harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id, status }),
      sequence: 1,
    });
  const sends = () => harness.sdk.callsTo("threads.send");

  await harness.behavior.callAgentTool(
    "todo_write",
    { todos: [{ content: "Build", status: "in_progress" }, { content: "Ship", status: "pending" }] },
    { threadId: "t1" },
  );
  await events("active");
  assert.equal(sends().length, 0); // no compaction yet

  compactedAt = Date.now() + 1000;
  await events("idle");
  assert.equal(sends().length, 0); // a steer would start a turn on an idle thread
  await events("active");
  await events("active");
  assert.equal(sends().length, 1); // once per compaction
  const [request] = sends()[0] as [any];
  assert.equal(request.mode, "steer");
  assert.equal(request.input[0].visibility, "agent-only");
  assert.match(request.input[0].text, /\[>\] Build\n\[ \] Ship/);

  // A finished list needs no reminder.
  await harness.behavior.callAgentTool(
    "todo_write",
    { todos: [{ content: "Build", status: "completed" }] },
    { threadId: "t1" },
  );
  compactedAt = Date.now() + 2000;
  await events("active");
  assert.equal(sends().length, 1);
  await harness.lifecycle.dispose();
});
