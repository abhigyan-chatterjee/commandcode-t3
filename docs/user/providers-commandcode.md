# Command Code

Command Code (`cmd`) runs as an [Agent Client Protocol](https://agentclientprotocol.com)
server. T3 Code starts `cmd acp`, opens a session for the thread's project
directory, and speaks ACP over stdio. The whole Command Code harness — tools,
skills, the permission engine, sessions, and the model catalog — stays in
Command Code; T3 Code owns the transport and the timeline. Like Cursor, Grok,
and Pi it is off by default: enable it in **Settings → Providers**.
[Provider setup](./install.md#providers) covers installation, Settings >
Providers, and custom binaries.

## Permissions

Command Code answers T3 Code's permission requests through ACP, so prompts are
interactive: allow once, allow always, reject once, or reject always. An
"always" choice is remembered per tool for the thread.

The thread's runtime mode selects the Command Code session mode:

| Thread runtime mode | Command Code session mode |
| ------------------- | ------------------------- |
| Approval required   | `default`                 |
| Auto-accept edits   | `auto-accept`             |
| Auto                | `auto-accept`             |
| Full access         | `bypass`                  |

Plan mode switches the session to `plan`; the mode indicator follows the engine.

## Sessions and history

Every thread is a real Command Code session with a durable id, so a thread
reopened in T3 Code resumes the same transcript shown by `cmd --resume`, and a
session started in the terminal reopens in T3 Code. T3 Code starts `cmd acp` in
the thread's project directory.

## Multiple accounts

Add another provider instance in **Settings → Providers → Add provider** for a
second configuration. Command Code keeps its login on the machine, so instances
that share a home directory share one account; give the extra instance its own
`HOME` (an environment variable on the instance) when you need a separate login,
then run `cmd login` for it. Command Code's terms restrict each person to one
account, so check them first.

## Models and effort

The picker lists the Command Code model catalog. The choice belongs to the
thread and never changes another thread or your terminal default. Models with a
reasoning knob also expose an effort option.

## MCP servers

Servers you configure in Command Code (`cmd mcp`, `.mcp.json`, settings
`mcp.servers`) load as in the terminal. Servers configured in T3 Code are
connected beside them, and the model sees one tool list.

## Slash commands

Your project and user commands (`.commandcode/commands/*.md`), skills, mod
commands, and `/compact` are available. A command sent as the whole message runs
it; a skill's body rides into the turn as hidden context.

## Updating Command Code

Command Code upgrades itself: run `cmd update` in a terminal, or reinstall it
with `npm i -g command-code`. T3 Code reports the version it detected and uses
the new binary the next time it starts a session; it does not run the Command
Code updater for you.

## Known limitations

- Command Code reads, writes, and runs commands through its own permission
  engine; the editor's file and terminal services are not used, so unsaved
  buffers are not visible to the agent.
- Audio input is not supported. Images and file mentions are.
- T3 Code does not manage the `cmd` installation; install, authenticate, and
  update it yourself.
