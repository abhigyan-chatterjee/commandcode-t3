# Command Code

Command Code (`cmd`) runs as a headless Command Code process per turn. T3 Code
starts the session, streams tool activity and the reply, and resumes the same
Command Code session for every following turn in the thread.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries.

## Permissions

Command Code headless runs cannot ask questions mid-turn, so T3 Code starts each
turn with the thread's runtime mode translated to Command Code's permission
mode:

| Thread runtime mode | Command Code permission mode |
| ------------------- | ---------------------------- |
| Approval required   | `default`                    |
| Auto-accept edits   | `accept-edits`               |
| Auto                | `accept-edits`               |
| Full access         | `yolo`                       |

Plan mode starts Command Code with `--permission-mode plan`. To approve commands
without stopping the run, pick a more permissive runtime mode for the thread or
pre-approve commands in the project's `.commandcode/settings.json`.

## Sessions and history

Every turn is committed to Command Code's session store at
`~/.commandcode/projects/`. Threads keep their own Command Code session id, so
following turns continue the same conversation with `--resume`. Headless
sessions stay out of Command Code's interactive resume picker; use
`/session-file` in a terminal session if you need the transcript path.

## Models

The model list comes from `cmd --list-models`. Add custom entries in the
instance's settings to use models the CLI does not list. The selected model is
passed to every turn with `-m`; switching models applies from the next turn.

## Updating Command Code

T3 Code offers an update when the installed version trails the `command-code`
npm package. The updater runs `cmd update` against the resolved binary.

## Known limitations

- Mid-turn approval prompts are not surfaced; the turn runs under the
  permission mode above until it finishes.
- Interrupting a turn stops the Command Code process. Command Code commits
  turns atomically, so an interrupted turn leaves no partial transcript.
- Conversation rollback is not available yet. File-level restores still work
  through T3 Code checkpoints.
