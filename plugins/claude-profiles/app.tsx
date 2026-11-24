// bb-plugin-claude-profiles — the Settings section (accounts and defaults),
// a "Claude account" thread menu with a consent dialog for started threads,
// a Thread Info row, and an account picker in the new-thread composer. All
// read over RPC and refetch on the server's "claude-profiles-changed" signal.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_DetailRow as DetailRow,
  experimental_THREAD_ACTION_GROUPS,
  experimental_THREAD_INFO_ROW_GROUPS,
  useComposer,
  useRealtime,
  useRpc,
  useSdk,
  type ExperimentalThreadInfoProps,
  type PluginThreadActionDataInput,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Profile, ThreadChoice } from "./resolve";
import { usageLine, type LoginStatus } from "./usage";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Must match server.ts (a value import would bundle the server).
const ACCOUNTS_CHANGED = "claude-profiles-changed";
const SYSTEM_PROFILE = "system";
const SYSTEM_LABEL = "Machine login";
const MACHINE_PROFILE = { id: SYSTEM_PROFILE, label: SYSTEM_LABEL, configDir: null, hasToken: false } as Profile;

/** "Console (API key)": the label with the account's kind, for pickers. */
const profileLabel = (profile: Profile) =>
  profile.apiKey ? `${profile.label} (API key)` : profile.label;

type Accounts = {
  profiles: Profile[];
  globalDefault: string | null;
  projectDefaults: Record<string, string>;
  status: Record<string, LoginStatus & { checkedAt: number }>;
};
// Must match STATUS_TTL_MS in server.ts.
const STATUS_TTL_MS = 3 * 60_000;
type HostCheck = {
  hostId: string;
  hostName: string;
  ok: boolean;
  configDir: string | null;
  email: string | null;
  error: string | null;
  login: LoginStatus | null;
};

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The picker's second line: "37% of 5h · resets 14:00", or why the login fails. */
function statusText(accounts: Accounts | null, profileId: string): string | null {
  const status = accounts?.status[profileId];
  if (status === undefined) return null;
  if (status.verified === "rejected") return "Revoked or expired";
  const fiveHour = status.usage?.find((w) => w.window === "5h");
  return fiveHour ? usageLine(fiveHour) : null;
}

function labelOf(accounts: Accounts | null, profileId: string | null | undefined): string {
  if (!profileId || profileId === SYSTEM_PROFILE) return SYSTEM_LABEL;
  const profile = accounts?.profiles.find((p) => p.id === profileId);
  return profile ? profileLabel(profile) : `${profileId} (removed)`;
}

const SOURCE_LABEL: Record<ThreadChoice["source"], string> = {
  thread: "chosen for this thread",
  "new-thread": "chosen at start",
  fork: "from the forked thread",
  project: "project default",
  global: "global default",
  system: "no default set",
};

function useAccounts() {
  const rpc = useRpc<typeof rpcContract>();
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("accounts_list", null).then(
      (result) => {
        setAccounts(result);
        setError(null);
      },
      (cause: unknown) => setError(message(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(ACCOUNTS_CHANGED, refetch);
  return { rpc, accounts, error, refetch };
}

function useThreadChoices(threadIds: readonly string[]) {
  const rpc = useRpc<typeof rpcContract>();
  const [choices, setChoices] = useState<Record<string, ThreadChoice>>({});
  const key = threadIds.join(",");
  const refetch = useCallback(() => {
    if (key === "") return;
    rpc.call("accounts_threads", { threadIds: key.split(",") }).then(
      (result) => setChoices(result.threads),
      () => undefined,
    );
  }, [rpc, key]);
  useEffect(refetch, [refetch]);
  useRealtime(ACCOUNTS_CHANGED, refetch);
  return choices;
}

function AccountSelect({
  accounts,
  value,
  onChange,
  defaultId,
  className,
  ariaLabel,
}: {
  accounts: Accounts | null;
  value: string | null;
  onChange: (value: string | null) => void;
  /** What null resolves to. Its item reads "… (default)" and picks null, so the value keeps following the default. */
  defaultId: string;
  className?: string;
  ariaLabel: string;
}) {
  const accountIds = [SYSTEM_PROFILE, ...(accounts?.profiles ?? []).map((p) => p.id)];
  // A removed default still gets its item, so null always has one.
  if (!accountIds.includes(defaultId)) accountIds.unshift(defaultId);
  const rpc = useRpc<typeof rpcContract>();
  const options = accountIds.map((id) => ({
    id: id === defaultId ? null : id,
    label: id === defaultId ? `${labelOf(accounts, id)} (default)` : labelOf(accounts, id),
    status: statusText(accounts, id),
  }));
  const current = options.find((option) => option.id === value) ?? options.find((option) => option.id === null);
  return (
    // Usage is refreshed only while someone is looking at it.
    <DropdownMenu onOpenChange={(open) => open && void rpc.call("accounts_refresh_status", null).catch(() => undefined)}>
      <DropdownMenuTrigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-8 min-w-0 items-center gap-1 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        <span className="truncate">{current?.label}</span>
        <Icon name="claude-profiles/chevron-down" className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" mobileTitle={ariaLabel}>
        {options.map((option) => (
          <DropdownMenuItem key={option.id ?? ""} onSelect={() => onChange(option.id)}>
            <Icon
              name="claude-profiles/check"
              className={cn("size-3.5", option === current ? "opacity-100" : "opacity-0")}
            />
            <span className="flex min-w-0 flex-col">
              <span>{option.label}</span>
              {option.status !== null ? (
                <span className="text-xs text-muted-foreground">{option.status}</span>
              ) : null}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---- Consent for switching a started thread -------------------------------

type PendingSwitch = { threadId: string; profileId: string; fromLabel: string; toLabel: string };
let pendingSwitch: PendingSwitch | null = null;
const switchListeners = new Set<() => void>();
function setPendingSwitch(next: PendingSwitch | null) {
  pendingSwitch = next;
  for (const listener of switchListeners) listener();
}
function subscribeSwitch(listener: () => void) {
  switchListeners.add(listener);
  return () => switchListeners.delete(listener);
}

function SwitchConsentDialog() {
  const rpc = useRpc<typeof rpcContract>();
  const request = useSyncExternalStore(subscribeSwitch, () => pendingSwitch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setPendingSwitch(null);
    setError(null);
  };
  const confirm = async () => {
    if (request === null) return;
    setBusy(true);
    try {
      await rpc.call("accounts_switch", {
        threadId: request.threadId,
        profileId: request.profileId,
        confirm: true,
      });
      close();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch this thread to {request?.toLabel}?</DialogTitle>
          <DialogDescription>
            This conversation started on {request?.fromLabel}. bb copies its transcript into{" "}
            {request?.toLabel}&apos;s Claude folder so the conversation can continue there. The
            next turn runs on {request?.toLabel}, and its usage counts against that account.
          </DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={busy}>
            {busy ? "Switching…" : "Copy and switch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Thread menu and Info row ----------------------------------------------

function useThreadActionData({ threadIds }: PluginThreadActionDataInput) {
  const { rpc, accounts } = useAccounts();
  const choices = useThreadChoices(threadIds);
  return { rpc, accounts, choices };
}

function ThreadAccountRow({ threadId }: ExperimentalThreadInfoProps) {
  const { accounts } = useAccounts();
  const choice = useThreadChoices([threadId])[threadId];
  if (choice === undefined || accounts === null) return null;
  if (accounts.profiles.length === 0 && choice.profileId === SYSTEM_PROFILE) return null;
  return (
    <DetailRow label="Claude account" icon="claude-profiles/accounts">
      {labelOf(accounts, choice.profileId)}{" "}
      <span className="text-muted-foreground">({SOURCE_LABEL[choice.source]})</span>
    </DetailRow>
  );
}

// ---- New-thread composer picker --------------------------------------------

function NewThreadAccountPicker() {
  const composer = useComposer();
  const projectId = composer.scope.kind === "new-thread" ? composer.scope.projectId : null;
  const providerId = composer.selection?.providerId;
  const { rpc, accounts } = useAccounts();
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    setPicked(null);
    if (projectId === null) return;
    rpc.call("accounts_get_pending", { projectId }).then((r) => setPicked(r.profileId), () => undefined);
  }, [rpc, projectId]);
  // Re-arm the pick before it expires while the composer stays open.
  useEffect(() => {
    if (projectId === null || picked === null) return;
    const timer = setInterval(() => {
      void rpc.call("accounts_set_pending", { projectId, profileId: picked });
    }, 60_000);
    return () => clearInterval(timer);
  }, [rpc, projectId, picked]);
  if (projectId === null || accounts === null || accounts.profiles.length === 0) return null;
  if (providerId !== undefined && providerId !== "claude-code") return null;
  const projectDefault = accounts.projectDefaults[projectId] ?? accounts.globalDefault;
  const choose = (profileId: string | null) => {
    setPicked(profileId);
    void rpc.call("accounts_set_pending", { projectId, profileId });
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Icon name="claude-profiles/accounts" className="size-3.5 text-muted-foreground" />
      <AccountSelect
        ariaLabel="Claude account for this thread"
        accounts={accounts}
        value={picked}
        onChange={choose}
        defaultId={projectDefault ?? SYSTEM_PROFILE}
        className="h-7 max-w-44 border-transparent bg-transparent text-xs text-muted-foreground hover:text-foreground"
      />
      {picked !== null && picked !== (accounts.projectDefaults[projectId] ?? null) ? (
        <button
          type="button"
          title="Make this the project's default account"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => {
            void rpc.call("accounts_set_default", { projectId, profileId: picked });
            choose(null);
          }}
        >
          Set as default
        </button>
      ) : null}
    </span>
  );
}

// ---- Settings ---------------------------------------------------------------

function HostChecks({ checks }: { checks: HostCheck[] }) {
  return (
    <ul className="mt-1 space-y-0.5 text-xs">
      {checks.map((check) => (
        <li key={check.hostId} className="flex items-center gap-1.5">
          <Icon
            name={check.ok ? "CircleCheck" : "CircleAlert"}
            className={cn("size-3.5", check.ok ? "text-muted-foreground" : "text-destructive")}
          />
          <span className="font-medium">{check.hostName}</span>
          <span className="min-w-0 text-muted-foreground">
            {check.ok
              ? [check.email ?? "ready", check.login?.plan, ...(check.login?.usage ?? []).map((w) => usageLine(w))]
                  .filter(Boolean)
                  .join(" · ")
              : check.login?.verified === "rejected"
                ? `Revoked or expired: ${check.error}`
                : check.error}
            {check.ok && check.login?.verified === "unknown" && check.login.note ? ` (${check.login.note})` : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ProfileForm({
  initial,
  onDone,
}: {
  initial: Profile | null;
  onDone: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [configDir, setConfigDir] = useState(initial?.configDir ?? "");
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await rpc.call("accounts_save", {
        ...(initial ? { id: initial.id } : {}),
        label,
        configDir: configDir.trim() === "" ? null : configDir.trim(),
        ...(token.trim() !== "" ? { token: token.trim() } : clearToken ? { token: null } : {}),
        ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
      });
      onDone();
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <Field label="Name">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work" required />
      </Field>
      <Field label="Config dir (CLAUDE_CONFIG_DIR)" hint="On each machine that runs threads, e.g. ~/.claude-work. Leave empty for a token or API key only account.">
        <Input value={configDir} onChange={(e) => setConfigDir(e.target.value)} placeholder="~/.claude-work" />
      </Field>
      <Field
        label="OAuth token (optional)"
        hint={initial?.hasToken && !initial.apiKey ? "A token is stored. Paste a new one to replace it." : "For a Pro/Max subscription: the sk-ant-oat01- token `claude setup-token` prints in the terminal (not the browser code). Stored on the bb server, never shown again."}
      >
        <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Field
        label="Console API key (optional, instead of a token)"
        hint={initial?.apiKey ? "An API key is stored. Paste a new one to replace it." : "Billed per token to a Console org: an sk-ant-api03- key from console.anthropic.com. Stored on the bb server, never shown again."}
      >
        <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      {initial?.hasToken ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} />
          Remove the stored {initial.apiKey ? "API key" : "token"}
        </label>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Save
        </Button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** An icon-only button: the tooltip shows its action, the aria-label names it fully. */
function IconAction({
  tooltip,
  label,
  className,
  ...props
}: { tooltip: string; label: string; className?: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className={cn("size-7", className)} aria-label={label} {...props} />
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ProfileRow({ profile, onEdit }: { profile: Profile; onEdit?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [checks, setChecks] = useState<HostCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback(() => {
    setChecking(true);
    rpc
      .call("accounts_check", { id: profile.id })
      .then(
        (result) => setChecks(result.hosts),
        (cause: unknown) =>
          setChecks([{ hostId: "-", hostName: "Check failed", ok: false, configDir: null, email: null, error: message(cause), login: null }]),
      )
      .finally(() => setChecking(false));
  }, [rpc, profile.id]);
  // Live while the row is on screen: check now, then again as the cache goes stale.
  useEffect(() => {
    check();
    const timer = setInterval(check, STATUS_TTL_MS);
    return () => clearInterval(timer);
  }, [check]);
  const loginCommand = profile.configDir
    ? `CLAUDE_CONFIG_DIR=${profile.configDir} claude   # then /login`
    : null;
  return (
    <li className="py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">{profile.label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {[profile.configDir, profile.hasToken ? (profile.apiKey ? "API key" : "token") : null].filter(Boolean).join(" + ")}
        </span>
        <IconAction tooltip="Check again" label={`Check ${profile.label} again`} onClick={check} disabled={checking}>
          <Icon name="claude-profiles/refresh" className={cn("size-4", checking && "animate-spin")} />
        </IconAction>
        {onEdit ? (
          <>
            <IconAction tooltip="Edit" label={`Edit ${profile.label}`} onClick={onEdit}>
              <Icon name="claude-profiles/edit" className="size-4" />
            </IconAction>
            <IconAction
              tooltip="Delete"
              label={`Delete ${profile.label}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => void rpc.call("accounts_remove", { id: profile.id })}
            >
              <Icon name="Trash2" className="size-4" />
            </IconAction>
          </>
        ) : null}
      </div>
      {checks !== null ? <HostChecks checks={checks} /> : null}
      {checks?.some((c) => !c.ok) && loginCommand ? (
        <code className="mt-1 block rounded bg-muted px-2 py-1 text-xs">{loginCommand}</code>
      ) : null}
    </li>
  );
}

function useProjects() {
  const sdk = useSdk();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    sdk.projects.list().then(
      (list) => setProjects(list.map((p) => ({ id: p.id, name: p.name }))),
      () => undefined,
    );
  }, [sdk]);
  return projects;
}

function SettingsSection() {
  const { rpc, accounts, error } = useAccounts();
  const projects = useProjects();
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const sortedProfiles = useMemo(
    () => [...(accounts?.profiles ?? [])].sort((a, b) => a.label.localeCompare(b.label)),
    [accounts],
  );
  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (accounts === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-5 text-sm">
      <section>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-medium">Accounts</h3>
          {editing === null ? (
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <Icon name="Plus" /> Add account
            </Button>
          ) : null}
        </div>
        {editing !== null ? (
          <ProfileForm initial={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
        ) : null}
        <ul className="divide-y divide-border">
          {/* The machine's own `claude /login`: checked like an account, but not editable here. */}
          <ProfileRow profile={MACHINE_PROFILE} />
          {sortedProfiles.map((profile) => (
            <ProfileRow key={profile.id} profile={profile} onEdit={() => setEditing(profile)} />
          ))}
        </ul>
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Defaults</h3>
        <p className="text-xs text-muted-foreground">
          A new thread is pinned to its account on its first run, so changing a default affects
          only threads started afterwards.
        </p>
        <div className="flex items-center justify-between gap-3">
          <span>All projects</span>
          <AccountSelect
            ariaLabel="Global default account"
            accounts={accounts}
            value={accounts.globalDefault}
            defaultId={SYSTEM_PROFILE}
            onChange={(profileId) => void rpc.call("accounts_set_default", { projectId: null, profileId })}
          />
        </div>
        {projects.map((project) => (
          <div key={project.id} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">{project.name}</span>
            <AccountSelect
              ariaLabel={`Default account for ${project.name}`}
              accounts={accounts}
              value={accounts.projectDefaults[project.id] ?? null}
              defaultId={accounts.globalDefault ?? SYSTEM_PROFILE}
              onChange={(profileId) =>
                void rpc.call("accounts_set_default", { projectId: project.id, profileId })
              }
            />
          </div>
        ))}
      </section>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "accounts",
    title: "Claude profiles",
    description: "Claude Code accounts, and which one each project uses by default.",
    component: SettingsSection,
  });
  app.slots.experimental_appOverlay({ id: "switch-consent", component: SwitchConsentDialog });
  app.slots.experimental_threadInfoRow({
    id: "claude-account",
    group: experimental_THREAD_INFO_ROW_GROUPS.thread,
    component: ThreadAccountRow,
  });
  app.slots.experimental_threadAction({
    id: "claude-account",
    title: "Claude account",
    icon: "claude-profiles/accounts",
    group: experimental_THREAD_ACTION_GROUPS.settings,
    order: 100,
    useData: useThreadActionData,
    item: ({ thread, data }) => {
      const { rpc, accounts, choices } = data;
      if (accounts === null || accounts.profiles.length === 0) return null;
      const current = choices[thread.id]?.profileId ?? null;
      const options = [{ id: SYSTEM_PROFILE }, ...accounts.profiles].map(({ id }) => ({ id, label: labelOf(accounts, id) }));
      return {
        label: "Claude account",
        detail: current === null ? "Not started" : labelOf(accounts, current),
        icon: "claude-profiles/accounts",
        choices: {
          items: options.map((option) => ({
            id: option.id,
            label: [option.label, statusText(accounts, option.id)].filter(Boolean).join(" · "),
            selected: option.id === current,
          })),
          hint: "A started conversation is copied to the new account after you confirm.",
        },
        run: async ({ value }) => {
          if (value === undefined || value === current) return;
          const result = await rpc.call("accounts_switch", {
            threadId: thread.id,
            profileId: value,
            confirm: false,
          });
          if (result.status === "needs-confirm") {
            setPendingSwitch({
              threadId: thread.id,
              profileId: value,
              fromLabel: labelOf(accounts, current),
              toLabel: labelOf(accounts, value),
            });
          }
        },
      };
    },
  });
  app.composer.customize({
    id: "claude-account",
    scopes: ["new-thread"],
    actions: [{ id: "account", component: NewThreadAccountPicker }],
  });
});
