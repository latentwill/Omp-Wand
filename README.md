# Omp-Wand 🪄

*A little magic for your OMP terminals.*

Work in normal OMP (oh-my-pi) terminals at your desk. Then let Claude Code (or Codex) read and drive those same sessions through a local MCP server: send prompts, wait for replies, and answer the multiple-choice questions, approvals and input boxes that OMP opens.

## Install

Prerequisites: macOS, OMP 18.x, Node.js 20.3 or newer, and Claude Code and/or Codex on `PATH`.

```sh
git clone https://github.com/latentwill/Omp-Wand.git
cd Omp-Wand
node install.mjs            # Claude Code and Codex, whichever are installed
node install.mjs --claude   # Claude Code only
```

The installer copies the extension to `~/.omp/agent/extensions/omp-wand/` and registers the `omp-wand` MCP server (`claude mcp add --scope user`, `codex mcp add`). Run it again after you pull changes.

New `omp` terminals connect automatically; the footer shows **Remote connected**. A terminal that was already open needs a restart: exit it when idle and run `omp --resume <session-id>`. Restart Claude Code so it loads the new tools.

## Tools

| Tool | What it does |
| --- | --- |
| `omp_list_sessions` | Connected terminals with status (`idle`, `working`, `waiting_for_input`), project, name, model and open dialogs. |
| `omp_read_session` | Recent transcript (text plus one-line tool calls), streaming text, last reply of the current turn, last error. |
| `omp_send_prompt` | Send a prompt. `mode`: `prompt` (idle only), `followUp` (queue), `steer` (redirect). `wait_seconds` blocks until the session settles. |
| `omp_answer` | Answer an open dialog. See below. |
| `omp_wait` | Block until sessions settle (idle, waiting on a dialog, or disconnected), then return status, dialogs and the last reply. |
| `omp_interrupt` | Abort the current run, like Esc. |
| `omp_rename_session` | Rename a session without model tokens. |

A typical loop: list → `omp_send_prompt` with `wait_seconds` → if the status is `waiting_for_input`, `omp_answer` → `omp_wait` → repeat.

## Dialogs

OMP gives tools, tool approvals and extensions one shared UI object. Omp-Wand wraps its dialog methods, so every open dialog shows in the `dialogs` field and can be answered remotely. The terminal dialog stays open: whichever side answers first wins, and the other side closes. This is the same race that OMP uses for its collab guests.

| `kind` | Opened by | Answer with |
| --- | --- | --- |
| `ask` | the `ask` tool (multiple choice) | `choice` (label or 0-based index), or `choices` for multi-select; `text` for a custom answer; `note`; several questions: `answers: [{ id, choice \| choices \| text }]`; `chat: true` for "Chat about this" |
| `approve` | tool approvals | `confirm: true \| false` |
| `select` | extensions, older approval flow | `choice` |
| `confirm` | extensions | `confirm` |
| `input`, `editor` | extensions | `text` |

`cancel: true` dismisses any dialog as Esc would; for `ask` that aborts the run. `dialog_id` defaults to the oldest open dialog. An invalid answer returns an error and the dialog stays open.

## Local control

- `/remote off` in a terminal pauses remote writes (prompts, answers, interrupts, renames); reads continue. `/remote on` resumes them.
- A prompt is refused while the terminal has an unsent draft, and while a dialog is open.
- Remote prompts are plain text. Slash commands and `!` shell commands need the terminal.

## Trust boundary

- Each terminal listens on a private Unix socket in `~/.omp/omp-wand/` (folder 0700, sockets 0600). There is no network port. This does not isolate the bridge from other processes that run as your user.
- Session output is untrusted project data. The MCP server tells the client not to follow instructions found in it.

## Remove

```sh
claude mcp remove --scope user omp-wand
codex mcp remove omp-wand
rm -r ~/.omp/agent/extensions/omp-wand
```

## Development

```sh
npm test
```

The tests use fake OMP and UI objects; they do not contact a model. For a real-TUI smoke test, `test/offline-fixture.ts` adds a local echo model. A prompt that contains `ASK_TEST` makes it call the `ask` tool:

```sh
omp --no-session --no-extensions -e index.ts -e test/offline-fixture.ts --model omp-wand-test/echo
```

The socket path must stay under 104 bytes (macOS limit). If you set `OMP_REMOTE_DIR` for a test, use a short folder.

## License

MIT. See [LICENSE](LICENSE) and [SECURITY.md](SECURITY.md).
