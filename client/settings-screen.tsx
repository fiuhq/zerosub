import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { FALLBACK_ORDER, familyPhrase } from "../shared/model";
import { DEFAULT_CONTINUE_PROMPT, preferences, type Preferences } from "../shared/preferences";

/** Settings → Plugins → zerosub. Accounts themselves live in the sidebar surface. */
export function PreferencesScreen({ theme, host, onOpenAccounts }: PluginSurfaceProps & { onOpenAccounts(): void }) {
  const settings = useSettings(preferences);
  const multiHost = useHosts().length > 1;
  const [prompt, setPrompt] = useState<string | null>(null);
  const [earlyAt, setEarlyAt] = useState<string | null>(null);
  const [earlyWeeklyAt, setEarlyWeeklyAt] = useState<string | null>(null);
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status === "loading") return <Text style={muted}>Loading…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Preferences">
        <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void settings.reload()} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
        ) : null}
      </SettingsSection>
    );
  }
  const save = (patch: Partial<Preferences>) =>
    void settings.save({ ...settings.values, ...patch }, settings.revision);
  return (
    <>
      {multiHost ? (
        <Text style={muted}>These apply to agents on {host.label}. Each host keeps its own accounts and preferences.</Text>
      ) : null}
      <SettingsSection title="Accounts">
        <SettingsCard>
          <SettingsAction
            label="Add, remove, and choose default accounts"
            actionLabel="Open accounts"
            onPress={onOpenAccounts}
          />
          <SettingsSwitch
            label="Move open agents when the default changes"
            hint="Off: open agents stay on the account they're using, even after they reopen. New agents, and agents that aren't open at the time, use the new default."
            value={settings.values.moveAgentsOnDefaultChange}
            disabled={settings.saving}
            onValueChange={(moveAgentsOnDefaultChange) => save({ moveAgentsOnDefaultChange })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Automatic switching">
        <SettingsCard>
          <SettingsSwitch
            label="Switch accounts when one hits its limit"
            hint="The agent moves to the first account in Up next with room to spare: spare quota that resets soonest goes first."
            value={settings.values.autoSwitch}
            disabled={settings.saving}
            onValueChange={(autoSwitch) => save({ autoSwitch })}
          />
          <SettingsSwitch
            label="Keep going after a switch"
            hint="Sends the follow-up below so the interrupted task continues."
            value={settings.values.autoContinue}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoContinue) => save({ autoContinue })}
          />
          <SettingsInput
            label="Follow-up message"
            initialValue={settings.values.continuePrompt}
            onChangeText={setPrompt}
            disabled={settings.saving || !settings.values.autoContinue}
            error={settings.saveError}
          />
          <SettingsAction
            label="Save the follow-up message"
            actionLabel="Save"
            disabled={settings.saving || prompt === null || !prompt.trim()}
            onPress={() => {
              if (prompt?.trim()) save({ continuePrompt: prompt.trim() });
            }}
          />
          <SettingsAction
            label="Restore the default follow-up"
            actionLabel="Restore"
            disabled={settings.saving || settings.values.continuePrompt === DEFAULT_CONTINUE_PROMPT}
            onPress={() => save({ continuePrompt: DEFAULT_CONTINUE_PROMPT })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Before the limit">
        <SettingsCard>
          <PercentSetting
            label="Switch early at, 5-hour limit (% used)"
            hint="When an agent's turn ends on an account at least this full, it moves to an account with room before its next turn, instead of stopping halfway through a task. New agents skip that account too. 50 to 99; 100 turns it off."
            value={settings.values.switchEarlyAt}
            draft={earlyAt}
            onDraft={setEarlyAt}
            disabled={settings.saving || !settings.values.autoSwitch}
            onSave={(switchEarlyAt) => save({ switchEarlyAt })}
          />
          <PercentSetting
            label="Switch early at, weekly limit (% used)"
            hint="The same for weekly limits. One turn barely moves them, so this can sit closer to 100."
            value={settings.values.switchEarlyWeeklyAt}
            draft={earlyWeeklyAt}
            onDraft={setEarlyWeeklyAt}
            disabled={settings.saving || !settings.values.autoSwitch}
            onSave={(switchEarlyWeeklyAt) => save({ switchEarlyWeeklyAt })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="New agents and composer">
        <SettingsCard>
          <SettingsSwitch
            label="Spread new agents across accounts"
            hint="New agents start at the top of Up next instead of on the default."
            value={settings.values.balanceNewAgents}
            disabled={settings.saving}
            onValueChange={(balanceNewAgents) => save({ balanceNewAgents })}
          />
          <SettingsSwitch
            label="Use banked resets when every account is out"
            hint="Spends one of the account's banked resets instead of stopping. Off unless you turn it on: resets are scarce."
            value={settings.values.autoRedeem}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoRedeem) => save({ autoRedeem })}
          />
          <SettingsSwitch
            label="When every account is out, fork the chat to another provider"
            hint={`A stopped chat carries on in a new agent on the next provider you have an account for (${familyPhrase(FALLBACK_ORDER, "then")}), with the conversation so far and no more permissions than the original. The original stays as it was.`}
            value={settings.values.forkOtherProvider}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(forkOtherProvider) => save({ forkOtherProvider })}
          />
          <SettingsSwitch
            label="Show the account pill in the composer"
            hint="Appears on Claude and Codex agents once a provider has two or more accounts."
            value={settings.values.showComposerPill}
            disabled={settings.saving}
            onValueChange={(showComposerPill) => save({ showComposerPill })}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

/** A whole-number percent from 50 to 100, saved with its own button. */
function PercentSetting(props: {
  label: string;
  hint: string;
  value: number;
  draft: string | null;
  onDraft(text: string): void;
  disabled: boolean;
  onSave(value: number): void;
}) {
  const valid = props.draft !== null && /^\d+$/.test(props.draft.trim()) && Number(props.draft) >= 50 && Number(props.draft) <= 100;
  return (
    <>
      <SettingsInput
        label={props.label}
        hint={props.hint}
        initialValue={String(props.value)}
        onChangeText={props.onDraft}
        disabled={props.disabled}
        error={props.draft !== null && !valid ? "Enter a whole number from 50 to 100." : undefined}
      />
      <SettingsAction
        label="Save"
        actionLabel="Save"
        disabled={props.disabled || !valid || Number(props.draft) === props.value}
        onPress={() => props.onSave(Number(props.draft))}
      />
    </>
  );
}
