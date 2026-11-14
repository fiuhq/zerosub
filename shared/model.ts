import { z } from "zod";

/**
/**
 * The provider families this plugin manages, one adapter each: the subscription CLIs, and Pi, whose
 * added accounts are Anthropic API keys. Custom provider profiles map onto one of them. Adding a
 * family means a value here, a row in each table below, and its adapter.
 */
export const FamilySchema = z.enum(["claude", "codex", "kimi", "copilot", "opencode", "pi"]);
export type Family = z.infer<typeof FamilySchema>;
export const FAMILIES: readonly Family[] = FamilySchema.options;

/** The subscription, as people name it. */
export const FAMILY_LABEL: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  kimi: "Kimi",
  copilot: "Copilot",
  opencode: "OpenCode Go",
  pi: "Pi",
};

/** Section headings on the Accounts screen. */
export const FAMILY_HEADING: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT (Codex)",
  kimi: "Kimi Code",
  copilot: "GitHub Copilot",
  opencode: "OpenCode Go",
  pi: "Pi",
};

/** The CLI that signs in and runs the agents. */
export const FAMILY_CLI: Record<Family, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi Code",
  copilot: "Copilot CLI",
  opencode: "OpenCode",
  pi: "Pi",
};

/**
 * Whether a conversation can move to another account of its provider in place. ChatGPT encrypts its
 * reasoning per account, so a Codex thread with history carries on in a new agent instead.
 */
export const FAMILY_PORTABLE: Record<Family, boolean> = {
  claude: true,
  codex: false,
  kimi: true,
  copilot: true,
  opencode: true,
  pi: true,
};

/**
 * How signing in works. `paste`: one link finishes by itself on the host and another shows a code to
 * paste back, both from the same flow. `switchable`: a browser callback or a device code typed on the
 * provider's page, each its own flow, so switching method starts a new one. `device`: only a device
 * code typed on the provider's page, from any device. Pi's added accounts are API keys, added from
 * their own form (see `AddPiAccountModal`), so its entry is never used to sign in.
 */
export const FAMILY_SIGN_IN: Record<Family, "paste" | "switchable" | "device"> = {
  claude: "paste",
  codex: "switchable",
  kimi: "device",
  copilot: "device",
  opencode: "paste",
  pi: "paste",
};

/**
 * Providers a stopped chat can carry on with when every account of its own is out, most preferred
 * first. The first that is installed and has a usable account takes over in a new agent. Pi isn't
 * one: its added accounts are billed per use and never take work over by themselves.
 */
export const FALLBACK_ORDER: readonly Family[] = ["claude", "codex", "kimi", "copilot", "opencode"];

/** "Claude, ChatGPT and Kimi": the subscriptions, as a phrase for people. */
export function familyPhrase(families: readonly Family[] = FALLBACK_ORDER, joiner = "and"): string {
  const labels = families.map((family) => FAMILY_LABEL[family]);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} ${joiner} ${labels.at(-1)}`;
}

/** The providers a `from` agent can carry on with, most preferred first; none for Pi. */
export function fallbackFamilies(from: Family): Family[] {
  return FALLBACK_ORDER.includes(from) ? FALLBACK_ORDER.filter((family) => family !== from) : [];
}

/** Stands for a proxy's password (or a user name with none) wherever the proxy is shown. */
export const HIDDEN = "•••";

export const UsageWindowSchema = z.object({
  /** Stable key, e.g. `five_hour`, `seven_day`, `seven_day_opus`, `primary`, `secondary`. */
  id: z.string(),
  label: z.string(),
  /** 0–100. */
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  /** How long the window is, in minutes. Only Codex readings have it; `null` when Codex doesn't say. */
  minutes: z.number().nullable().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** Banked limit resets the provider has granted this account (Claude "limit reset", Codex reset credits). */
export const ResetOfferSchema = z.object({
  /** Resets left to use. */
  available: z.number(),
  /** The provider will accept a redeem right now. */
  usableNow: z.boolean(),
  /** Why it can't be used yet, in plain words, when it can't. */
  blockedReason: z.string().nullable(),
  /** Use-by date of the next reset, if it expires. */
  expiresAt: z.string().nullable(),
  /** Which limits a reset refills, e.g. "5-hour", "weekly". Empty when the provider doesn't say. */
  refills: z.array(z.string()),
  /** The provider's own name for the reset, if it gives one. */
  label: z.string().nullable(),
});
export type ResetOffer = z.infer<typeof ResetOfferSchema>;

/** Prepaid credits that keep an account going once its windows run out (ChatGPT credits for Codex). */
export const CreditsSchema = z.object({
  /** Credits left; `null` when the provider doesn't say how many. */
  balance: z.number().nullable(),
  unlimited: z.boolean(),
});
export type Credits = z.infer<typeof CreditsSchema>;

export const UsageSchema = z.object({
  fetchedAt: z.string(),
  windows: z.array(UsageWindowSchema),
  /** Why usage could not be read, if it could not. Old windows may still be shown. */
  error: z.string().nullable(),
  /** Read from the CLI's own cache rather than the provider, so possibly out of date. */
  cached: z.boolean().default(false),
  /** Banked resets, when the provider reports any. */
  resets: ResetOfferSchema.nullable().default(null),
  /** Credits the account can spend past full windows, when the provider reports any. */
  credits: CreditsSchema.nullable().default(null),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AccountKindSchema = z.enum([
  /** The login the CLI uses on its own (`~/.claude`, `~/.codex`). */
  "main",
  /** Created by this plugin: an isolated credential home that shares everything else with main. */
  "managed",
]);
export type AccountKind = z.infer<typeof AccountKindSchema>;

export const AuthKindSchema = z.enum([
  /** Signed in with a Claude or ChatGPT subscription (or, for Pi's own login, whatever Pi is signed in to). */
  "subscription",
  /** An added Pi account: an Anthropic API key, billed per use, so never picked automatically. */
  "api",
]);
export type AuthKind = z.infer<typeof AuthKindSchema>;

/** An API key's settings as shown in the app; the key itself never leaves the host. */
export const ApiSummarySchema = z.object({
  /** The key's last four characters, or empty for a key too short to show any of it. */
  keyHint: z.string(),
  /** Where Anthropic's requests go, or null for Anthropic's own API. */
  baseUrl: z.string().nullable(),
});
export type ApiSummary = z.infer<typeof ApiSummarySchema>;

/** The address an account's requests come from, as the provider's edge sees it. */
export const EgressSchema = z.object({
  /** From the last check that worked. */
  ip: z.string().nullable(),
  /** The country the edge places it in, like "US". */
  country: z.string().nullable(),
  /** When that check was. */
  checkedAt: z.string().nullable(),
  /** Why the latest check failed, when it did. */
  error: z.string().nullable(),
});
export type Egress = z.infer<typeof EgressSchema>;

/** `disabled`: the user set it aside for a while; it stays signed in but nothing is routed to it. */
export const AccountStatusSchema = z.enum(["ready", "signed_out", "limited", "checking", "disabled"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  label: z.string(),
  kind: AccountKindSchema,
  email: z.string().nullable(),
  plan: z.string().nullable(),
  organization: z.string().nullable(),
  status: AccountStatusSchema,
  isDefault: z.boolean(),
  /** Set while the next new agent of this family will start on this account (one-time pick). */
  nextAgentUntil: z.string().nullable().optional(),
  limitedUntil: z.string().nullable(),
  usage: UsageSchema.nullable(),
  agentCount: z.number(),
  home: z.string().nullable(),
  /** Paseo projects whose agents use this account. */
  projects: z.array(z.object({ projectId: z.string(), name: z.string().nullable() })).default([]),
  auth: AuthKindSchema.default("subscription"),
  /** An added Pi account's key (reduced to a hint) and base URL, and Pi's own login's while it keeps an Anthropic key. */
  api: ApiSummarySchema.nullable().default(null),
  /** Its Anthropic key and base URL can be changed from its card (Pi accounts, Pi's own login included). */
  apiEditable: z.boolean().default(false),
  /** The account's own proxy, password hidden (as `HIDDEN`). Null when it uses whatever it inherits. */
  proxy: z.string().nullable().default(null),
  /** A proxy can be set for this account here (Pi accounts, Pi's own login included). */
  proxyEditable: z.boolean().default(false),
  /** The proxy it goes through without one of its own, password hidden, and where that's set. */
  inheritedProxy: z.object({ proxy: z.string(), from: z.string() }).nullable().default(null),
  /** The user's file its own proxy is kept in (Pi's own login: `httpProxy` in `~/.pi/agent/settings.json`). */
  proxyFile: z.string().nullable().default(null),
  /** Added accounts that go through the same proxy, having none of their own, while it's kept in `proxyFile`. */
  proxyFollowers: z.array(z.string()).default([]),
  /** Command (a script in `StateView.piLaunchers`) that starts the CLI on this account. */
  launcher: z.string().nullable().default(null),
  /** Where the account's requests come from, as Anthropic sees them; null when unknown or not Anthropic. */
  egress: EgressSchema.nullable().default(null),
  /**
   * The home is outside ZeroSub's own `homes/` folder (where added Pi accounts are kept): removing the
   * account only takes it out of ZeroSub, and its folder, key and script stay.
   */
  externalHome: z.boolean().default(false),
  /** The account's home is due to move to `to`, and hasn't yet: what it waits for, or what went wrong. */
  moving: z.object({ to: z.string(), waiting: z.string().nullable(), error: z.string().nullable() }).nullable().default(null),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

export const AgentRouteSchema = z.object({
  agentId: z.string(),
  family: FamilySchema,
  /** Account the agent uses now, or will use when its session next opens. */
  accountId: z.string(),
  /** Chosen for this agent explicitly (by the user or an automatic switch) rather than following the default. */
  pinned: z.boolean(),
  /** The live session still runs on a different account and is waiting to be reopened. */
  pendingAccountId: z.string().nullable(),
  /**
   * While `pendingAccountId` is set, when the session moves: `idle` once the agent is idle (within
   * half a minute), `turn` when its current turn ends, `background` once background work it left
   * running stops, `restart` when its session next starts (it isn't moved unattended, reloading it
   * didn't work, or Paseo's CLI isn't there to do it).
   */
  waiting: z.enum(["idle", "turn", "background", "restart"]).nullable().default(null),
  /**
   * The conversation can move to another account in place. False for Codex agents that already
   * have history: ChatGPT accounts can't read each other's encrypted reasoning, so switching
   * continues the work in a new agent instead.
   */
  movable: z.boolean(),
  /** The agent started on this account because its weekly reset was near, and is still on it. */
  selectionReason: z.literal("weekly_reset").optional(),
});
export type AgentRoute = z.infer<typeof AgentRouteSchema>;

export const LoginStepSchema = z.enum([
  "starting",
  /** Waiting for the user to finish on the sign-in page (and paste a code, if using `codeUrl`). */
  "waiting",
  "verifying",
  "done",
  "failed",
  "canceled",
]);
export type LoginStep = z.infer<typeof LoginStepSchema>;

export const LoginMethodSchema = z.enum([
  /** Finishes by itself when the link is opened on the daemon machine. */
  "browser",
  /** Works from any device: paste a code back (Claude) or type a code on the page (ChatGPT). */
  "code",
]);
export type LoginMethod = z.infer<typeof LoginMethodSchema>;

export const LoginViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  method: LoginMethodSchema,
  /** Set once the account exists (immediately when signing an existing account back in). */
  accountId: z.string().nullable(),
  step: LoginStepSchema,
  /** Link that completes by itself (browser callback) or the device-code page. */
  url: z.string().nullable(),
  /** Link whose page shows a code to paste back; works from any device. */
  codeUrl: z.string().nullable(),
  /** Device code the user types on the sign-in page (ChatGPT device flow). */
  userCode: z.string().nullable(),
  message: z.string().nullable(),
  startedAt: z.string(),
});
export type LoginView = z.infer<typeof LoginViewSchema>;

export const StateViewSchema = z.object({
  accounts: z.array(AccountViewSchema),
  agents: z.array(AgentRouteSchema),
  logins: z.array(LoginViewSchema),
  /** Paseo provider IDs (including custom profiles) that route through each family. */
  providers: z.record(z.string(), FamilySchema),
  /** Live sessions can be reopened on another account without waiting for the next session start. */
  canReopen: z.boolean(),
  /**
   * A browser on the daemon's machine can finish a sign-in by itself. False on servers, containers
   * and daemons started over SSH, where only the code sign-in works.
   */
  browserSignIn: z.boolean().default(true),
  /** Directory with a `pi-<account>.sh` script per added Pi account, to put on `PATH`. */
  piLaunchers: z.string().nullable().default(null),
  /** The folder added Pi accounts' homes are kept in (`~/.pi-config`, say), and whether it's the default. */
  piHomes: z.object({ dir: z.string(), isDefault: z.boolean() }).nullable().default(null),
  showComposerPill: z.boolean(),
  /** Accounts at their limit are skipped, so agents can't be moved onto one by hand either. */
  autoSwitch: z.boolean().default(true),
  warnings: z.array(z.string()),
});
export type StateView = z.infer<typeof StateViewSchema>;
