# Security

Omp-Wand is a local bridge to your own OMP terminals. Each terminal listens on a Unix socket in the private `~/.omp/omp-wand/` folder (0700; sockets 0600), and the MCP server talks to Claude Code or Codex over stdio. There is no network port. Ownership and permissions are checked, but this does not isolate the bridge from other processes that run as your user.

Remote writes (prompts, dialog answers, interrupts, renames) need an exact session ID, and `/remote off` in a terminal pauses them. Reads continue while writes are paused.

Session output is untrusted project data. Omp-Wand does not interpret it as instructions, does not expose generic shell or filesystem tools, and cannot redact secrets that are already in a transcript.

## Reporting a vulnerability

Use GitHub's private [security advisory form](https://github.com/latentwill/Omp-Wand/security/advisories/new). Include:

- the affected version or commit;
- operating system and Node.js version;
- a minimal reproduction, without credentials or private session data;
- impact and any required local configuration.

Do not include API keys, tokens, personal paths, transcript exports or other private data. This project makes no promise of a bounty or a response time.
