# AGENTS

## Development

- This is the standalone public repository for the Pi dynamic workflow extension.
- Do not commit credentials, generated `dist/`, `node_modules/`, or
  `.pi-workflow-runs/` data.
- `npm test` runs Biome, TypeScript build, extension typechecking, and unit tests.
- The CI workflow also verifies installing this checkout with `pi install` as a
  local path.

## Release and compatibility

- The project is distributed as a Git repository; it is intentionally not
  published to npm.
- Behavior changes require a package version bump and a dated `Changelog.md`
  entry.
- Keep the `pi` peer dependencies as host-provided dependencies. Runtime-only
  third-party dependencies belong in `dependencies`.
- Preserve the warning in `README.md`, `SECURITY.md`, and `BACKLOG.md` that the
  workflow VM must not be treated as a security boundary for untrusted saved
  workflows.
