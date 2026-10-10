# Command Code for T3 Code (`commandcode-t3`)

This repository is a lightweight, tracking fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT) that adds **Command Code** (CLI binary `cmd`, [commandcode.ai](https://commandcode.ai)) as a first-class, built-in agent provider.

Because upstream T3 Code is not accepting new third-party provider integrations, this fork maintains full Command Code integration while staying continuously in sync with upstream T3 Code updates.

---

## ⚡ Quick Start: One-Line Install

Install T3 Code with built-in Command Code support with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/abhigyan-chatterjee/commandcode-t3/main/scripts/install.sh | bash
```

Once installed, run:

```bash
t3
```

This starts the server and opens the local T3 Code GUI in your default browser.

> **Prerequisites:**
>
> 1. [Node.js](https://nodejs.org) (v24+ recommended, v22.16+ minimum)
> 2. [Command Code CLI](https://commandcode.ai/docs): `npm i -g command-code && cmd login`

---

## ⚠️ Important: Command Code Terms of Service & Account Risks

Before using Command Code with T3 Code, please review Command Code's [Terms of Service and Acceptable Use Policies](https://commandcode.ai):

- **Strict One-Account Rule**: Command Code's terms explicitly restrict each user to **one account**. Operating or controlling multiple accounts to circumvent plan limits, free credits, or rate limits is considered a material violation. Doing so can result in an **immediate, permanent, and irrevocable lifetime ban** across all associated accounts without refund.
- **Official ACP Protocol**: Agent turns run over Command Code's official, documented [Agent Client Protocol](https://commandcode.ai/docs/acp) server (`cmd acp`). One-shot metadata (thread titles, commit messages, PR text) uses the documented headless interface (`cmd -p --output-format json`). Everything runs locally on your machine with your authenticated credentials. It does **not** scrape web interfaces, use unauthorized third-party proxy routers, or reverse-engineer private backend endpoints.
- **Account Credits & Usage Limits**: T3 Code does not bypass Command Code's billing or credit counters. Every turn consumes your account credits according to your active Command Code plan and model choice.
- **Avoid Aggressive Automated Loops**: Because T3 Code executes turns programmatically, running continuous, unthrottled automation loops or concurrent headless calls may trigger automated fraud, rate-limiting, or abuse-detection systems on Command Code's backend. Use the tool responsibly for interactive pair-programming.
- **Unofficial Fork Disclaimer**: This repository is an independent, community-driven project and is not affiliated with, endorsed by, or sponsored by Command Code (`commandcode.ai`) or Ping Labs (`ping.gg`).

---

## What This Fork Adds

- **Built-in Provider**: `commandcode` appears alongside Codex, Claude Code, Cursor, Grok Build, OpenCode, Antigravity, and Pi in Settings and thread selectors.
- **Streaming Turns over ACP**: Real-time tool calls, diffs, plans, and assistant text stream from the `cmd acp` Agent Client Protocol server.
- **Session Continuation**: Every thread is a real Command Code session; reopening a thread replays and continues the same transcript that `cmd --resume` lists.
- **Dynamic Model Catalog**: The Command Code model catalog (with per-model reasoning effort) is exposed in the model selector and is scoped to the thread.
- **Permission Modes**: Seamless mapping between T3 Code runtime modes and Command Code ACP session modes (`default`, `auto-accept`, `plan`, `dont-ask`, `bypass`), with interactive allow/reject prompts.
- **Context Compaction**: Native `/compact` support mapped to thread compaction.
- **Text Generation**: Generates thread titles, commit messages, PR descriptions, and branch names using one-shot headless queries.

---

## Installing & Developing from Source

If you prefer building and installing directly from a local clone:

```bash
# 1. Clone the repository
git clone https://github.com/abhigyan-chatterjee/commandcode-t3.git
cd commandcode-t3

# 2. Install dependencies (requires global `vp` / Vite+)
npm install -g vite-plus

vp i

# 3. Build and install into ~/.t3 and ~/.local/bin/t3
./scripts/install-local.sh

# 4. Or run the dev server without installing
vp run dev
```

## Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

---

## Keeping Up to Date with Upstream T3 Code

This fork tracks upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code) changes automatically while preserving Command Code modifications:

1. **Manual Sync**: The GitHub Actions workflow ([`.github/workflows/sync-upstream.yml`](./.github/workflows/sync-upstream.yml)) is run on demand from the Actions tab (scheduled autobuilds are intentionally disabled on this fork) to fetch and merge `upstream/main`. A merge conflict fails the run rather than opening an issue; resolve it locally with the script below.
2. **Manual Sync Script**: To sync your local branch with upstream at any time:
   ```bash
   ./scripts/sync-upstream.sh
   ```

---

## License

MIT (inherited from upstream `pingdotgg/t3code`).
