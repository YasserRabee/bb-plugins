// The server ↔ host RPC contract: work that must happen on the machine that
// runs the thread (local or enrolled), never on the server's own disk.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  describe: {
    input: z.null(),
    output: z.object({ homeDir: z.string(), defaultConfigDir: z.string() }),
    experimental_retryable: true,
  },
  checkProfile: {
    // Absolute, or null for the machine's default config dir.
    input: z.object({ configDir: z.string().nullable() }),
    output: z.object({
      configDir: z.string(),
      exists: z.boolean(),
      loggedIn: z.boolean(),
      email: z.string().nullable(),
    }),
    experimental_retryable: true,
  },
  ensureTokenWrapper: {
    input: z.object({
      profileId: z.string().regex(/^[a-z0-9-]+$/),
      token: z.string().min(1).max(4096),
    }),
    output: z.object({ wrapperPath: z.string() }),
  },
  removeProfile: {
    input: z.object({ profileId: z.string().regex(/^[a-z0-9-]+$/) }),
    output: z.object({ removed: z.boolean() }),
  },
  migrateTranscript: {
    // Both absolute, or null for the machine's default config dir.
    input: z.object({
      fromDir: z.string().nullable(),
      toDir: z.string().nullable(),
      sessionId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
    }),
    output: z.object({ found: z.boolean(), copied: z.number().int() }),
  },
});
