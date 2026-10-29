# ZeroSub

Use several Claude, ChatGPT (Codex), Kimi Code, GitHub Copilot and OpenCode Go subscriptions side by side in [Paseo](https://paseo.sh), without logging in and out of the CLI.

- **Add accounts in the app.** Click **Add account** under Claude, ChatGPT, Kimi Code, Copilot or OpenCode Go and sign in on any device, including your phone. You don't need a terminal, environment variables or config files.
- **Your existing CLI logins show up automatically.** Nothing changes until you add a second account.
- **Pick an account per agent.** An account button in the message box shows which account each Claude or Codex agent uses. Tap it to switch.
- **Automatic failover.** When an account hits its 5-hour or weekly limit, the agent moves to the top of **Up next**, the list on the Accounts screen that puts the account whose spare quota resets soonest first, and carries on. New agents skip exhausted accounts.
- **Accounts per project.** Pick the Paseo projects whose agents use an account (work projects on the work account, say). Agents in other projects stay off it.
- **Switch early.** An agent whose turn ends on a nearly full account moves to one with room before its next turn, so it doesn't stop halfway through a task. New agents skip nearly full accounts too.
- **Live usage.** Each account shows its own 5-hour and weekly usage and when they reset. Accounts in use refresh about every minute and after each turn, and a limit shows up the moment it hits.
- **Banked resets.** If a provider has banked limit resets on an account, you can use one from the account card or the agent's account button.
- **Set an account aside.** Disable an account for a while and its agents move to your other accounts, then come back when you enable it again.
- **Several hosts.** Each Paseo host keeps its own accounts, and the Accounts screen says which host you're looking at.
- **Fork to another provider (optional).** When every account of a provider is out, a stopped chat can carry on with the next provider you have an account for (Claude, then ChatGPT, then Kimi Code, then Copilot, then OpenCode Go).
- **Everything else stays the same.** Every account shares your settings, skills, plugins, MCP servers, `CLAUDE.md`/`AGENTS.md` and conversation history.

## Install

Requirements:

- Paseo 0.9.1 or later, with plugins enabled (**Settings → Plugins → Enable plugins**).
- The `claude` and/or `codex` CLI installed where the daemon runs, the same ones Paseo already uses.

In the app, open **Settings → Plugins**, paste `npm:@kapybara/zerosub` as the plugin source, and install. Or, on the daemon host:

```bash
paseo plugin install npm:@kapybara/zerosub
# or straight from GitHub:
paseo plugin install github:kapybara-org/zerosub
```

Then open **Accounts (ZeroSub)** in the sidebar.

## Use it

1. Open **Accounts (ZeroSub)** in the sidebar. Your current Claude Code and Codex logins are already listed.
2. Click **Add account** under a provider, then **Open sign-in page** (for Kimi Code, Copilot and OpenCode Go, see [Kimi Code](#kimi-code), [GitHub Copilot](#github-copilot) and [OpenCode Go](#opencode-go)), and sign in with the other account.
   - In a browser on the host's own computer, the page finishes by itself.
   - Anywhere else, choose **Use a code instead**. For Claude, paste the code shown after sign-in. For ChatGPT, type the code shown in Paseo on the page. Phones, and hosts without a desktop (servers, containers, daemons started over SSH), start with the code.
3. Choose which account agents use:
   - **Make default**: agents that follow the default use it. New agents start at the top of Up next while **Spread new agents across accounts** is on (the default), and on the default when it's off. Open Claude agents switch right away, busy ones after their turn.
     - To leave open agents where they are, turn off **Move open agents when the default changes** (in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**). Each open agent that follows the default then stays pinned to the account it's using, even after it reopens, unless that account is signed out, disabled or at its limit. Agents that aren't open at the time, and new agents when **Spread new agents across accounts** is off, use the new default.
     - A kept agent still switches when its account hits a limit. To move it to the new default, choose **Follow default** from its account button, or type `/account default`.
   - **The account button in an agent's message box**: moves that one agent.
   - **`/account work`** in the message box, or `/account default` to follow the default again.
   - **⌘K → "Make … the default"**.
   - **Disable for now** (the pause button on a card): the account stays signed in but ZeroSub stops using it. Its agents move to your other accounts right away (busy ones after their turn) and come back when you press **Enable**. ChatGPT conversations already on it stay, since they can't change accounts. You can't disable the last usable account of a provider.
4. Leave **Automatic switching** on (in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**) and limits take care of themselves:
   - Only the CLIs' own limit notices trigger a switch. That covers Claude Code's "You've hit your session limit · resets 3pm" and Codex's "You’ve hit your usage limit…".
   - Paseo 0.13 and later no longer send the finished turn to plugins, so ZeroSub reads that turn from the agent's timeline instead.
   - A short note in the agent's timeline says what happened.
   - As a safety stop, one agent changes accounts at most 4 times in 10 minutes. If it hits that, its timeline says so; pick an account from its account button to carry on.
   - An exhausted account is skipped until it resets. If you know it has room again sooner, for example after upgrading or buying credits, press **Mark as available again** (the check mark) on its card.
5. **Accounts per project**: press **Projects** (the folder button) on an account's card and pick the Paseo projects whose agents should use it.
   - It follows Paseo's own projects, so every workspace and worktree of a project counts, wherever its folder lives.
   - A project has one account per provider. Picking a project that already uses another account moves it here.
   - The project's account comes before the default and before spreading new agents. An account you chose for an agent comes first, and so does the account a limit or switch early moved it to, until that one runs out too.
   - An account picked for some projects is set aside for them: agents in other projects never land on it automatically, unless no other account is left. When a project's account hits a limit, its agents move to an account no other project has.
   - Saving moves the projects' open agents straight away (busy ones after their turn).
6. **Switch early** (under **Before the limit**) moves agents before they hit a limit at all:
   - When an agent's turn ends, ZeroSub reads its account's usage again. If a 5-hour window is at least **80%** used, or a weekly one at least **95%**, the agent moves to the first account in Up next with room to spare before its next turn. Both lines can be set from 50 to 100; 100 turns that kind of window off. Weekly windows get the higher line because one turn barely moves them.
   - It only moves onto an account at least 10 points below every line. A move costs the conversation its prompt cache on the new account, and the margin keeps agents from bouncing between two accounts that are both nearly full. When no account has that much room, the agent stays and the limit failover above takes over.
   - It acts only on a live reading from the last 10 minutes, never a cached or failed one, and leaves a window that refills in the next 10 minutes alone.
   - New agents that would follow the default onto a nearly full account start on one with room instead, and stay there.
   - It leaves an account you chose for an agent alone until that account really runs out. ChatGPT conversations with history can't change accounts, so only new ChatGPT agents are affected.

### Claude vs. ChatGPT when switching mid-conversation

- **Claude:** a conversation moves to another account in place. The agent reopens on the new account with its full history and continues.
- **ChatGPT (Codex):** Codex encrypts its reasoning per ChatGPT account, so another account can't read an existing thread. The thread stays on its account. When it hits a limit, or you pick another account for it, ZeroSub carries the task on in its tab for the other account: a **continuation agent** in the same workspace, created on the first visit and reused after that. Switching A → B → A → B keeps two tabs, not four. Independent tasks keep separate tabs, even in the same workspace.
  - A tab you return to gets the instructions and progress since it was last used, and checks the current files and Git diff before going on. Very long instructions are shortened, keeping the first one since the tab was last used (the original request, for a new tab), the latest ones and a note of how many were left out.
  - You can type in any of a task's tabs and switch from any of them. The tab you used last is where the task continues: automatic switches and resets only move that tab, and another tab that hits a limit says in its timeline where the task went.
  - A tab is reused while it is in the same workspace with the same account and permission mode; otherwise ZeroSub starts a new one. While one of the task's tabs is working or asking for permission, a switch you pick is refused until it stops, and an automatic switch leaves the task where it is and says so in its timeline.
  - ZeroSub never sends a hand-off twice. If a lost connection leaves one unconfirmed, the switch stops and names the tab to check. Continuation agents from earlier versions are picked up on the first switch. New Codex agents simply start on the chosen account.

### Kimi Code

- Install [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) where the daemon runs (the archived Python Kimi CLI isn't supported). Your existing login in `~/.kimi-code` (or `KIMI_CODE_HOME`) shows up as the CLI login.
- **Add account** runs `kimi login` in a home of its own and shows the device-code link and code; approve it on any device. Each account keeps its own sign-in, while sessions, MCP servers, plugins and skills stay shared, so a Kimi conversation moves between accounts in place.
- Usage comes from Kimi Code's own usage service, for the region the login belongs to (kimi.ai or kimi.com): the 5-hour, weekly and monthly windows, including the monthly coding allowance.
- Kimi reports a spent quota and an empty balance with its own wording, and those switch at once. A bare "429" or "rate limit" can also be a passing throttle, so it only counts as a limit when a fresh usage reading shows a full window.

### GitHub Copilot

- Uses [Copilot CLI](https://github.com/github/copilot-cli) where the daemon runs. Each account is a GitHub user; its home (`COPILOT_HOME`) keeps `config.json`, which names that user, and its session index. Session events, settings, plugins and MCP config stay shared, so a Copilot conversation moves between accounts in place.
- **Add account** runs `copilot login --device-code` and shows GitHub's device link and code. Copilot keeps the sign-in in the system credential store under the GitHub user's name; ZeroSub only checks the entry exists and never reads the token, so nothing asks for keychain permission.
- `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` override any stored sign-in, so agents on added accounts run without them. Agents on your CLI login keep them.
- Usage is the monthly allowance (premium requests, or chat and completions on the free plan) from Copilot CLI's own cache of each user's quota, so it is as fresh as that user's last Copilot session, and switch early doesn't act on it. A spent allowance or a weekly rate limit switches accounts; a short rate limit doesn't.
- Removing an account deletes its stored sign-in only when no other home signs in as the same GitHub user.

### OpenCode Go

- An account is an [OpenCode Go](https://opencode.ai/v2/docs/console/go/) API key. **Add account** opens the OpenCode Console; paste the API key of the workspace with the Go plan. ZeroSub checks it with OpenCode before keeping it in the account's folder.
- Each agent's OpenCode session gets its account's key as `OPENCODE_API_KEY`, and Paseo runs a separate OpenCode server for it. Chats stay in OpenCode's one database, so they move between accounts in place.
- OpenCode uses a Go key saved in OpenCode itself before the one ZeroSub passes in. Your CLI login is that saved key; to let ZeroSub pick the Go account per agent, add the key here as an account too and disconnect OpenCode Go in OpenCode (`/connect`). ZeroSub says so while both exist.
- The `opencode` provider also runs other providers' models. Only turns on `opencode-go/…` models count towards a Go account's limits.
- OpenCode Go shows usage only in the OpenCode Console, so cards show no usage and switch early doesn't apply. A turn that ends on OpenCode's usage-limit message switches accounts; a bare rate limit doesn't.

### Banked resets

Some plans come with banked limit resets: ChatGPT's reset credits, and Claude Code's limit resets. When an account has any, its card shows how many are banked and when they expire, with a **Use reset** button. When an agent is stopped by a limit, its account button offers the reset too, and the agent carries on afterwards.

- A reset can't be undone, so ZeroSub always asks first and says what it refills.
- **ChatGPT** uses Codex's own reset-credit API, the same one as `/usage` → reset in the Codex CLI. It never spends a credit while nothing is used up.
- **Claude** uses Claude Code's limit-reset endpoint. Anthropic decides which accounts get resets; so far it reports the tested accounts as not eligible, so the button may not appear for Claude. It shows up by itself once an account has a reset.
- **Use banked resets when every account is out** (off by default) spends one automatically, but only when every account of that provider is at its limit and the provider confirms the limit at that moment.

### When every account of a provider is out

ZeroSub tries these in order, and a timeline note says which one happened:

1. **Use a banked reset**, if you turned on **Use banked resets when every account is out**.
2. **Fork the chat to another provider**, if you turned on **When every account is out, fork the chat to another provider** (off by default). A stopped chat continues in a new agent on the first provider, in the order Claude, ChatGPT, Kimi Code, Copilot, OpenCode Go, that you have an account for, that Paseo can run here, and that has an account with room:
   - The new agent opens in the same workspace with the conversation so far and goes straight back to work. If that conversation began as a hand-off itself, only the start and end of the earlier one are quoted. It uses the other provider's default model (for OpenCode Go, an `opencode-go/…` model, and OpenCode Go is skipped when OpenCode lists none) and its account whose spare quota resets soonest.
   - Its permission mode matches the original's level. Bypass becomes Full Access, and Accept File Edits becomes Default Permissions. Codex has no read-only or ask-first mode, so a Claude agent in Plan Mode or Always Ask isn't forked. ZeroSub never gives a fork more freedom than you gave the original.
   - The original agent stays as it was, and prompting it again while its provider is still out points to the same fork rather than starting another.
   - With the option off, a stopped agent's account button offers **Continue on ChatGPT (new agent)…** (or Claude) instead, with a confirmation.
3. **Stop and say so**, with the time the account frees up.

## Several hosts

Paseo installs plugins per host (daemon), so install ZeroSub on each host whose agents should use it. When more than one host has it, Paseo shows a single **Accounts (ZeroSub)** item with a host picker at the top.

- **Each host has its own accounts, default and preferences**, because the sign-ins live on the machine where the agents run. The Accounts screen and the sign-in dialog name the host they belong to.
- **An agent's account button always belongs to the agent's host**, and its **Manage accounts…** opens that host.
- **Sign the same account in on each host.** ZeroSub never copies sign-ins between hosts. Both providers rotate sign-in tokens, so two machines sharing one token sign each other out. Separate sign-ins of the same account work fine. Limits are per account, so every host sees the combined usage and switches when it runs out.
- **Remote hosts:** phones, and hosts without a desktop, get the code sign-in automatically. For a remote computer that does have a desktop, choose **Use a code instead** unless you're sitting at it.
- **Banked resets refill the account everywhere.** Automatic use re-checks the limit with the provider first, so two hosts can't spend two resets on the same limit.

## How it works

Each added account gets its own credential home under `$PASEO_HOME/zerosub/homes/`:

- Claude uses it as `CLAUDE_CONFIG_DIR`; Codex uses it as `CODEX_HOME`.
- The CLIs keep each home's login separate: Claude in its own keychain entry (`.credentials.json` on Linux), Codex in its own `auth.json`.
- Everything that isn't account-specific is a symlink back to `~/.claude` or `~/.codex`. For Claude that includes `settings.json`, `skills/`, `plugins/` and `projects/`; for Codex, `config.toml`, `sessions/` and more. Codex also shares its thread database through `CODEX_SQLITE_HOME`.
- Claude's `.claude.json` holds the account identity, so each account keeps its own copy. It's seeded from yours, and your MCP servers stay in sync.

A `before("agent.session_open")` hook sets those variables for every session Paseo opens: create, resume, refresh and import. To move a live agent, ZeroSub reopens its session with `paseo agent reload`. It never interrupts a running turn; a busy agent moves when its turn ends.

Sign-in runs the official CLIs:

- Claude: `claude auth login`.
- Codex: `codex app-server`'s account API.

ZeroSub never implements OAuth itself and never copies credentials between accounts.

## Privacy and security

- Credentials stay in the CLIs' own stores. ZeroSub's registry (`$PASEO_HOME/zerosub/state.json`) holds account names, emails, plans, which agent uses which account, which Paseo projects use which account, and continuation links with timeline positions. Handoff text stays in the agents' conversation histories; it isn't copied into the registry.
- To show Claude usage, ZeroSub reads each account's current access token and calls Anthropic's usage endpoint, the same way Paseo's built-in usage display and `/usage` do. It never logs or stores tokens and never refreshes them itself. When you refresh usage (the ↻ button beside the title) or use a reset and a token has expired, it runs `claude -p /usage` so Claude Code renews its own sign-in. Codex usage comes from `codex app-server`.
- Using a banked reset calls the provider's own reset endpoint with that account's sign-in, and only after you confirm (or turn on automatic use).
- Removing an account moves its agents to the default account, then signs it out (`claude auth logout` / `codex` logout) and deletes its home. This happens once no agent is mid-turn on it. Abandoned sign-ins are cleaned up the same way.
- An account that still has ChatGPT conversations on it can't be removed until you archive them or continue them elsewhere, because they can't move.
- Your CLI login can't be removed from ZeroSub.

## Limitations

- **MCP servers that use OAuth** (Linear, Notion, …) store their tokens per Claude account, so sign in to them once on each account.
- **Shared settings apply to every account.** If `~/.claude/settings.json` sets an `apiKeyHelper` or API-key `env`, every account uses that key instead of its subscription.
- **Usage for an idle Claude account** shows the last reading until the account is used again or you refresh usage. Anthropic rate-limits its usage endpoint (Claude Code and Paseo read it too), so a reading can be a few minutes old; the card then says when it was taken. Readings are saved in `$PASEO_HOME/zerosub/usage.json`, so they survive restarts.
- **Password-protected daemons:** `paseo agent reload` can't authenticate. Agents then switch the next time their session starts, not immediately, and their timeline note says so.
- **Imported Codex threads** (`paseo agent import`) are assigned to your CLI login, since that's where standalone Codex sessions come from.
- **ChatGPT device-code sign-in** has to be enabled in ChatGPT → Settings → Security. The browser option works from a browser on the host's own computer.
- Tested on macOS with Claude Code 2.1.280, Codex 0.156.1 and Paseo 0.9.1. Linux should work. Windows is untested.

## Development

```bash
git clone https://github.com/kapybara-org/zerosub.git
cd zerosub
npm install
paseo plugin install "$(pwd)"   # run the working copy

npm run typecheck      # client and server bundles, separately
npm test               # routing, projects, failover, limit detection, usage, resets, forks
npm run audit:mobile   # no DOM/HTML in client code
paseo plugin reload zerosub
paseo plugin logs zerosub
```

Code layout:

- `client/`: React Native UI (Accounts surface, sign-in modal, composer pill, commands, timeline note).
- `server/`: routing, account homes, Claude and Codex adapters, failover.
- `shared/`: RPC contracts and the view model.
- `bin/zerosub-claude`: runs `claude` on the account ZeroSub would give a new agent, for tools Paseo doesn't launch.

Report problems at [github.com/kapybara-org/ZeroSub/issues](https://github.com/kapybara-org/ZeroSub/issues).

## Uninstall

Remove added accounts from **Accounts** first, so they're signed out. Then run:

```bash
paseo plugin remove zerosub
rm -rf ~/.paseo/zerosub
```
