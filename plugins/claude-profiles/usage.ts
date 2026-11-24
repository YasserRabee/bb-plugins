// Pure parsing and labels for Anthropic's login, plan and usage responses.
// No imports, so the app can value-import it without bundling zod or Node.

export type UsageWindow = { window: "5h" | "week"; usedPercent: number; resetsAt: string | null };

/** What a live check learned about one account's credential. Never holds the credential. */
export type LoginStatus = {
  // ok: Anthropic accepted it. rejected: revoked or expired. unknown: not checked or no answer.
  verified: "ok" | "rejected" | "unknown";
  note: string | null;
  email: string | null;
  plan: string | null;
  usage: UsageWindow[] | null;
  retryAfterSec: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function usageWindow(raw: unknown, window: UsageWindow["window"]): UsageWindow | null {
  if (!isRecord(raw) || typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization)) return null;
  const resetsAt = typeof raw.resets_at === "string" && !Number.isNaN(Date.parse(raw.resets_at))
    ? new Date(raw.resets_at).toISOString()
    : null;
  return { window, usedPercent: Math.max(0, Math.min(100, Math.round(raw.utilization))), resetsAt };
}

/** `GET /api/oauth/usage`: the 5-hour and weekly windows; null when neither is there. */
export function parseUsage(raw: unknown): UsageWindow[] | null {
  if (!isRecord(raw)) return null;
  const windows = [usageWindow(raw.five_hour, "5h"), usageWindow(raw.seven_day, "week")].filter(
    (w): w is UsageWindow => w !== null,
  );
  return windows.length > 0 ? windows : null;
}

/** `GET /api/oauth/profile`: the account email and its plan ("Max 5x", "Pro", "Team"). */
export function parseProfile(raw: unknown): { email: string | null; plan: string | null } {
  const account = isRecord(raw) && isRecord(raw.account) ? raw.account : {};
  const org = isRecord(raw) && isRecord(raw.organization) ? raw.organization : {};
  const email = typeof account.email === "string" && account.email !== "" ? account.email : null;
  const tier = typeof org.rate_limit_tier === "string" ? /max_(\d+)x/.exec(org.rate_limit_tier) : null;
  const orgType = typeof org.organization_type === "string" ? org.organization_type : "";
  const plan =
    account.has_claude_max === true || orgType === "claude_max"
      ? tier ? `Max ${tier[1]}x` : "Max"
      : account.has_claude_pro === true || orgType === "claude_pro"
        ? "Pro"
        : orgType === "claude_team"
          ? "Team"
          : orgType === "claude_enterprise"
            ? "Enterprise"
            : null;
  return { email, plan };
}

function resetLabel(resetsAt: string, now: Date): string {
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Within a day the time is enough; further out it needs the weekday.
  return at.getTime() - now.getTime() < 24 * 3_600_000
    ? time
    : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** "82% of 5h · resets 14:00" */
export function usageLine(window: UsageWindow, now = new Date()): string {
  const base = `${window.usedPercent}% of ${window.window}`;
  return window.resetsAt === null ? base : `${base} · resets ${resetLabel(window.resetsAt, now)}`;
}
