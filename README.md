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

- **Built-in Provider**: `commandcode` appears alongside Codex, Claude Code, Cursor, Grok Build, OpenCode, Antigravity, Muse Code, and Pi in Settings and thread selectors.
- **Streaming Turns over ACP**: Real-time tool calls, diffs, plans, and assistant text stream from the `cmd acp` Agent Client Protocol server.
- **Session Continuation**: Every thread is a real Command Code session; reopening a thread replays and continues the same transcript that `cmd --resume` lists.
- **Dynamic Model Catalog**: The Command Code model catalog (with per-model reasoning effort) is exposed in the model selector and is scoped to the thread.
- **Permission Modes**: Seamless mapping between T3 Code runtime modes and Command Code ACP session modes (`default`, `auto-accept`, `plan`, `bypass`), with interactive allow/reject prompts.
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

This fork publishes its own Linux builds. Download the AppImage or `.deb` from [this fork's GitHub Releases](https://github.com/abhigyan-chatterjee/commandcode-t3/releases): every push to `main` cuts a new version, and an installed app updates itself over the air from those releases.

#### Linux (AppImage)

Take `T3-Code-<version>-x86_64.AppImage` from the [latest release](https://github.com/abhigyan-chatterjee/commandcode-t3/releases/latest), then:

```bash
chmod +x T3-Code-*-x86_64.AppImage
./T3-Code-*-x86_64.AppImage
```
#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [this fork's releases](https://github.com/abhigyan-chatterjee/commandcode-t3/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```


The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

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

## License

MIT (inherited from upstream `pingdotgg/t3code`).
