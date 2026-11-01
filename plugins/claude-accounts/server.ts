// bb-plugin-claude-accounts — run Claude Code threads on different accounts.
// A profile is a CLAUDE_CONFIG_DIR, a `claude setup-token` token, or both.
// Each thread is pinned to one profile on its first run (new-thread pick →
// fork source → project default → global default → the machine's own login)
// and the env resolver hands that profile to every Claude Code command.
// Switching a started thread copies its transcript to the new account first,
// and only with the user's consent.
import { createHash } from "node:crypto";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
  type ExperimentalPluginProviderEnvEntry,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./contract.ts";
import {
  SYSTEM_PROFILE,
  expandHome,
  initialChoice,
  profileIdSchema,
  profileSchema,
  slugify,
  threadChoiceSchema,
  type Profile,
  type ThreadChoice,
} from "./resolve.ts";

const PROVIDER_ID = "claude-code";
/** A new-thread composer pick waits this long for its thread's first run. */
export const PENDING_TTL_MS = 2 * 60_000;
/** Realtime channel; any change to profiles, defaults, or a thread's pick. */
export const ACCOUNTS_CHANGED = "claude-accounts-changed";

const profileChoiceSchema = z.union([profileIdSchema, z.literal(SYSTEM_PROFILE)]);
const hostCheckSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  ok: z.boolean(),
  configDir: z.string().nullable(),
  email: z.string().nullable(),
  error: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  accounts_list: {
    input: z.null(),
    output: z.object({
      profiles: z.array(profileSchema),
      globalDefault: z.string().nullable(),
      projectDefaults: z.record(z.string(), z.string()),
    }),
  },
  accounts_save: {
    input: z.object({
      id: profileIdSchema.optional(),
      label: z.string().trim().min(1).max(60),
      configDir: z.string().trim().min(1).max(500).nullable(),
      // Omit to keep the stored token; null removes it.
      token: z.string().trim().min(1).max(4096).nullable().optional(),
    }),
    output: profileSchema,
  },
  accounts_remove: {
    input: z.object({ id: profileIdSchema }),
    output: z.object({ removed: z.boolean() }),
  },
  accounts_check: {
    input: z.object({ id: profileChoiceSchema }),
    output: z.object({ hosts: z.array(hostCheckSchema) }),
  },
  accounts_set_default: {
    // projectId null: the global default. profileId null: clear it.
    input: z.object({
      projectId: z.string().min(1).nullable(),
      profileId: profileChoiceSchema.nullable(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  accounts_set_pending: {
    input: z.object({ projectId: z.string().min(1), profileId: profileChoiceSchema.nullable() }),
    output: z.object({ ok: z.literal(true) }),
  },
  accounts_get_pending: {
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({ profileId: z.string().nullable() }),
  },
  accounts_threads: {
    input: z.object({ threadIds: z.array(z.string().min(1)).max(200) }),
    output: z.object({ threads: z.record(z.string(), threadChoiceSchema) }),
  },
  accounts_switch: {
    input: z.object({
      threadId: z.string().min(1),
      profileId: profileChoiceSchema,
      confirm: z.boolean(),
    }),
    output: z.object({
      status: z.enum(["switched", "unchanged", "needs-confirm"]),
      copied: z.number().int(),
    }),
  },
});

type Pending = { profileId: string; expiresAt: number };
type WrapperCache = { wrapperPath: string; digest: string };

const digest = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export default async function plugin(bb: BbPluginApi) {
  const kv = bb.storage.kv;
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const homes = new Map<string, string>();

  const readProfiles = async () => (await kv.get<Profile[]>("profiles")) ?? [];
  const findProfile = async (id: string) =>
    (await readProfiles()).find((profile) => profile.id === id) ?? null;
  const readProjectDefaults = async () =>
    (await kv.get<Record<string, string>>("projectDefaults")) ?? {};
  const changed = (detail: Record<string, unknown> = {}) =>
    bb.realtime.publish(ACCOUNTS_CHANGED, detail);

  async function readChoice(threadId: string): Promise<ThreadChoice | null> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    const parsed = threadChoiceSchema.safeParse(metadata);
    return parsed.success ? parsed.data : null;
  }
  async function writeChoice(threadId: string, choice: ThreadChoice) {
    await bb.sdk.threads.updatePluginMetadata({ threadId, set: { ...choice } });
    changed({ threadId });
  }

  async function takePending(projectId: string): Promise<string | null> {
    const pending = await kv.get<Pending>(`pending:${projectId}`);
    if (pending === null || pending === undefined) return null;
    await kv.delete(`pending:${projectId}`);
    return pending.expiresAt > Date.now() ? pending.profileId : null;
  }

  /** The thread's pinned profile, pinning it now on its first run. */
  async function choiceFor(threadId: string, projectId: string | null): Promise<ThreadChoice> {
    const existing = await readChoice(threadId);
    if (existing !== null) return existing;
    const thread = await bb.sdk.threads.get({ threadId });
    let inherited: Parameters<typeof initialChoice>[1] = null;
    // A fork resumes its source's transcript, which lives in the source's account.
    const source = thread.sourceThreadId ? await readChoice(thread.sourceThreadId) : null;
    if (source !== null) inherited = { profileId: source.profileId, source: "fork" };
    else {
      const pending = await takePending(thread.projectId);
      if (pending !== null) inherited = { profileId: pending, source: "new-thread" };
    }
    const choice = initialChoice(
      {
        globalDefault: (await kv.get<string>("globalDefault")) ?? null,
        projectDefault: (await readProjectDefaults())[projectId ?? thread.projectId] ?? null,
      },
      inherited,
    );
    await writeChoice(threadId, choice);
    return choice;
  }

  async function homeOf(hostId: string): Promise<string> {
    const known = homes.get(hostId);
    if (known !== undefined) return known;
    const { homeDir } = await host.call("describe", null, { hostId });
    homes.set(hostId, homeDir);
    return homeDir;
  }
  async function configDirOn(hostId: string, profile: Profile | null): Promise<string | null> {
    if (profile?.configDir == null) return null;
    return expandHome(profile.configDir, await homeOf(hostId));
  }

  async function wrapperOn(hostId: string, profile: Profile): Promise<string> {
    const token = await kv.get<string>(`token:${profile.id}`);
    if (!token) throw new Error(`Account "${profile.label}" has no token stored`);
    const cacheKey = `wrapper:${hostId}:${profile.id}`;
    const cached = await kv.get<WrapperCache>(cacheKey);
    if (cached?.digest === digest(token)) return cached.wrapperPath;
    const { wrapperPath } = await host.call(
      "ensureTokenWrapper",
      { profileId: profile.id, token },
      { hostId, signal: AbortSignal.timeout(4_000) },
    );
    await kv.set(cacheKey, { wrapperPath, digest: digest(token) } satisfies WrapperCache);
    return wrapperPath;
  }

  async function envFor(hostId: string, profileId: string): Promise<ExperimentalPluginProviderEnvEntry[]> {
    if (profileId === SYSTEM_PROFILE) return [];
    const profile = await findProfile(profileId);
    const reason = `Claude account: ${profile?.label ?? profileId}`;
    if (profile === null) {
      // A deleted profile must not silently fall back to another login.
      return [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: `/claude-accounts/missing-profile/${profileId}`, reason }];
    }
    const entries: ExperimentalPluginProviderEnvEntry[] = [];
    const configDir = await configDirOn(hostId, profile);
    if (configDir !== null) entries.push({ name: "CLAUDE_CONFIG_DIR", value: configDir, reason });
    if (profile.hasToken) {
      let wrapperPath: string;
      try {
        wrapperPath = await wrapperOn(hostId, profile);
      } catch (cause) {
        bb.log.warn(`token wrapper for ${profileId} on ${hostId} unavailable: ${errorText(cause)}`);
        wrapperPath = `/claude-accounts/token-unavailable/${profileId}`;
      }
      entries.push({ name: "BB_CLAUDE_CODE_EXECUTABLE", value: wrapperPath, reason });
    }
    return entries;
  }

  bb.providers.experimental_contributeEnv(PROVIDER_ID, async ({ threadId, projectId, hostId }) => {
    if (threadId === null) {
      // Model listing serves no thread: use the project's or global default.
      const fallback =
        (projectId ? (await readProjectDefaults())[projectId] : undefined) ??
        (await kv.get<string>("globalDefault")) ??
        SYSTEM_PROFILE;
      return envFor(hostId, fallback);
    }
    const choice = await choiceFor(threadId, projectId);
    return envFor(hostId, choice.profileId);
  });

  async function hostOfThread(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return environment.hostId;
  }

  /** Claude Code's session id for the thread, once it has started one. */
  async function sessionOf(threadId: string): Promise<string | null> {
    const [event] = await bb.sdk.threads.events.list({
      threadId,
      types: ["provider.env-resolved"],
      order: "desc",
      limit: "1",
    });
    const data = event?.data as { providerThreadId?: unknown } | undefined;
    return typeof data?.providerThreadId === "string" && data.providerThreadId !== ""
      ? data.providerThreadId
      : null;
  }

  async function switchThread(threadId: string, profileId: string, confirm: boolean) {
    if (profileId !== SYSTEM_PROFILE && (await findProfile(profileId)) === null) {
      throw new Error(`No Claude account "${profileId}"`);
    }
    const current = await readChoice(threadId);
    if (current?.profileId === profileId) return { status: "unchanged" as const, copied: 0 };
    const sessionId = current === null ? null : await sessionOf(threadId);
    let copied = 0;
    if (current !== null && sessionId !== null) {
      if (!confirm) return { status: "needs-confirm" as const, copied: 0 };
      const hostId = await hostOfThread(threadId);
      if (hostId === null) throw new Error("The thread has no machine to copy its conversation on");
      const fromDir = await configDirOn(hostId, await findProfile(current.profileId));
      const toDir = await configDirOn(hostId, await findProfile(profileId));
      if (fromDir !== toDir) {
        ({ copied } = await host.call("migrateTranscript", { fromDir, toDir, sessionId }, { hostId }));
      }
    }
    await writeChoice(threadId, { profileId, source: "thread" });
    return { status: "switched" as const, copied };
  }

  async function saveProfile(input: z.infer<(typeof rpcContract)["accounts_save"]["input"]>) {
    const profiles = await readProfiles();
    let id = input.id;
    if (id === undefined) {
      const base = slugify(input.label);
      id = base;
      for (let n = 2; profiles.some((profile) => profile.id === id); n += 1) id = `${base}-${n}`;
    }
    const existing = profiles.find((profile) => profile.id === id);
    if (input.token !== undefined) {
      if (input.token === null) await kv.delete(`token:${id}`);
      else await kv.set(`token:${id}`, input.token);
    }
    const hasToken = input.token === undefined ? (existing?.hasToken ?? false) : input.token !== null;
    if (input.configDir === null && !hasToken) {
      throw new Error("An account needs a config dir, a token, or both");
    }
    const profile: Profile = { id, label: input.label, configDir: input.configDir, hasToken };
    await kv.set("profiles", [...profiles.filter((p) => p.id !== id), profile]);
    changed();
    return profile;
  }

  async function removeProfile(id: string) {
    const profiles = await readProfiles();
    if (!profiles.some((profile) => profile.id === id)) return false;
    await kv.set("profiles", profiles.filter((profile) => profile.id !== id));
    await kv.delete(`token:${id}`);
    if ((await kv.get<string>("globalDefault")) === id) await kv.delete("globalDefault");
    const defaults = await readProjectDefaults();
    await kv.set(
      "projectDefaults",
      Object.fromEntries(Object.entries(defaults).filter(([, profileId]) => profileId !== id)),
    );
    for (const { id: hostId } of await bb.sdk.hosts.list()) {
      await kv.delete(`wrapper:${hostId}:${id}`);
      await host.call("removeProfile", { profileId: id }, { hostId }).catch(() => undefined);
    }
    changed();
    return true;
  }

  async function setDefault(projectId: string | null, profileId: string | null) {
    if (projectId === null) {
      if (profileId === null) await kv.delete("globalDefault");
      else await kv.set("globalDefault", profileId);
    } else {
      const defaults = await readProjectDefaults();
      if (profileId === null) delete defaults[projectId];
      else defaults[projectId] = profileId;
      await kv.set("projectDefaults", defaults);
    }
    changed();
  }

  async function checkOnHosts(id: string) {
    const profile = id === SYSTEM_PROFILE ? null : await findProfile(id);
    if (id !== SYSTEM_PROFILE && profile === null) throw new Error(`No Claude account "${id}"`);
    const hosts = await bb.sdk.hosts.list();
    return Promise.all(
      hosts.map(async (target) => {
        const base = { hostId: target.id, hostName: target.name ?? target.id };
        try {
          const configDir = await configDirOn(target.id, profile);
          const facts = await host.call("checkProfile", { configDir }, { hostId: target.id, signal: AbortSignal.timeout(10_000) });
          if (profile?.hasToken) await wrapperOn(target.id, profile);
          const tokenOnly = profile !== null && profile.hasToken && profile.configDir === null;
          const ok = tokenOnly || (facts.exists && (facts.loggedIn || profile?.hasToken === true));
          const error = ok
            ? null
            : facts.exists
              ? "Not logged in"
              : `${facts.configDir} does not exist on this machine`;
          return { ...base, ok, configDir: facts.configDir, email: facts.email, error };
        } catch (cause) {
          return { ...base, ok: false, configDir: null, email: null, error: errorText(cause) };
        }
      }),
    );
  }

  bb.rpc.register(rpcContract, {
    accounts_list: async () => ({
      profiles: await readProfiles(),
      globalDefault: (await kv.get<string>("globalDefault")) ?? null,
      projectDefaults: await readProjectDefaults(),
    }),
    accounts_save: (input) => saveProfile(input),
    accounts_remove: async ({ id }) => ({ removed: await removeProfile(id) }),
    accounts_check: async ({ id }) => ({ hosts: await checkOnHosts(id) }),
    accounts_set_default: async ({ projectId, profileId }) => {
      await setDefault(projectId, profileId);
      return { ok: true as const };
    },
    accounts_set_pending: async ({ projectId, profileId }) => {
      if (profileId === null) await kv.delete(`pending:${projectId}`);
      else await kv.set(`pending:${projectId}`, { profileId, expiresAt: Date.now() + PENDING_TTL_MS } satisfies Pending);
      return { ok: true as const };
    },
    accounts_get_pending: async ({ projectId }) => {
      const pending = await kv.get<Pending>(`pending:${projectId}`);
      return { profileId: pending && pending.expiresAt > Date.now() ? pending.profileId : null };
    },
    accounts_threads: async ({ threadIds }) => {
      if (threadIds.length === 0) return { threads: {} };
      const { threads } = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds });
      const result: Record<string, ThreadChoice> = {};
      for (const { threadId, metadata } of threads) {
        const parsed = threadChoiceSchema.safeParse(metadata);
        if (parsed.success) result[threadId] = parsed.data;
      }
      return { threads: result };
    },
    accounts_switch: ({ threadId, profileId, confirm }) => switchThread(threadId, profileId, confirm),
  });

  const describeProfile = (profile: Profile) =>
    [profile.configDir ?? "default config dir", profile.hasToken ? "token" : null]
      .filter(Boolean)
      .join(" + ");
  const json = (value: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` });

  bb.cli.register(
    defineCli({
      name: "claude-accounts",
      summary: "Choose which Claude Code account each project and thread uses",
      commands: {
        list: cliCommand({
          summary: "List accounts and defaults",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run({ options }) {
            const profiles = await readProfiles();
            const globalDefault = (await kv.get<string>("globalDefault")) ?? null;
            const projectDefaults = await readProjectDefaults();
            if (options.json) return json({ profiles, globalDefault, projectDefaults });
            const lines = profiles.map((p) => `${p.id}\t${p.label}\t${describeProfile(p)}`);
            lines.push(`global default: ${globalDefault ?? `${SYSTEM_PROFILE} (machine login)`}`);
            for (const [project, profileId] of Object.entries(projectDefaults)) {
              lines.push(`project ${project}: ${profileId}`);
            }
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        add: cliCommand({
          summary: "Add or update an account (config dir, token, or both)",
          positionals: [{ name: "label", description: "Display name, e.g. Work", required: true }],
          options: {
            id: { type: "string", description: "Update this existing account id" },
            "config-dir": {
              type: "string",
              aliases: ["dir", "config"],
              description: "CLAUDE_CONFIG_DIR on the thread's machine; ~/ allowed",
            },
            token: {
              type: "string",
              stdin: true,
              description: "A `claude setup-token` token; pipe it with --token-stdin",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run({ positionals, options }) {
            const profile = await saveProfile({
              ...(options.id ? { id: options.id } : {}),
              label: positionals.label,
              configDir: options["config-dir"] ?? null,
              ...(options.token ? { token: options.token } : {}),
            });
            return options.json ? json(profile) : { exitCode: 0, stdout: `saved ${profile.id}\n` };
          },
        }),
        remove: cliCommand({
          summary: "Remove an account",
          positionals: [{ name: "id", description: "Account id", required: true }],
          async run({ positionals }) {
            if (!(await removeProfile(positionals.id))) {
              throw new PluginCliError(`no account "${positionals.id}"`, {
                code: "account_not_found",
                hint: "Run `bb claude-accounts list`.",
              });
            }
            return { exitCode: 0, stdout: `removed ${positionals.id}\n` };
          },
        }),
        check: cliCommand({
          summary: "Check an account's login on every machine",
          positionals: [{ name: "id", description: `Account id, or ${SYSTEM_PROFILE}`, required: true }],
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run({ positionals, options }) {
            const hosts = await checkOnHosts(positionals.id);
            if (options.json) return json({ hosts });
            const lines = hosts.map(
              (h) => `${h.hostName}\t${h.ok ? "ok" : "not ready"}\t${h.email ?? ""}\t${h.error ?? ""}`,
            );
            return { exitCode: hosts.some((h) => h.ok) ? 0 : 1, stdout: `${lines.join("\n")}\n` };
          },
        }),
        default: cliCommand({
          summary: "Set the global or a project's default account (none clears it)",
          positionals: [{ name: "account", description: `Account id, ${SYSTEM_PROFILE}, or none`, required: true }],
          options: {
            project: { type: "string", description: "Project id; omit for the global default" },
          },
          async run({ positionals, options }) {
            const account = positionals.account;
            if (account !== "none" && account !== SYSTEM_PROFILE && (await findProfile(account)) === null) {
              throw new PluginCliError(`no account "${account}"`, { code: "account_not_found", hint: "Run `bb claude-accounts list`." });
            }
            await setDefault(options.project ?? null, account === "none" ? null : account);
            return { exitCode: 0, stdout: `default ${options.project ? `for ${options.project}` : "(global)"}: ${account}\n` };
          },
        }),
        use: cliCommand({
          summary: "Switch a thread to an account (copies its conversation; needs --confirm once started)",
          positionals: [{ name: "account", description: `Account id or ${SYSTEM_PROFILE}`, required: true }],
          options: {
            thread: { type: "string", description: "Thread id; defaults to the calling thread" },
            confirm: { type: "boolean", description: "Consent to copying a started conversation to the account" },
          },
          async run({ positionals, options }, ctx) {
            const threadId = options.thread ?? ctx.threadId;
            if (!threadId) {
              throw new PluginCliError("no thread given", { code: "thread_required", hint: "Add --thread <id>." });
            }
            const result = await switchThread(threadId, positionals.account, options.confirm === true);
            if (result.status === "needs-confirm") {
              throw new PluginCliError("this thread already has a conversation", {
                code: "confirm_required",
                hint: "Re-run with --confirm to copy it to the new account; the next turn runs there.",
              });
            }
            return { exitCode: 0, stdout: `${result.status}${result.copied ? ` (${result.copied} files copied)` : ""}\n` };
          },
        }),
        status: cliCommand({
          summary: "Show which account a thread uses and why",
          options: {
            thread: { type: "string", description: "Thread id; defaults to the calling thread" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run({ options }, ctx) {
            const threadId = options.thread ?? ctx.threadId;
            if (!threadId) {
              throw new PluginCliError("no thread given", { code: "thread_required", hint: "Add --thread <id>." });
            }
            const choice = await readChoice(threadId);
            if (options.json) return json({ threadId, choice });
            return {
              exitCode: 0,
              stdout: choice
                ? `${choice.profileId} (from ${choice.source})\n`
                : "not pinned yet: the next run uses the new-thread pick or the defaults\n",
            };
          },
        }),
      },
    }),
  );
}
