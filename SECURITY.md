# Security

Omp-Wand is a local bridge for a user's own OMP terminals. It listens only on Unix sockets in the private `~/.omp/omp-wand/` directory and communicates with Codex through stdio. Socket permissions and ownership are checked, but this is not process isolation from another application running as the same OS account.

Remote writes require an exact session ID, the current Omp-Wand instance ID, and a caller-generated request ID. Request IDs are deduplicated in memory for the live extension instance. A restart deliberately rejects an old instance ID; it does not claim exact-once delivery across crashes. Read the session history before retrying uncertain delivery.

Session output is untrusted project data. Omp-Wand does not interpret it as instructions, does not expose generic shell or filesystem tools, and cannot redact secrets already present in transcript content requested by Codex. Native approval dialogs remain local. `/remote off` pauses writes but not reads.

## Reporting a vulnerability

Please use GitHub's private [security advisory reporting form](https://github.com/latentwill/Omp-Wand/security/advisories/new) to report suspected vulnerabilities. Include:

- the affected version or commit;
- operating system and Node.js version;
- a minimal reproduction, without credentials or private session data;
- impact and any required local configuration.

Do not include API keys, tokens, personal paths, transcript exports, or other private data. Allow maintainers reasonable time to investigate and coordinate a fix before public disclosure. This project has no promise of a security bounty or a guaranteed response time.
