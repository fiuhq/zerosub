import type { Family, Usage, UsageWindow } from "../shared/model";
import { compareUpNext, isLongWindow, upNextRank } from "../shared/up-next";
import {
  accountsOf,
  defaultAccount,
  findAccount,
  mainAccount,
  type Binding,
  type StoredAccount,
  type StoredState,
} from "./state";

export function isLimited(account: StoredAccount, now: number): boolean {
  if (!account.limitedUntil) return false;
  const until = Date.parse(account.limitedUntil);
  return Number.isFinite(until) && until > now;
}

export function isUsable(account: StoredAccount, now: number): boolean {
  return account.signedIn && !account.disabled && !isLimited(account, now);
}

/** The usable account first in Up next, preferring the default, then the CLI login, on ties. */
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
    (account) => !exclude.has(account.id) && isUsable(account, now),
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
}

export interface RouteDecision {
  account: StoredAccount;
  /** A binding to persist so the agent stays where it was routed. */
  bind: Binding | null;
  /** Why the preferred account was skipped, if it was. */
  skipped: { account: StoredAccount; why: "limited" | "signed_out" | "disabled" | "nearly_full" } | null;
}

/**
 * Which account a session opens on: the agent's own binding, else (for balanced new agents) the
 * roomiest account, else the default. An exhausted or signed-out choice is swapped for the roomiest
 * usable account when automatic switching is on — for new agents always, and for existing ones
 * only when their conversation can move between accounts. A disabled choice is always swapped,
 * and the agent keeps its own binding so it returns once the account is enabled again.
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

  // The project's account comes before the default and before spreading, but not before an account
  // chosen for this agent or one a limit or switch early moved it to, nor a thread that can't move.
  const dedicated = projectAccount(state, input.family, input.projectId);
  if (dedicated && (!account || (binding?.source === "balance" && (input.portable || fresh)))) {
    account = dedicated;
    if (!input.portable && bound?.id !== dedicated.id) bind = { accountId: dedicated.id, source: "thread", at };
  }
  if (!account && fresh && input.balanceNewAgents && accounts.length > 1) {
    account = mostAvailable(state, input.family, input.usageOf, input.now, reserved, input.early);
    if (account) bind = { accountId: account.id, source: "balance", at };
  }
  if (!account) {
    // An imported Codex thread most likely came from the user's own CLI, so it belongs to that login.
    const imported = !input.portable && input.reason === "import" ? mainAccount(state, input.family) : undefined;
    account = imported ?? defaultAccount(state, input.family);
    // A default set aside for another project yields to a shared account, when there is one.
    // It keeps an agent on the shared account it already runs on, so shifting usage doesn't move it.
    if (account && !imported && reserved.has(account.id)) {
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
    const alternative = mostAvailable(state, input.family, input.usageOf, input.now, new Set([...reserved, account.id]), input.early);
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
  return { account, bind, skipped };
}

/** The account an agent is routed to right now, without side effects (for display). */
export function effectiveAccountId(state: StoredState, agentId: string, family: Family): string | undefined {
  const bound = findAccount(state, state.bindings[agentId]?.accountId);
  if (bound && bound.family === family) return bound.id;
  return defaultAccount(state, family)?.id;
}
