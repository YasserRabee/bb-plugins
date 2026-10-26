import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { MAX_TODOS } from "./server.ts";

test("todo_write validates, replaces per thread, and publishes", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "checklist" });
  await plugin(bb);
  const write = (todos: unknown, threadId = "t1") =>
    harness.behavior.callAgentTool("todo_write", { todos }, { threadId });
  const get = async (threadId: string) =>
    ((await harness.behavior.callRpc("checklist_get", { threadId })) as any)
      .todos;

  assert.equal(
    await write([
      { content: "Plan", status: "completed" },
      { content: "Build", status: "in_progress", activeForm: "Building" },
      { content: "Ship", status: "pending" },
    ]),
    "1/3 done; now: Building",
  );
  await write([{ content: "Other thread", status: "pending" }], "t2");
  // A second call replaces the whole list rather than merging.
  await write([{ content: "Ship", status: "completed" }]);
  assert.deepEqual(await get("t1"), [{ content: "Ship", status: "completed" }]);
  assert.equal((await get("t2")).length, 1);
  assert.equal(harness.realtimeSignals.length, 3);

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
