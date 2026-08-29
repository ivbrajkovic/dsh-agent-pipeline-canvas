<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/header/graph.svg?title=Agent+Pipeline+Canvas&subtitle=Visual+agent-pipeline+canvas+for+DSH+Web&logo=ri:flow-chart&mode=dark" />
    <img alt="Agent Pipeline Canvas" src="https://shieldcn.dev/header/graph.svg?title=Agent+Pipeline+Canvas&subtitle=Visual+agent-pipeline+canvas+for+DSH+Web&logo=ri:flow-chart&mode=light" />
  </picture>
</p>

<p align="center">
  <a href="./LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/license/ivbrajkovic/dsh-agent-pipeline-canvas.svg?mode=light&size=xs" /><img alt="MIT license" src="https://shieldcn.dev/github/license/ivbrajkovic/dsh-agent-pipeline-canvas.svg?mode=dark&size=xs" /></picture></a>
  <a href="https://github.com/ivbrajkovic/dsh-agent-pipeline-canvas/stargazers"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/stars/ivbrajkovic/dsh-agent-pipeline-canvas.svg?mode=light&size=xs" /><img alt="GitHub stars" src="https://shieldcn.dev/github/stars/ivbrajkovic/dsh-agent-pipeline-canvas.svg?mode=dark&size=xs" /></picture></a>
  <a href="https://github.com/ivbrajkovic/dsh-agent-pipeline-canvas/commits"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/github/last-commit/ivbrajkovic/dsh-agent-pipeline-canvas.svg?mode=light&size=xs" /><img alt="Last commit" src="https://shieldcn.dev/github/last-commit/ivbrajkovic/dsh-agent-pipeline-canvas.svg?mode=dark&size=xs" /></picture></a>
  <a href="https://www.typescriptlang.org"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/TypeScript-strict.svg?logo=typescript&mode=light&size=xs" /><img alt="TypeScript strict" src="https://shieldcn.dev/badge/TypeScript-strict.svg?logo=typescript&mode=dark&size=xs" /></picture></a>
  <a href="https://nodejs.org"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/node-%3E%3D18.17.svg?logo=node.js&mode=light&size=xs" /><img alt="Node.js 18.17 or newer" src="https://shieldcn.dev/badge/node-%3E%3D18.17.svg?logo=node.js&mode=dark&size=xs" /></picture></a>
  <a href="https://github.com/ivbrajkovic/dsh-agent-pipeline-canvas/blob/main/package.json"><picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/badge/dependencies-0.svg?logo=npm&mode=light&size=xs" /><img alt="Zero runtime dependencies" src="https://shieldcn.dev/badge/dependencies-0.svg?logo=npm&mode=dark&size=xs" /></picture></a>
</p>

---

**dsh-agent-pipeline-canvas** is a DSH Web composition plugin: a visual
**agent-pipeline** canvas in every session — a **Pipelines** view tab, plus a
composer button that works even on a brand-new session. Build a DAG of
generic agents, then run it: each agent is delegated to the harness's own
`subagents` service in deterministic topological order, outputs flow
downstream, and the durable run returns
`{ outputs: { [terminalId]: output } }`. The graph persists per repository.

<p align="center">
  <img alt="The Pipelines canvas: three agents wired as a chain, with a Valid chip in the toolbar and breakpoint dots on two nodes" src="docs/assets/canvas.png" width="840" />
</p>

## What it does

- **Visual DAG editor** — drag agents onto the canvas, wire outputs to
  inputs (fan-out and fan-in), get live DAG validation as you edit.
- **Per-agent configuration** — system prompt (the harness persona slot),
  provider/model/reasoning/tokens, tool filter, delegation-depth cap, and an
  output schema; empty fields inherit the parent session.
- **Durable runs** — a run executes in the Host process, survives page
  reloads and profile restarts, and streams its progress over SSE; one run
  is active per workspace.
- **Breakpoints** — pause any agent after its output settles, then inspect
  and **resume**, **rerun** from the original input, **steer** the same
  child with feedback, or **abort** — all across restarts.
- **Results that go somewhere** — continue in chat, in a new session, or in
  any workspace session; nothing is ever auto-sent.
- **Zero runtime dependencies** — three faces (Host routes, React client,
  pure core) over one shared validation/execution contract.

Not yet implemented: concurrent dispatch, conditional dispatch, run
operations, loops, and retries. The first three are designed in
[docs/proposals/](docs/index.md#proposals--agreed-designs-not-yet-built);
the executor is still sequential until that lands. Live visualization stays
deferred.

## Documentation

The full manual lives in [docs/index.md](docs/index.md). Read what you need:

| Document | Covers |
|----------|--------|
| [docs/guide/canvas.md](docs/guide/canvas.md) | Building pipelines: nodes, ports, connections, validation, the configuration panel, persistence. |
| [docs/guide/running-pipelines.md](docs/guide/running-pipelines.md) | The run dialog, durable runs and SSE, breakpoints (resume / rerun / steer / abort), results and continue routes. |
| [docs/guide/deployment.md](docs/guide/deployment.md) | Profile wiring, the sync loop, route verification, dev scripts and change discipline. |
| [docs/reference/architecture.md](docs/reference/architecture.md) | Host routes, browser slots and bundling, the pure core, project layout. |
| [docs/reference/graph-and-execution.md](docs/reference/graph-and-execution.md) | The graph schema, every validation error code, and the execution contract. |
| [docs/reference/design-principles.md](docs/reference/design-principles.md) | The durable design rules every feature must keep. |
| [docs/reference/system-prompt.md](docs/reference/system-prompt.md) | The harness system-prompt section layout and the persona slot an agent's system prompt replaces. |

## Install & uninstall

The package is a DSH **bundle**: its `dsh.bundle` manifest ships the plugin
layer, and `lib/` is committed build output, so a git install needs no build
step and no pnpm `allowBuilds` allowance.

Install into any profile:

```
dsh plugin --profile <name> add github:ivbrajkovic/dsh-agent-pipeline-canvas
```

`dsh` appends the package to the profile's `dsh.profile.bundles` list and
applies the shipped layer — no manual patch rows needed. Verify without
booting:

```
dsh --profile <name> --dump-config   # shows a "# == dsh-agent-pipeline-canvas" layer
```

Then start (or restart) the profile and hard-refresh the browser tab: every
session gains a **Pipelines** view tab and a composer button. To pin a
revision instead of tracking `main`, append a commit:
`github:ivbrajkovic/dsh-agent-pipeline-canvas#<commit>`.

Uninstall:

```
dsh plugin --profile <name> remove dsh-agent-pipeline-canvas
```

`dsh` removes both the dependency and the bundle layer; after a profile
restart and a hard browser refresh, the **Pipelines** tab is gone.

### Local development deploy

The live web profile consumes this checkout directly — it was installed with
`dsh plugin --profile web add <this checkout>`, so pnpm links it and the
profile serves these very files. After a change:

```
npm run sync   # typecheck + test + build
```

Client-only changes need a hard browser refresh; host changes need a profile
restart. Details, caveats, and route verification:
[docs/guide/deployment.md](docs/guide/deployment.md).

## Development

```
npm run typecheck   # tsc -p tsconfig.json (whole tree, noEmit)
npm test            # plain tsx scripts: validate + execution + message + runner + runs
npm run build       # tsc -p tsconfig.build.json && tsdown → lib/
```

`lib/` is committed build output — rebuild, never hand-edit. Change
discipline and conventions: [docs/guide/deployment.md](docs/guide/deployment.md).

## License

[MIT](./LICENSE).
