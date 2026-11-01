// Pure pieces shared by server.ts, host.ts, and app.tsx: the profile shapes and
// the rule for which account a thread runs on. No bb or Node imports here.
import { z } from "zod";

/** The machine's own Claude login: bb's behavior with no plugin. */
export const SYSTEM_PROFILE = "system";

export const profileIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and -");

export const profileSchema = z.object({
  id: profileIdSchema,
  label: z.string().trim().min(1).max(60),
  // A path on the thread's machine (`~/` allowed). Null: the machine's
  // default config dir.
  configDir: z.string().trim().min(1).max(500).nullable(),
  // A `claude setup-token` token is stored for this profile (server-only).
  hasToken: z.boolean(),
});
export type Profile = z.infer<typeof profileSchema>;

/**
 * A `claude setup-token` token, with the line breaks a wrapped terminal adds
 * removed. Throws (without echoing it) when it isn't a whole token.
 */
export function normalizeToken(raw: string): string {
  const token = raw.replace(/\s+/g, "");
  if (!token.startsWith("sk-ant-") && token.includes("#")) {
    throw new Error(
      "That is the browser's one-time authentication code, not the token. Paste it " +
        "into the terminal running `claude setup-token`; it then prints the sk-ant-oat01- token.",
    );
  }
  if (!/^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error(
      "That isn't a whole `claude setup-token` token: it starts with sk-ant-oat01-. " +
        "If the terminal wrapped it over several lines, copy all of them.",
    );
  }
  return token;
}

export const threadChoiceSchema = z.object({
  profileId: z.string(),
  // Where the pinned value came from, for display.
  source: z.enum(["thread", "new-thread", "fork", "project", "global", "system"]),
});
export type ThreadChoice = z.infer<typeof threadChoiceSchema>;

export interface Defaults {
  globalDefault: string | null;
  projectDefault: string | null;
}

/** First run of a thread: the account it gets pinned to. */
export function initialChoice(
  defaults: Defaults,
  inherited: { profileId: string; source: "new-thread" | "fork" } | null,
): ThreadChoice {
  if (inherited !== null) return inherited;
  if (defaults.projectDefault !== null) {
    return { profileId: defaults.projectDefault, source: "project" };
  }
  if (defaults.globalDefault !== null) {
    return { profileId: defaults.globalDefault, source: "global" };
  }
  return { profileId: SYSTEM_PROFILE, source: "system" };
}

export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" || slug === SYSTEM_PROFILE ? `account-${slug || "1"}` : slug;
}

/** `~/x` against the thread machine's home; absolute paths pass through. */
export function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return `${homeDir.replace(/\/+$/, "")}/${path.slice(2)}`;
  return path;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The executable bb runs for a token profile. It exports the token from a
 * 0600 file so the token never appears in bb's resolved-env timeline, then
 * runs the `claude` bb would have found on PATH, skipping itself.
 */
export function wrapperScript(tokenFile: string, selfPath: string): string {
  return [
    "#!/bin/sh",
    "# Written by the bb claude-accounts plugin. Do not edit.",
    `CLAUDE_CODE_OAUTH_TOKEN=$(cat ${shellQuote(tokenFile)}) || exit 1`,
    "export CLAUDE_CODE_OAUTH_TOKEN",
    `self=${shellQuote(selfPath)}`,
    "IFS=:",
    "for dir in $PATH; do",
    '  candidate="${dir:-.}/claude"',
    '  if [ -x "$candidate" ] && [ "$candidate" != "$self" ]; then exec "$candidate" "$@"; fi',
    "done",
    'echo "claude-accounts: claude not found on PATH" >&2',
    "exit 127",
    "",
  ].join("\n");
}
