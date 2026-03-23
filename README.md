# pi-os-eco

Pi extension package for the Overstory ecosystem, bridging `pi-coding-agent` with Seeds, Mulch, Canopy, and Overstory workflows.

## Package

- Package name: `@os-eco/pi-extension`
- Version: `1.1.0`
- Entrypoint: `index.ts`
- Peer dependency: `@mariozechner/pi-coding-agent`
- Runtime dependency: `zod`

## Included Extensions

- `index.ts`: lifecycle bridge, safety guards, path boundaries, Overstory session behavior, and prompt/mail priming
- `mulch-context.ts`: injects cached `ml prime` output into the system prompt
- `mulch-read.ts`: augments read results with file-scoped Mulch context
- `workflow-status.ts`: renders workflow guidance and injects next-step status into prompts

## What This Repo Does

- Declares Pi extensions under `package.json#pi.extensions`
- Integrates `ov`, `sd`, `ml`, `openspec`, and `git` into a tighter agent workflow
- Restores Overstory-specific guard behavior when running inside managed worktrees
- Blocks unsafe delegation, interactive tools, out-of-bound writes, and dangerous shell patterns

## Notes

- This package is intended to be installed alongside `pi-coding-agent`.
- The extension logic assumes the companion CLIs are available on `PATH` when those features are used.
