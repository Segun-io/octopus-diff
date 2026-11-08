# octopus-diff

A **diff-first, read-only git UI that shows many projects and worktrees in one view**, built for the era
of coding agents that edit many repositories at once. It answers three questions in one window: *what
changed across everything since I last looked, what exactly is the diff, and where am I?*

> Status: under construction (MVP). See [`docs/PLAN.md`](docs/PLAN.md) for the plan.

## Development

Requirements: Node ≥ 24, pnpm 12, git.

```sh
pnpm install
pnpm check      # lint + typecheck + unit tests + build
pnpm test:e2e   # Playwright end-to-end tests
```

See [AGENTS.md](AGENTS.md) for conventions and repository layout.

## License

MIT
