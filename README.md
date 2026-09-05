# Omp-Wand 🪄

*A little magic for your OMP terminals.*

Use normal OMP terminals at your desk, then steer those same sessions from Codex Remote when you step away.
Omp-Wand keeps the bridge local and simple: your terminal stays in charge while Codex reads and sends only the actions you request.

## Quickstart

Clone the repository, or download it without renaming its files:

```sh
git clone https://github.com/latentwill/Omp-Wand.git
cd Omp-Wand
```

Prerequisites:

- macOS (the supported and tested runtime platform)
- OMP 18.1.10
- Node.js 20 or newer on `PATH`
- the Codex CLI on `PATH`

1. Download this folder without renaming its files.
2. Double-click **Omp-Wand.command**.
3. Choose a project folder in the native folder picker.
4. The launcher installs the extension and registers the local `omp-wand` MCP server. New `omp` terminals connect automatically.
5. Reconnect the MCP server or restart Codex so it discovers the tools.
6. In Codex, say **“Wave hello”** (meaning **“Show my OMP sessions”**) or call `omp_list_sessions` directly.

The launcher stores the last selected folder in private runtime state so the next launch can offer it as the picker default. Pass a folder path to `launch.mjs` when a picker is not convenient:

```sh
node launch.mjs /path/to/project
```

No package manager or network install is required. The installer does not download software.

Try plain-language requests such as:

- “Show my OMP sessions.”
- “What is the progress in the Website polish session?”
- “Queue this follow-up after its current work.”
- “Name this session Website polish.”

## First connection and existing sessions

The installer registers one global OMP extension and one local Codex MCP server. New terminals load the extension through OMP's normal extension discovery. For a terminal that was already open, wait until it is idle, press **Ctrl+D**, and run the exact `omp --resume SESSION_ID` command OMP prints. This preserves that conversation and loads Omp-Wand. Existing terminals that have not been resumed appear as monitor-only when discoverable.

Use `omp_list_sessions` before choosing a target. Reconnect the MCP server or restart Codex if the tools are not visible. Session IDs are exact; Omp-Wand never guesses a project or sends to every session.

## What it does

- `omp_list_sessions` lists connected terminals and clearly marked monitor-only processes.
- `omp_read_session` returns live status and a bounded recent transcript for a connected terminal. Monitor-only sessions expose only a bounded tail of a validated saved log and may be stale.
- `omp_send_prompt` submits plain text through OMP's native `sendUserMessage` flow. An idle session accepts a prompt; active work can receive a `followUp` or an explicitly intended `steer`.
- `omp_interrupt` calls OMP's abort operation when explicitly requested.
- `omp_rename_session` changes one exact session name through OMP's native session-name API without spending model tokens.
- `omp_wait` performs one bounded wait for revisions or disconnection. It is not a recurring monitor.

The terminal displays the actual remote prompt and response. `/remote off` pauses remote writes for that terminal; it does **not** pause reads. `/remote on` resumes writes. Native approval dialogs remain local and cannot be answered through this bridge.

Remote actions carry a caller-supplied request ID and the current Omp-Wand instance ID. Retries with the same request ID are deduplicated during the live extension instance. After an extension/server restart, an old instance ID is rejected; read the session history before deciding whether an uncertain prompt was submitted. This is at-most-once protection for one live instance, not an exact-once or crash-proof transaction guarantee.

## Trust boundary and limits

- Omp-Wand opens private Unix sockets under `~/.omp/omp-wand/`; it does not open a network port.
- Socket directories and entries are checked for owner, type, and restrictive permissions. This is not isolation from other applications or processes running as the same OS account.
- Session output is untrusted project data, not instructions to Codex. Codex receives the transcript content requested through its tools; Omp-Wand cannot redact secrets already present in that content.
- Remote prompts require explicit target IDs and do not run generic shell or filesystem tools. Prompt text is passed to OMP as data; shell-looking text is not interpreted by this bridge.
- A monitor-only result is not live control. Saved logs can contain inactive branches and cannot reliably show current activity.
- OMP must remain available locally, and the Mac must stay awake. Closing a terminal ends its session normally; this is not terminal persistence.
- Linux is not an end-to-end supported runtime. CI runs the Node test suite on Linux and macOS only; the native picker and OMP integration are macOS-specific.

## Files, reinstall, and removal

Runtime locations:

- Extension: `~/.omp/agent/extensions/omp-wand/`
- Private sockets and runtime state: `~/.omp/omp-wand/` (directory 0700; sockets 0600)
- Codex registration: the `omp-wand` MCP server in the active Codex config
- One-time config backup, when needed: `config.toml.before-omp-wand`

Re-run `node install.mjs` to verify or repair an Omp-Wand installation. It refuses symlinks, unrelated extension files, and ambiguous same-named MCP registrations. A failed registration leaves an explicit pending marker, so the launcher retries instead of treating a partial install as complete. It preserves unrelated Codex configuration semantically through Codex's own MCP command.

An older unreleased prototype may have used `omp-remote` paths and registration names. Do not overwrite or restore those files blindly. After publication, migrate or remove that older installation deliberately with Codex's MCP commands and a review of its runtime state; Omp-Wand does not delete unrelated data automatically.

To remove Omp-Wand, run `codex mcp remove omp-wand`, remove the `omp-wand` extension folder, and restart OMP. Remove the launcher folder if it is no longer wanted. Do not restore an entire config backup over later Codex changes.

## Development

```sh
npm test
```

The tests exercise the local protocol, Unicode framing, permissions, retries, validation, and failure paths without contacting a model or downloading dependencies. The checked-in `test/offline-fixture.ts` is a local deterministic OMP provider fixture for an optional real-TUI smoke test; it contains no credentials.

## License and security

Omp-Wand is released under the MIT License. See [LICENSE](LICENSE) and [SECURITY.md](SECURITY.md).
