import { accountPeak } from "../shared/format";
import type { Family, Usage, UsageWindow } from "../shared/model";
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
const FIVE_HOUR_GATE_PERCENT = 80;

export function isLimited(account: StoredAccount, now: number): boolean {
  if (!account.limitedUntil) return false;
  const until = Date.parse(account.limitedUntil);
  return Number.isFinite(until) && until > now;
}

export function isUsable(account: StoredAccount, now: number): boolean {
  return account.signedIn && !account.disabled && !isLimited(account, now);
}

/**
 * Routing may put agents on this account by itself: it's usable and not billed per use. No Pi
 * account is ever picked that way: an added one is an API key, and Pi's own login may be one too,
 * so moving work onto either would move it onto a bill nobody chose.
 */
export function canStandIn(account: StoredAccount, now: number): boolean {
  return account.family !== "pi" && account.auth !== "api" && isUsable(account, now);
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
function fiveHourWindow(usage: Usage): UsageWindow | undefined {
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

/**
 * The usable account first in Up next, preferring the default, then the CLI login, on ties. Up next
 * puts an account at its short (5-hour) switch line, 80% by default, behind every account under it,
 * as `fiveHourGated` does, and one with a full window that caps it last.
 */
export function mostAvailable(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
  lines: EarlyLines | null = null,
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const candidates = accountsOf(state, family).filter(
    (account) => !exclude.has(account.id) && canStandIn(account, now),
  );
  const ranks = new Map(candidates.map((account) => [account.id, upNextRank(usageOf(account.id), now, lines ?? undefined)]));
  const rank = (account: StoredAccount) => [
    account.id === preferred ? 0 : 1,
    account.kind === "main" ? 0 : 1,
    Date.parse(account.createdAt) || 0,
  ];
  candidates.sort((a, b) => {
    const order = compareUpNext(ranks.get(a.id)!, ranks.get(b.id)!);
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

/** Prefer a weekly reset within a day only when every usable account has fresh, complete usage. Accounts in `exclude` are never picked. */
function soonestWeeklyReset(state: StoredState, family: Family, usageOf: RouteInput["usageOf"], now: number, exclude: ReadonlySet<string> = new Set()): StoredAccount | undefined {
  const candidates = accountsOf(state, family).filter((account) => isUsable(account, now) && !exclude.has(account.id));
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
  /** Switch early: keep brand-new agents off nearly full accounts. Null when it's off. */
  early?: EarlyLines | null;
  /** The Paseo project of the agent's workspace, when known. */
  projectId?: string | null;
  /**
   * The account the agent's session runs on now. When the account it's routed to has to be skipped
   * and this one can stand in, the agent stays on it rather than following whichever account ranks
   * first at the moment, which would move it again each time two accounts swap places.
   */
  current?: string;
  /**
   * Whether this session may take the one-time "next new agent" pick: one the user's own agents
   * open, not Paseo's helpers (see `takesNextPick` in service.ts). Only a new agent takes it.
   */
  allowNextPick?: boolean;
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
 * Which account a session opens on: the agent's own binding, else (for balanced new agents) the
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

  const binding = state.bindings[input.agentId];
  const bound = findAccount(state, binding?.accountId);
  let account = bound && bound.family === input.family ? bound : undefined;
  let bind: Binding | null = null;
  const reserved = reservedElsewhere(state, input.projectId);

  // A pick whose account can't take the agent (at its limit, signed out, disabled, removed) is spent
  // all the same, and the agent routes as usual: kept, it would send every new agent to whichever
  // account stands in for its own until it expires.
  const nextPick = !account && fresh && input.allowNextPick ? (state.nextAgent?.[input.family] ?? undefined) : undefined;
  if (nextPick && Date.parse(nextPick.until) > input.now) {
    const picked = findAccount(state, nextPick.accountId);
    if (picked?.family === input.family && picked.signedIn && !picked.disabled && !(input.autoSwitch && isLimited(picked, input.now))) {
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
    account = nearReset ?? mostAvailable(state, input.family, input.usageOf, input.now, kept, input.early);
    if (account) bind = { accountId: account.id, source: "balance", at, selectionReason: nearReset ? "weekly_reset" : "headroom" };
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
      const stays = running && running.family === input.family && isUsable(running, input.now) && !reserved.has(running.id);
      account = (stays ? running : mostAvailable(state, input.family, input.usageOf, input.now, reserved, input.early)) ?? account;
    }
    // A thread that can't move is pinned to the account it first opened on.
    if (account && !input.portable) bind = { accountId: account.id, source: "thread", at };
  }
  if (!account) return null;

  let skipped: RouteDecision["skipped"] = null;
  const why = !account.signedIn ? "signed_out" : account.disabled ? "disabled" : isLimited(account, input.now) ? "limited" : null;
  const mayMove = fresh || input.portable;
  if (why && mayMove && (input.autoSwitch || why !== "limited")) {
    const staying = findAccount(state, input.current);
    const alternative =
      staying && staying.family === input.family && staying.id !== account.id && isUsable(staying, input.now) && !reserved.has(staying.id)
        ? staying
        : mostAvailable(state, input.family, input.usageOf, input.now, new Set([...reserved, account.id]), input.early);
    if (alternative) {
      skipped = { account, why };
      account = alternative;
      // A thread that can't move lives where it starts. Otherwise a disabled account keeps its
      // agents' bindings, so they return when it's enabled again; a limit re-pins them.
      bind =
        !input.portable
          ? { accountId: alternative.id, source: "thread", at }
          : why === "disabled"
            ? null
            : { accountId: alternative.id, source: "auto", at };
    }
  }
  // A brand-new agent that would follow the default onto a nearly full account starts where there's
  // room instead, and stays there. An account chosen for this agent is left alone.
  if (!skipped && fresh && !bound && input.autoSwitch && input.early && nearlyFull(input.usageOf(account.id), input.early, input.now).length > 0) {
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
