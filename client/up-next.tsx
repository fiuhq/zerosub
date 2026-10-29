import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { formatResetIn } from "../shared/format";
import type { AccountView } from "../shared/model";
import { preferences } from "../shared/preferences";
import { compareUpNext, upNextRank, type UpNextLines, type UpNextRank } from "../shared/up-next";
import { Badge, Card, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/** The lines the router ranks with: switch early's, or the defaults while it's off. */
export function useUpNextLines(): UpNextLines | undefined {
  const settings = useSettings(preferences);
  if (settings.status !== "ready") return undefined;
  const { autoSwitch, switchEarlyAt, switchEarlyWeeklyAt } = settings.values;
  return autoSwitch && (switchEarlyAt < 100 || switchEarlyWeeklyAt < 100) ? { short: switchEarlyAt, long: switchEarlyWeeklyAt } : undefined;
}

const usable = (account: AccountView) => account.status === "ready" || account.status === "checking";

/**
 * The family's accounts in the order agents are given them (server/routing.ts `mostAvailable`):
 * Up next first, then the default, then the CLI login; accounts nothing is routed to come last.
 */
export function upNextOrder(accounts: AccountView[], now: number, lines?: UpNextLines): { account: AccountView; rank: UpNextRank }[] {
  const ranked = accounts.map((account) => ({ account, rank: upNextRank(account.usage, now, lines) }));
  const open = ranked
    .filter(({ account }) => usable(account))
    .sort(
      (a, b) =>
        compareUpNext(a.rank, b.rank) ||
        Number(b.account.isDefault) - Number(a.account.isDefault) ||
        Number(b.account.kind === "main") - Number(a.account.kind === "main"),
    );
  return [...open, ...ranked.filter(({ account }) => !usable(account))];
}

function detail(account: AccountView, rank: UpNextRank, now: number): string {
  if (account.status === "limited") {
    const back = formatResetIn(account.limitedUntil, now);
    return back ? `Limit reached · back ${back}` : "Limit reached";
  }
  if (account.status === "disabled") return "Disabled for now";
  if (account.status === "signed_out") return "Signed out";
  if (!rank.limit) return "No usage reading yet";
  const left = Math.max(0, Math.round(100 - rank.limit.usedPercent));
  const reset = formatResetIn(rank.limit.resetsAt, now);
  const parts = [`${left}% of ${rank.limit.label.toLowerCase()} left`, reset ? `resets ${reset}` : null, `${rank.perHour}% an hour goes unused`];
  return parts.filter(Boolean).join(" · ");
}

function badge(account: AccountView, rank: UpNextRank, first: boolean): { label: string; tone: "accent" | "success" | "warning" | "danger" | "muted" } {
  if (account.status === "limited") return { label: "Out", tone: "danger" };
  if (!usable(account)) return { label: account.status === "disabled" ? "Disabled" : "Signed out", tone: "muted" };
  if (first) return { label: "Agents go here", tone: "accent" };
  return rank.tier === 2 ? { label: "Nearly full", tone: "warning" } : { label: "Ready", tone: "success" };
}

export function UpNext({ theme, accounts }: { theme: Theme; accounts: AccountView[] }) {
  const text = useText(theme);
  const lines = useUpNextLines();
  if (accounts.length < 2) return null;
  const now = Date.now();
  const order = upNextOrder(accounts, now, lines);
  return (
    <Card theme={theme}>
      <View accessibilityLabel="Up next" style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", columnGap: 8 }}>
          <Text style={text.strong} accessibilityRole="header">
            Up next
          </Text>
          <Text style={text.small}>Spare quota that resets soonest goes first; the default breaks ties</Text>
        </View>
        {order.map(({ account, rank }, index) => {
          const tag = badge(account, rank, index === 0 && usable(account));
          return (
            <View
              key={account.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingTop: index ? 8 : 0,
                borderTopWidth: index ? 1 : 0,
                borderColor: theme.colors.border,
              }}
            >
              <Text style={{ ...text.small, width: 18, fontWeight: "600" }}>{usable(account) ? index + 1 : "–"}</Text>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={text.strong} numberOfLines={1}>
                  {account.label}
                  {account.isDefault ? <Text style={text.small}> · default</Text> : null}
                </Text>
                <Text style={text.small}>{detail(account, rank, now)}</Text>
              </View>
              <Badge theme={theme} label={tag.label} tone={tag.tone} />
            </View>
          );
        })}
      </View>
    </Card>
  );
}
