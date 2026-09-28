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
- **Official CLI Headless Protocol**: This integration connects to Command Code strictly via its official, documented headless NDJSON interface (`cmd -p --output-format json`). It runs locally on your machine with your authenticated credentials. It does **not** scrape web interfaces, use unauthorized third-party proxy routers, or reverse-engineer private backend endpoints.
- **Account Credits & Usage Limits**: T3 Code does not bypass Command Code's billing or credit counters. Every turn consumes your account credits according to your active Command Code plan and model choice.
- **Avoid Aggressive Automated Loops**: Because T3 Code executes turns programmatically, running continuous, unthrottled automation loops or concurrent headless calls may trigger automated fraud, rate-limiting, or abuse-detection systems on Command Code's backend. Use the tool responsibly for interactive pair-programming.
- **Unofficial Fork Disclaimer**: This repository is an independent, community-driven project and is not affiliated with, endorsed by, or sponsored by Command Code (`commandcode.ai`) or Ping Labs (`ping.gg`).

---

## What This Fork Adds

- **Seventh Built-in Provider**: `commandcode` appears alongside Codex, Claude Code, Cursor, Grok Build, OpenCode, and Antigravity in Settings and thread selectors.
- **Streaming NDJSON Turns**: Real-time tool execution progress, file changes, and assistant responses streamed directly from the `cmd` subprocess.
- **Session Continuation**: Transparent multi-turn resumption using `--resume <session-id>`.
- **Dynamic Model Catalog**: Models available on your Command Code account (via `cmd --list-models`) are detected and presented in the model selector.
- **Permission Modes**: Seamless mapping between T3 Code runtime modes and Command Code permission modes (`standard`, `accept-edits`, `plan`, and `yolo`).
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

---

## Keeping Up to Date with Upstream T3 Code

This fork tracks upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code) changes automatically while preserving Command Code modifications:

1. **Automated Daily Sync**: A GitHub Actions workflow ([`.github/workflows/sync-upstream.yml`](./.github/workflows/sync-upstream.yml)) runs every day at 04:00 UTC to fetch and merge `upstream/main` into this repository. If a conflict ever occurs, an issue is automatically opened for maintainer review.
2. **Manual Sync Script**: To sync your local branch with upstream at any time:
   ```bash
   ./scripts/sync-upstream.sh
   ```

---

## License

MIT (inherited from upstream `pingdotgg/t3code`).
