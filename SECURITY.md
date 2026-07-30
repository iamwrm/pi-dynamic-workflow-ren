# Security

This extension runs model-authored workflow programs and can delegate work to
Pi subagent sessions. It can therefore read and modify files through the Pi
tools available to those sessions.

The workflow VM is a determinism and convenience boundary, **not a complete
security boundary for untrusted saved workflows**. Do not execute project-local
saved workflows or agent definitions from an untrusted repository. Review the
security limitations in [`BACKLOG.md`](./BACKLOG.md) before enabling this in a
new trust boundary.

If you find a security issue, do not include credentials or private data in a
public issue. Use GitHub's private vulnerability reporting for this repository
when available; otherwise contact the repository owner privately with a minimal
reproduction.
