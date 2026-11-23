import { accountPeak, capsAccount, windowScope } from "../shared/format";
import { isAzureAccount, isBedrockAccount, onAnthropicApi, PACE_GATE_PERCENT, WEEK_NEARLY_USED_PERCENT, type Family, type PaceView, type Usage, type UsageWindow } from "../shared/model";
import { compareUpNext, isLongWindow, upNextRank } from "../shared/up-next";
import { FIVE_HOUR_MINUTES, WEEK_MINUTES } from "./codex";
import {
  accountsOf,
  defaultAccount,
  findAccount,
  mainAccount,
  type Binding,
  type NextAgentPick,
  type StoredAccount,
  type StoredState,
} from "./state";

/** Weekly resets only steer a new agent when every account it could use was read this recently. */
const FRESH_READING_MS = 30 * 60_000;
/** How soon a weekly reset has to be for its account to be preferred. */
const NEAR_RESET_MS = 24 * 60 * 60_000;
/** The most a near-reset account may have used of any window, so it still has room to spare. */
const NEAR_RESET_MAX_USED_PERCENT = 80;
/**
 * An account that has used this much of its 5-hour window is about to run out of it: when spreading
 * new agents, any account under this ranks ahead of every account past it, unless a window that caps
 * it is full (see `mostAvailable`).
 */
const FIVE_HOUR_GATE_PERCENT = PACE_GATE_PERCENT;

const FIVE_HOUR_MS = FIVE_HOUR_MINUTES * 60_000;
const WEEK_MS = WEEK_MINUTES * 60_000;
/** Tunable: how far ahead the 5-hour use is projected. Rests on a low-confidence window size. */
const PACE_HORIZON_MS = 3_600_000;
/** Tunable: a young window's burn rate is measured over at least this long, so a first burst doesn't extrapolate wildly. */
const MIN_FIVE_HOUR_ELAPSED_MS = 1_800_000;
/** Tunable: the least share of the week that counts as elapsed, so a fresh week doesn't inflate the pace. */
const MIN_WEEK_SHARE = 1 / 7;
const UNKNOWN_SCORE = 50;
/** Tunable: 5-hour percent charged for each agent placed on an account since its reading. */
export const PENDING_FIVE_HOUR_PERCENT = 10;
/** Tunable: weekly percent charged for each agent placed on an account since its reading. */
export const PENDING_WEEKLY_PERCENT = 2;
/** How long a placement counts as pending, until a usage reading can show it. */
export const PENDING_MS = 600_000;

export function isLimited(account: StoredAccount, now: number): boolean {
  if (!account.limitedUntil) return false;
  const until = Date.parse(account.limitedUntil);
  return Number.isFinite(until) && until > now;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/**
 * Whether a model limit's scope ("fable") covers a model id ("claude-fable-5-2"): every word of the
 * scope is a word of the model. An unknown or default model is covered by nothing, so it's never
 * kept off an account for a limit of one model.
 */
export function scopeCoversModel(scope: string, model: string | null | undefined): boolean {
  if (!model || model.toLowerCase() === "default") return false;
  const wanted = tokens(scope);
  if (wanted.length === 0) return false;
  const have = new Set(tokens(model));
  return wanted.every((token) => have.has(token));
}

/** Omit model to check all windows, or pass null to check account-wide windows only. */
export function quotaCeilingHit(account: StoredAccount, usage: Usage | null | undefined, now: number, model?: string | null): UsageWindow | undefined {
  if (!account.quotaCeilings) return undefined;
  return usage?.windows.find((window) => {
    const ceiling = account.quotaCeilings?.[window.id];
    return (model === undefined || capsAccount(window) || scopeCoversModel(windowScope(window), model)) &&
      typeof ceiling === "number" && window.usedPercent >= ceiling &&
      (!window.resetsAt || Date.parse(window.resetsAt) > now);
  });
}

/** The account is at a limit of its own, or at the limit of a model window that covers `model`. */
export function isLimitedFor(account: StoredAccount, now: number, model?: string | null, usage?: Usage | null): boolean {
  if (isLimited(account, now) || quotaCeilingHit(account, usage, now, model ?? null)) return true;
  return Object.entries(account.modelLimits ?? {}).some(
    ([scope, limit]) => Date.parse(limit.until) > now && scopeCoversModel(scope, model),
  );
}

export function isUsable(account: StoredAccount, now: number, model?: string | null, usage?: Usage | null): boolean {
  return account.signedIn && !account.disabled && !isLimitedFor(account, now, model, usage);
}

/**
 * Routing may put agents on this account by itself: it's usable and not billed per use. No Pi
 * account is ever picked that way: an added one is an API key, and Pi's own login may be one too,
 * so moving work onto either would move it onto a bill nobody chose.
 */
export function canStandIn(account: StoredAccount, now: number, model?: string | null, usage?: Usage | null): boolean {
  return account.family !== "pi" && account.auth !== "api" && isUsable(account, now, model, usage);
}

/**
 * A paid API account that stands in for a subscription (an Azure OpenAI account under ChatGPT, an AWS
 * Bedrock account under Claude), marked so when it was added. Like any API account it's billed per use, so routing never puts agents on it by itself
 * unless `paidApiFallback` is on, and then only as a last resort: once no subscription account of the
 * family can stand in (see `mostAvailable`). It can always be picked by hand, or made the default.
 */
export function isLastResort(account: StoredAccount): boolean {
  return isAzureAccount(account) || isBedrockAccount(account);
}

/**
 * An account `paidApiFallback` lets routing move work onto by itself once no subscription account of
 * the family can stand in: a marked stand-in (`isLastResort`), whatever `paidApi` (the preference)
 * says, as on main; and, only with it on, a Claude account on an API key or token that goes to
 * Anthropic's own API (`keyOnAnthropicApi`). Like the marked ones, it's billed per use, it's left
 * again once a subscription account has room, and it can always be picked by hand, or made the
 * default. With the preference off, a Claude key is an account like any other the user chose, and a
 * key on another endpoint (a gateway or a third-party service) always is: whole conversations don't
 * go there unasked. A Pi account never stands in (see `canStandIn`). Only the marked ones have their
 * own settings form, error and token counts (see `isLastResort`).
 */
export function isPaidStandIn(account: StoredAccount, paidApi: boolean): boolean {
  return isLastResort(account) || (paidApi && account.family === "claude" && account.auth === "api" && keyOnAnthropicApi(account));
}

/**
 * Whether a Claude API-key account's key goes to Anthropic's own API, as its identity records it:
 * `api|<where>|<hash>`, where is `anthropic` (or Anthropic's URL, as earlier versions saved it) or
 * the base URL. A kept key can't move to another base URL without being typed again, which saves a
 * new identity, so this holds. An account without an identity counts as elsewhere.
 */
export function keyOnAnthropicApi(account: StoredAccount): boolean {
  const [kind, where] = account.identity?.split("|") ?? [];
  return kind === "api" && where !== undefined && (where === "anthropic" || onAnthropicApi(where));
}

/**
 * Lower is better. Unknown usage ranks in the middle so a known-quiet account wins over a mystery.
 * A full window of one model only, such as "Weekly · Opus", leaves the account its room for the rest.
 * A window whose reset has passed since the reading starts again empty, so an account that just
 * reset ranks by what it has left, not by the full window its last reading showed.
 */
export function headroomScore(usage: Usage | null | undefined, now = Date.now()): number {
  const windows = usage?.windows.map((window) =>
    window.resetsAt && Date.parse(window.resetsAt) <= now ? { ...window, usedPercent: 0 } : window);
  const peak = windows ? accountPeak(windows) : null;
  return peak ? peak.usedPercent : 50;
}

/** The 5-hour window: Codex says how long its windows are, Claude's is known by id. */
export function fiveHourWindow(usage: Usage): UsageWindow | undefined {
  return usage.windows.find((window) => window.minutes === FIVE_HOUR_MINUTES) ??
    usage.windows.find((window) => window.minutes == null && (window.id === "five_hour" || window.id === "primary"));
}

/**
 * Whether the account has used `FIVE_HOUR_GATE_PERCENT` of its 5-hour window, and that window hasn't
 * reset yet. Unknown counts as under the gate.
 */
export function fiveHourGated(usage: Usage | null | undefined, now: number): boolean {
  const short = usage ? fiveHourWindow(usage) : undefined;
  if (!short || !Number.isFinite(short.usedPercent)) return false;
  if (short.resetsAt && Date.parse(short.resetsAt) <= now) return false;
  return short.usedPercent >= FIVE_HOUR_GATE_PERCENT;
}

/** Agents ZeroSub placed on an account that its latest usage reading may not show yet. */
export interface Pacing {
  pendingOf(accountId: string): number;
}

export interface PaceScore {
  /** Projected 5-hour use an hour ahead, plus pending agents. */
  fiveHour: number;
  /** Weekly use against the share of the week that has passed, plus pending agents. */
  weekly: number;
  score: number;
  gated: boolean;
  /** The week has used WEEK_NEARLY_USED_PERCENT or more and hasn't reset. */
  weekHeld: boolean;
}

export function weeklyWindow(usage: Usage): UsageWindow | undefined {
  return usage.windows.find((window) => window.minutes === WEEK_MINUTES) ??
    usage.windows.find((window) => window.minutes == null && (window.id === "seven_day" || window.id === "secondary"));
}

/** Lower is better. Combines the 5-hour projection and the weekly pace; see the README. */
export function paceScore(usage: Usage | null | undefined, pending: number, now: number): PaceScore {
  const fiveCharge = PENDING_FIVE_HOUR_PERCENT * pending;
  const weekCharge = PENDING_WEEKLY_PERCENT * pending;
  const short = usage ? fiveHourWindow(usage) : undefined;
  const long = usage ? weeklyWindow(usage) : undefined;
  if (!usage || usage.windows.length === 0 || (!short && !long)) {
    const fiveHour = UNKNOWN_SCORE + fiveCharge;
    return { fiveHour, weekly: 0, score: fiveHour, gated: fiveHour >= FIVE_HOUR_GATE_PERCENT, weekHeld: false };
  }
  const parsed = Date.parse(usage.fetchedAt);
  const fetched = Number.isFinite(parsed) ? Math.min(parsed, now) : now;
  const expired = (window: UsageWindow) => !!window.resetsAt && Date.parse(window.resetsAt) <= now;

  let fiveHour = fiveCharge;
  if (short && Number.isFinite(short.usedPercent) && !expired(short)) {
    const reset = Date.parse(short.resetsAt ?? "");
    if (!Number.isFinite(reset)) fiveHour = short.usedPercent + fiveCharge;
    else {
      const elapsed = Math.max(MIN_FIVE_HOUR_ELAPSED_MS, fetched - (reset - FIVE_HOUR_MS));
      const ahead = Math.min(now + PACE_HORIZON_MS, reset) - fetched;
      fiveHour = short.usedPercent + (short.usedPercent / elapsed) * ahead + fiveCharge;
    }
  }
  let weekly = 0;
  if (long && Number.isFinite(long.usedPercent) && !expired(long)) {
    const reset = Date.parse(long.resetsAt ?? "");
    if (!Number.isFinite(reset)) weekly = long.usedPercent + weekCharge;
    else {
      const share = 1 - (reset - fetched) / WEEK_MS;
      weekly = (long.usedPercent + weekCharge) / Math.min(1, Math.max(MIN_WEEK_SHARE, share));
    }
  }
  return {
    fiveHour,
    weekly,
    score: Math.max(fiveHour, weekly),
    gated: fiveHourGated(usage, now) || fiveHour >= FIVE_HOUR_GATE_PERCENT,
    weekHeld: !!long && Number.isFinite(long.usedPercent) && !expired(long) && long.usedPercent >= WEEK_NEARLY_USED_PERCENT,
  };
}

/** `paceScore` broken into the parts an account card draws. */
export function paceView(usage: Usage | null | undefined, pending: number, now: number): PaceView {
  const pace = paceScore(usage, pending, now);
  const short = usage ? fiveHourWindow(usage) : undefined;
  const long = usage ? weeklyWindow(usage) : undefined;
  const expired = (window: UsageWindow) => !!window.resetsAt && Date.parse(window.resetsAt) <= now;
  const used = (window: UsageWindow | undefined) =>
    window && Number.isFinite(window.usedPercent) ? (expired(window) ? 0 : window.usedPercent) : null;
  const parsed = usage ? Date.parse(usage.fetchedAt) : Number.NaN;
  const fetched = Number.isFinite(parsed) ? Math.min(parsed, now) : now;
  const weekReset = long?.resetsAt ? Date.parse(long.resetsAt) : Number.NaN;
  const weekElapsed =
    long && Number.isFinite(long.usedPercent) && !expired(long) && Number.isFinite(weekReset)
      ? Math.min(100, Math.max(0, (1 - (weekReset - fetched) / WEEK_MS) * 100))
      : null;
  return {
    fiveHourUsed: used(short),
    fiveHourProjected: pace.fiveHour,
    pendingFiveHour: PENDING_FIVE_HOUR_PERCENT * pending,
    weeklyUsed: used(long),
    pendingWeekly: PENDING_WEEKLY_PERCENT * pending,
    weekElapsed,
    pending,
    gated: pace.gated,
  };
}

/** A reading with `pending` agents' use added: `PENDING_WEEKLY_PERCENT` each to a long window, `PENDING_FIVE_HOUR_PERCENT` to the rest. */
function withPending(usage: Usage | null | undefined, pending: number): Usage | null | undefined {
  if (!usage || pending <= 0) return usage;
  return {
    ...usage,
    windows: usage.windows.map((window) => ({
      ...window,
      usedPercent: window.usedPercent + pending * (isLongWindow(window) ? PENDING_WEEKLY_PERCENT : PENDING_FIVE_HOUR_PERCENT),
    })),
  };
}

/**
 * The usable account first in Up next, preferring the default, then the CLI login, on ties. Up next
 * puts an account at its short (5-hour) switch line, 80% by default, behind every account under it,
 * as `fiveHourGated` does, and one with a full window that caps it last. With `pacing` (balanced new
 * agents), an account its pending agents would carry past the 5-hour gate (`paceScore`), or one that
 * has used `WEEK_NEARLY_USED_PERCENT` of its week, goes behind every account that hasn't, before Up
 * next orders each group; a full window that caps an account still ranks it last, gate or not.
 *
 * With `paidFallback` (the `paidApiFallback` preference), a usable paid API account (`isPaidStandIn`)
 * is chosen once no subscription account can stand in; without it, never.
 */
export function mostAvailable(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
  lines: EarlyLines | null = null,
  paidFallback = false,
  pacing?: Pacing,
  model?: string | null,
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const open = accountsOf(state, family).filter((account) => !exclude.has(account.id));
  const subscriptions = open.filter((account) => canStandIn(account, now, model, usageOf(account.id)));
  const candidates =
    subscriptions.length > 0 || !paidFallback ? subscriptions : open.filter((account) => isPaidStandIn(account, paidFallback) && isUsable(account, now, model, usageOf(account.id)));
  // Pacing (balanced new agents): readings lag behind the agents just placed, so each pending one counts
  // as used in Up next, and an account they would carry past the 5-hour gate, or whose week is nearly
  // used, goes behind every account they wouldn't. Fewer pending agents break a tie, so a burst of new
  // agents spreads.
  const pendingOf = (account: StoredAccount) => pacing?.pendingOf(account.id) ?? 0;
  const ranks = new Map(
    candidates.map((account) => [account.id, upNextRank(withPending(usageOf(account.id), pendingOf(account)), now, lines ?? undefined)]),
  );
  const tier = new Map(
    candidates.map((account) => {
      const usage = usageOf(account.id);
      const pace = pacing ? paceScore(usage, pendingOf(account), now) : undefined;
      return [account.id, headroomScore(usage, now) >= 100 ? 2 : pace && (pace.gated || pace.weekHeld) ? 1 : 0];
    }),
  );
  const rank = (account: StoredAccount) => [
    pendingOf(account),
    account.id === preferred ? 0 : 1,
    account.kind === "main" ? 0 : 1,
    Date.parse(account.createdAt) || 0,
  ];
  candidates.sort((a, b) => {
    const order = tier.get(a.id)! - tier.get(b.id)! || compareUpNext(ranks.get(a.id)!, ranks.get(b.id)!);
    if (order !== 0) return order;
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) {
      const delta = (left[index] ?? 0) - (right[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  return candidates[0];
}

/**
 * Switch early: the percent used at which an account counts as nearly full, for windows that refill
 * within hours (Claude's 5-hour, Codex's primary) and for weekly or longer ones. A long window gets
 * its own, higher line because one turn barely moves it, while a 5-hour window can jump several
 * percent in a turn. 100 turns that kind of window off.
 */
export interface EarlyLines {
  short: number;
  long: number;
}

/**
 * A move to another account costs the conversation its prompt cache there, so an account is only
 * worth moving onto with this much room below every line; that also keeps agents from bouncing
 * between two accounts that are both nearly full.
 */
export const EARLY_MARGIN = 10;
/** A reading older than this is too stale to move an agent on. */
export const EARLY_READING_MS = 10 * 60_000;
/** A full window that refills this soon isn't worth leaving: the account is about to have room. */
export const EARLY_RESET_MS = 10 * 60_000;

function lineFor(window: UsageWindow, lines: EarlyLines): number {
  const line = isLongWindow(window) ? lines.long : lines.short;
  return line >= 100 ? Infinity : line;
}

/** A live, error-free reading taken recently enough to move an agent on. */
function current(usage: Usage | null | undefined, now: number): usage is Usage {
  return Boolean(usage && !usage.cached && !usage.error && usage.windows.length > 0 && now - Date.parse(usage.fetchedAt) <= EARLY_READING_MS);
}

/**
 * The windows that make an account nearly full: at or over their line and not about to refill.
 * Empty when the reading can't be trusted, so a stale or failed reading never moves an agent.
 */
export function nearlyFull(usage: Usage | null | undefined, lines: EarlyLines, now: number): UsageWindow[] {
  if (!current(usage, now)) return [];
  return usage.windows.filter((window) => {
    if (window.usedPercent < lineFor(window, lines)) return false;
    const resets = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return !(Number.isFinite(resets) && resets - now <= EARLY_RESET_MS);
  });
}

/** The account has a current reading with `EARLY_MARGIN` to spare below every line. */
export function hasRoom(usage: Usage | null | undefined, lines: EarlyLines, now: number): boolean {
  return current(usage, now) && usage.windows.every((window) => window.usedPercent < lineFor(window, lines) - EARLY_MARGIN);
}

/** The roomiest usable account, other than `exclude`, that is worth moving onto early, if any. */
export function roomyAccount(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  lines: EarlyLines,
  now: number,
  exclude: ReadonlySet<string>,
): StoredAccount | undefined {
  const cramped = accountsOf(state, family).filter((account) => !hasRoom(usageOf(account.id), lines, now));
  return mostAvailable(state, family, usageOf, now, new Set([...exclude, ...cramped.map((account) => account.id)]), lines);
}

/** The account `projectId` uses for this family, if one is set. */
export function projectAccount(state: StoredState, family: Family, projectId: string | null | undefined): StoredAccount | undefined {
  if (!projectId) return undefined;
  for (const rule of state.projects) {
    if (rule.projectId !== projectId) continue;
    const account = findAccount(state, rule.accountId);
    if (account?.family === family) return account;
  }
  return undefined;
}

/** Accounts set aside for other projects: nothing automatic puts an agent of `projectId` on them. An unknown project reserves nothing. */
export function reservedElsewhere(state: StoredState, projectId: string | null | undefined): Set<string> {
  if (!projectId) return new Set();
  const mine = new Set(state.projects.filter((rule) => rule.projectId === projectId).map((rule) => rule.accountId));
  return new Set(state.projects.map((rule) => rule.accountId).filter((id) => !mine.has(id)));
}


/**
 * A subscription account at a usage-window limit (5-hour or weekly) whose latest reading shows a
 * banked reset it can spend right now. With `autoRedeem` on, a new agent opens on it rather than on
 * a paid stand-in: its first turn hits the limit and spends the reset, as it would with paid fallback
 * off. Signed-out, disabled and budget-limited accounts never count, nor does any API account.
 * Accounts in `exclude` (set aside for other projects) never count.
 * Preferred: the default, then the CLI login, then the most resets left.
 */
export function withBankedReset(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const left = (account: StoredAccount) => usageOf(account.id)?.resets?.available ?? 0;
  return accountsOf(state, family)
    .filter((account) => account.family !== "pi" && account.auth !== "api" && !isLastResort(account) &&
      !exclude.has(account.id) && account.signedIn && !account.disabled && account.limitKind === "window" && isLimited(account, now))
    .filter((account) => {
      const usage = usageOf(account.id);
      const resets = usage?.resets;
      return !quotaCeilingHit(account, usage, now, null) && !!resets && resets.available > 0 && resets.usableNow;
    })
    .sort((a, b) =>
      (a.id === preferred ? 0 : 1) - (b.id === preferred ? 0 : 1) ||
      (a.kind === "main" ? 0 : 1) - (b.kind === "main" ? 0 : 1) ||
      left(b) - left(a))[0];
}


/** Prefer a weekly reset within a day only when every usable account has fresh, complete usage. Accounts in `exclude` are never picked. */
function soonestWeeklyReset(state: StoredState, family: Family, usageOf: RouteInput["usageOf"], now: number, exclude: ReadonlySet<string> = new Set()): StoredAccount | undefined {
  // An API account has no plan windows, and is never preferred for a reset coming up.
  const candidates = accountsOf(state, family).filter((account) => isUsable(account, now, null, usageOf(account.id)) && account.auth !== "api" && !exclude.has(account.id));
  const readings = candidates.map((account) => ({ account, usage: usageOf(account.id) }));
  const complete = readings.every(({ usage }) => {
    if (!usage || usage.error || usage.cached) return false;
    const age = now - Date.parse(usage.fetchedAt);
    const short = usage.windows.find((window) => window.minutes === FIVE_HOUR_MINUTES);
    const weekly = usage.windows.find((window) => window.minutes === WEEK_MINUTES);
    return Number.isFinite(age) && age >= 0 && age <= FRESH_READING_MS && !!short && !!weekly &&
      [short, weekly].every((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0 &&
        window.usedPercent <= 100 && window.resetsAt !== null && Date.parse(window.resetsAt) > now);
  });
  if (!complete) return undefined;
  return readings.filter(({ usage }) => {
    const weekly = usage!.windows.find((window) => window.minutes === WEEK_MINUTES)!;
    return usage!.windows.every((window) => window.usedPercent <= NEAR_RESET_MAX_USED_PERCENT) &&
      Date.parse(weekly.resetsAt!) - now <= NEAR_RESET_MS;
  }).sort((a, b) => Date.parse(a.usage!.windows.find((window) => window.minutes === WEEK_MINUTES)!.resetsAt!) -
    Date.parse(b.usage!.windows.find((window) => window.minutes === WEEK_MINUTES)!.resetsAt!))[0]?.account;
}

export interface RouteInput {
  agentId: string;
  family: Family;
  reason: "create" | "resume" | "refresh" | "import";
  now: number;
  autoSwitch: boolean;
  balanceNewAgents: boolean;
  /**
   * Whether an existing conversation can open on a different account. When it can't (Codex), a
   * thread stays on the account it started on, and only brand-new agents are balanced or rerouted.
   */
  portable: boolean;
  usageOf(accountId: string): Usage | null | undefined;
  /** Switch early: keep new and reopening agents off nearly full accounts. Null when it's off. */
  early?: EarlyLines | null;
  /**
   * Whether a session really opens now (Paseo's session_open), rather than routing working out where
   * an agent belongs (alignment, a reconcile, the account button). Only a real open moves an existing
   * conversation off a nearly full account: a prediction that did would reload idle agents unasked.
   */
  opening?: boolean;
  /** The Paseo project of the agent's workspace, when known. */
  projectId?: string | null;
  /**
   * The account the agent's session runs on now. When the account it's routed to has to be skipped
   * and this one can stand in, the agent stays on it rather than following whichever account ranks
   * first at the moment, which would move it again each time two accounts swap places.
   */
  current?: string;
  /** A paid API account may stand in once every subscription account is out (`paidApiFallback`). */
  paidFallback?: boolean;
  /**
   * The `paidApiFallback` preference itself, which decides whether a Claude API key is a paid
   * stand-in at all (see `isPaidStandIn`); `paidFallback` when left out. `paidFallback` may be off
   * for one agent (Claude's Auto mode, which Bedrock can't run) while the key it's on still is one.
   */
  paidApi?: boolean;
  /**
   * Banked resets are spent when every account is out (`autoRedeem`). With it, a new agent opens on a
   * limited subscription with a usable reset before a paid stand-in (see `withBankedReset`).
   */
  autoRedeem?: boolean;
  /**
   * The account named for this agent when it was created (`ACCOUNT_METADATA_KEY` in its metadata):
   * chosen in its composer before it existed. Only a new agent without an account takes it.
   */
  requested?: string;
  /**
   * Whether this session may take the one-time "next new agent" pick: one the user's own agents
   * open, not Paseo's helpers (see `takesNextPick` in service.ts). Only a new agent takes it.
   */
  allowNextPick?: boolean;
  /** Agents recently placed on an account; only read while `balanceNewAgents` is on. */
  pendingOf?(accountId: string): number;
  /**
   * The model the agent runs, when known. A limit of that model's own window keeps the agent off the
   * account; without it only limits of the whole account count.
   */
  model?: string | null;
}

export interface RouteDecision {
  account: StoredAccount;
  /** A binding to persist so the agent stays where it was routed. */
  bind: Binding | null;
  /** Why the preferred account was skipped, if it was. */
  skipped: { account: StoredAccount; why: "limited" | "signed_out" | "disabled" | "nearly_full" } | null;
  /**
   * The "next new agent" pick routing looked at, to be cleared: it's spent whether the agent starts
   * on its account or that account couldn't take it.
   */
  nextPick?: NextAgentPick;
}

/**
 * Which account a session opens on: the agent's own binding, else (for a new agent) the account
 * named for it or the one-time pick, else (for balanced new agents) the
 * roomiest account, else the default (the CLI login for an existing Codex thread ZeroSub never
 * routed). An exhausted or signed-out choice is swapped for the roomiest usable account when
 * automatic switching is on — for new agents always, and for existing ones only when their
 * conversation can move between accounts. A disabled choice is always swapped,
 * and the agent keeps its own binding so it returns once the account is enabled again. An agent
 * already running on a usable stand-in keeps it (see `RouteInput.current`).
 */
export function chooseAccount(state: StoredState, input: RouteInput): RouteDecision | null {
  const accounts = accountsOf(state, input.family);
  if (accounts.length === 0) return null;
  const at = new Date(input.now).toISOString();
  const fresh = input.reason === "create";
  const pacing: Pacing | undefined = input.balanceNewAgents
    ? { pendingOf: (id) => input.pendingOf?.(id) ?? 0 }
    : undefined;

  // Whether an account is a paid stand-in, by the preference rather than this one choice's `paidFallback`.
  const paidApi = input.paidApi ?? input.paidFallback ?? false;
  const standIn = (candidate: StoredAccount) => isPaidStandIn(candidate, paidApi);

  const binding = state.bindings[input.agentId];
  const bound = findAccount(state, binding?.accountId);
  let account = bound && bound.family === input.family ? bound : undefined;
  let bind: Binding | null = null;
  const reserved = reservedElsewhere(state, input.projectId);
  // A paid stand-in (Bedrock) that ZeroSub bound the agent to by itself (a ChatGPT chat continued on
  // Claude while every subscription was out) only holds it until a subscription account can take it:
  // one with room, or, with `autoRedeem`, a limited one with a banked reset to spend. Then the agent
  // routes as an unbound one would, and alignment takes it off the bill. One the user put there stays.
  // A binding marked as a stand-in's is let go of the same way after the setting is turned off.
  if (
    account && binding?.source === "auto" && input.portable && (standIn(account) || binding.standIn === true) &&
    (accounts.some((other) => canStandIn(other, input.now, input.model, input.usageOf(other.id))) || (input.autoRedeem && withBankedReset(state, input.family, input.usageOf, input.now)))
  ) {
    account = undefined;
  }

  // The account named for this very agent outranks the pick, which waits for an agent that names
  // none. One that can't take the agent is passed over, and the agent routes as usual.
  const takes = (candidate: StoredAccount | undefined): candidate is StoredAccount =>
    candidate?.family === input.family && candidate.signedIn && !candidate.disabled && !(input.autoSwitch && isLimitedFor(candidate, input.now, input.model, input.usageOf(candidate.id)));
  const requested = !account && fresh ? findAccount(state, input.requested) : undefined;
  if (takes(requested)) {
    account = requested;
    bind = { accountId: requested.id, source: "user", at };
  }

  // A pick whose account can't take the agent (at its limit, signed out, disabled, removed) is spent
  // all the same, and the agent routes as usual: kept, it would send every new agent to whichever
  // account stands in for its own until it expires.
  const nextPick = !account && fresh && input.allowNextPick ? (state.nextAgent?.[input.family] ?? undefined) : undefined;
  if (nextPick && Date.parse(nextPick.until) > input.now) {
    const picked = findAccount(state, nextPick.accountId);
    if (takes(picked)) {
      account = picked;
      bind = { accountId: picked.id, source: "user", at };
    }
  }
  // The project's account comes before the default and before spreading, but not before an account
  // chosen for this agent or one a limit or switch early moved it to, nor a thread that can't move.
  const dedicated = projectAccount(state, input.family, input.projectId);
  if (dedicated && (!account || (binding?.source === "balance" && (input.portable || fresh)))) {
    account = dedicated;
    if (!input.portable && bound?.id !== dedicated.id) bind = { accountId: dedicated.id, source: "thread", at };
  }
  if (!account && fresh && input.balanceNewAgents && accounts.length > 1) {
    // An agent of no known project spreads over the shared accounts only, as Up next shows.
    const kept = input.projectId ? reserved : new Set(state.projects.map((rule) => rule.accountId));
    const nearReset = input.family === "codex" ? soonestWeeklyReset(state, input.family, input.usageOf, input.now, kept) : undefined;
    account = nearReset ?? mostAvailable(state, input.family, input.usageOf, input.now, kept, input.early, input.paidFallback, pacing, input.model);
    // A banked reset is free, so it goes before a paid stand-in, as it does when a turn hits a limit.
    if (account && standIn(account) && input.autoRedeem) {
      account = withBankedReset(state, input.family, input.usageOf, input.now, kept) ?? account;
    }
    // An agent that can move isn't bound to a paid stand-in (Bedrock): it's only there until a
    // subscription account has room. A thread that can't move (Azure's) is, as it lives there.
    if (account && !(input.portable && standIn(account))) {
      bind = { accountId: account.id, source: "balance", at, selectionReason: nearReset ? "weekly_reset" : "headroom" };
    }
  }
  if (!account) {
    // An existing Codex thread ZeroSub never routed (imported from the user's own CLI, or started
    // while ZeroSub was off) ran on the CLI login, so it belongs to that login: on any other account
    // its encrypted reasoning can't be read. Only a brand-new agent follows the default.
    const unrouted = !input.portable && !fresh && !state.sessions[input.agentId] ? mainAccount(state, input.family) : undefined;
    account = unrouted ?? defaultAccount(state, input.family);
    // A default set aside for another project yields to a shared account, when there is one.
    // It keeps an agent on the shared account it already runs on, so shifting usage doesn't move it.
    if (account && !unrouted && reserved.has(account.id)) {
      const running = findAccount(state, state.sessions[input.agentId]?.accountId);
      const stays = running && running.family === input.family && isUsable(running, input.now, input.model, input.usageOf(running.id)) && !reserved.has(running.id);
      account = (stays ? running : mostAvailable(state, input.family, input.usageOf, input.now, reserved, input.early)) ?? account;
    }
    // A thread that can't move is pinned to the account it first opened on.
    if (account && !input.portable) bind = { accountId: account.id, source: "thread", at };
  }
  if (!account) return null;

  let skipped: RouteDecision["skipped"] = null;
  const why = !account.signedIn ? "signed_out" : account.disabled ? "disabled" : isLimitedFor(account, input.now, input.model, input.usageOf(account.id)) ? "limited" : null;
  const mayMove = fresh || input.portable;
  if (why && mayMove && (input.autoSwitch || why !== "limited")) {
    const staying = findAccount(state, input.current);
    // A paid stand-in is only kept while no subscription account could take over from it.
    const keeps = (stand: StoredAccount) =>
      !standIn(stand) ||
      !accountsOf(state, input.family).some((other) => other.id !== account!.id && !reserved.has(other.id) && canStandIn(other, input.now, input.model, input.usageOf(other.id)));
    const stays = (stand: StoredAccount) => {
      const usage = input.usageOf(stand.id);
      return canStandIn(stand, input.now, input.model, usage) ||
        (standIn(stand) && isUsable(stand, input.now, input.model, usage));
    };
    let alternative =
      staying && staying.family === input.family && staying.id !== account.id && stays(staying) && !reserved.has(staying.id) && keeps(staying)
        ? staying
        : mostAvailable(state, input.family, input.usageOf, input.now, new Set([...reserved, account.id]), input.early, input.paidFallback, pacing, input.model);
    // Before a paid stand-in, a limited subscription with a usable banked reset: the account itself
    // (it stays, and its first turn spends the reset) or another one.
    if (alternative && standIn(alternative) && input.autoRedeem) {
      const banked = withBankedReset(state, input.family, input.usageOf, input.now, reserved);
      if (banked) alternative = banked.id === account.id ? undefined : banked;
    }
    if (alternative) {
      skipped = { account, why };
      account = alternative;
      // A thread that can't move lives where it starts. Otherwise a disabled account keeps its
      // agents' bindings, so they return when it's enabled again; a limit re-pins them, except onto
      // a paid stand-in (Bedrock), which they leave again once a subscription account has room.
      bind =
        !input.portable
          ? { accountId: alternative.id, source: "thread", at }
          : why === "disabled" || standIn(alternative)
            ? null
            : { accountId: alternative.id, source: "auto", at };
    }
  }
  // A brand-new agent that would follow the default onto a nearly full account starts where there's
  // room instead, and stays there. So does a conversation that can change accounts when it opens
  // again (a resume, a reload): the turn-end check never saw an account fill up while the agent sat
  // idle, and its next turn would run that account to its limit. An account chosen for this agent is
  // left alone.
  const opensAgain = !fresh && input.opening === true && input.portable && binding?.source !== "user";
  if (!skipped && (fresh ? !bound : opensAgain) && bind?.source !== "user" && input.autoSwitch && input.early && nearlyFull(input.usageOf(account.id), input.early, input.now).length > 0) {
    const roomy = roomyAccount(state, input.family, input.usageOf, input.early, input.now, new Set([...reserved, account.id]));
    if (roomy) {
      skipped = { account, why: "nearly_full" };
      account = roomy;
      bind = { accountId: roomy.id, source: input.portable ? "auto" : "thread", at };
    }
  }
  return { account, bind, skipped, nextPick };
}

/** The account an agent is routed to right now, without side effects (for display). */
export function effectiveAccountId(state: StoredState, agentId: string, family: Family): string | undefined {
  const bound = findAccount(state, state.bindings[agentId]?.accountId);
  if (bound && bound.family === family) return bound.id;
  return defaultAccount(state, family)?.id;
}
