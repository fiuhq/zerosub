import { z } from "zod";

/**
 * The subscription families this plugin manages, one adapter each. Custom provider profiles map onto
 * one of them. Adding a family means a value here, a row in each table below, and its adapter.
 */
export const FamilySchema = z.enum(["claude", "codex", "kimi", "copilot"]);
export type Family = z.infer<typeof FamilySchema>;
export const FAMILIES: readonly Family[] = FamilySchema.options;

/** The subscription, as people name it. */
export const FAMILY_LABEL: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  kimi: "Kimi",
  copilot: "Copilot",
};

/** Section headings on the Accounts screen. */
export const FAMILY_HEADING: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT (Codex)",
  kimi: "Kimi Code",
  copilot: "GitHub Copilot",
};

/** The CLI that signs in and runs the agents. */
export const FAMILY_CLI: Record<Family, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi Code",
  copilot: "Copilot CLI",
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
};

/**
 * How signing in works. `paste`: one link finishes by itself on the host and another shows a code to
 * paste back, both from the same flow. `switchable`: a browser callback or a device code typed on the
 * provider's page, each its own flow, so switching method starts a new one. `device`: only a device
 * code typed on the provider's page, from any device.
 */
export const FAMILY_SIGN_IN: Record<Family, "paste" | "switchable" | "device"> = {
  claude: "paste",
  codex: "switchable",
  kimi: "device",
  copilot: "device",
};

/**
 * Providers a stopped chat can carry on with when every account of its own is out, most preferred
 * first. The first that is installed and has a usable account takes over in a new agent.
 */
export const FALLBACK_ORDER: readonly Family[] = ["claude", "codex", "kimi", "copilot"];

/** "Claude, ChatGPT and Kimi": the subscriptions, as a phrase for people. */
export function familyPhrase(families: readonly Family[] = FALLBACK_ORDER, joiner = "and"): string {
  const labels = families.map((family) => FAMILY_LABEL[family]);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} ${joiner} ${labels.at(-1)}`;
}

/** The providers a `from` agent can carry on with, most preferred first. */
export function fallbackFamilies(from: Family): Family[] {
  return FALLBACK_ORDER.filter((family) => family !== from);
}

export const UsageWindowSchema = z.object({
  /** Stable key, e.g. `five_hour`, `seven_day`, `seven_day_opus`, `primary`, `secondary`. */
  id: z.string(),
  label: z.string(),
  /** 0–100. */
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
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

export const UsageSchema = z.object({
  fetchedAt: z.string(),
  windows: z.array(UsageWindowSchema),
  /** Why usage could not be read, if it could not. Old windows may still be shown. */
  error: z.string().nullable(),
  /** Read from the CLI's own cache rather than the provider, so possibly out of date. */
  cached: z.boolean().default(false),
  /** Banked resets, when the provider reports any. */
  resets: ResetOfferSchema.nullable().default(null),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AccountKindSchema = z.enum([
  /** The login the CLI uses on its own (`~/.claude`, `~/.codex`). */
  "main",
  /** Created by this plugin: an isolated credential home that shares everything else with main. */
  "managed",
]);
export type AccountKind = z.infer<typeof AccountKindSchema>;

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
  limitedUntil: z.string().nullable(),
  usage: UsageSchema.nullable(),
  agentCount: z.number(),
  home: z.string().nullable(),
  /** Paseo projects whose agents use this account. */
  projects: z.array(z.object({ projectId: z.string(), name: z.string().nullable() })).default([]),
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
   * The conversation can move to another account in place. False for Codex agents that already
   * have history: ChatGPT accounts can't read each other's encrypted reasoning, so switching
   * continues the work in a new agent instead.
   */
  movable: z.boolean(),
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
  showComposerPill: z.boolean(),
  warnings: z.array(z.string()),
});
export type StateView = z.infer<typeof StateViewSchema>;
