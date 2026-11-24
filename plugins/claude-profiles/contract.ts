// The server ↔ host RPC contract: work that must happen on the machine that
// runs the thread (local or enrolled), never on the server's own disk.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const usageWindowSchema = z.object({
  window: z.enum(["5h", "week"]),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});
export const loginStatusSchema = z.object({
  verified: z.enum(["ok", "rejected", "unknown"]),
  note: z.string().nullable(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  usage: z.array(usageWindowSchema).nullable(),
  retryAfterSec: z.number().nullable(),
});

export const hostContract = defineRpcContract({
  describe: {
    input: z.null(),
    output: z.object({ homeDir: z.string(), defaultConfigDir: z.string() }),
    experimental_retryable: true,
  },
  checkProfile: {
    // Absolute, or null for the machine's default config dir.
    // profileId: set when the profile has a token or API key, whose wrapper
    // file the host checks instead of the config dir's login.
    input: z.object({ configDir: z.string().nullable(), profileId: z.string().regex(/^[a-z0-9-]+$/).nullable().default(null) }),
    output: z.object({
      configDir: z.string(),
      exists: z.boolean(),
      loggedIn: z.boolean(),
      email: z.string().nullable(),
      login: loginStatusSchema,
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
