# Install, deploy & develop

How to get the plugin into the DSH Web profile, how to publish changes, and
how to work on it. For what the plugin does, start at the
[README](../../README.md) or the [docs index](../index.md).

## Requirements

- Node ≥ 18.17.
- A DSH Web profile with the harness `subagents` service mounted. The
  continuable runtime (`subagents.startContinuable` + session persistence)
  additionally enables breakpoint steering — without it the plugin degrades
  gracefully (see
  [running-pipelines.md](running-pipelines.md#limitations-and-degradation)).

## Install: one-time wiring

The plugin is deployed into the local DSH web profile as a **copy** (not a
symlink) at `~/.dsh/profiles/web/node_modules/dsh-agent-pipeline-canvas/`.

1. Add the dependency to `~/.dsh/profiles/web/package.json`:

   ```json
   "dsh-agent-pipeline-canvas": "file:../../../Desktop/agent-pipeline/dsh-agent-pipeline-canvas"
   ```

2. Add the plugin row to `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   # Local composition plugin: agent-pipeline canvas as a Pipelines view tab.
   - id: agent-pipeline-canvas
     name: dsh-agent-pipeline-canvas
   ```

## Deploying changes: the sync loop

After every change, run the one-command loop — it typechecks, runs the tests,
builds, and syncs the tree into the profile (stopping before the copy if any
step fails):

```
npm run sync
```

The script wraps the plain copy, if you ever need it on its own:

```
rsync -a --delete --exclude .git --exclude node_modules ./ \
  ~/.dsh/profiles/web/node_modules/dsh-agent-pipeline-canvas/
```

**Client-only changes** need just the sync plus a hard browser refresh (the
client is served fresh, no cache). **Host changes** additionally need a web
profile restart so the routes re-mount.

`pnpm install` inside the profile is currently blocked by a pre-existing
supply-chain policy error (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` for
`dshmarket@1.34.0`); the rsync path needs no install.

### Verifying the host route after a restart

```
curl -s 'http://127.0.0.1:3080/dsh-agent-pipeline/run?id=x'
# {"ok":false,"error":"no such run"}  (mounted; 404 = the route answered)
```

## Development

`node_modules/` symlinks the toolchain out of the harness checkout, so the
scripts run with no install step:

```
npm run typecheck   # tsc -p tsconfig.json (whole tree, noEmit)
npm test            # plain tsx scripts: validate + execution + message + runner + runs
npm run build       # tsc -p tsconfig.build.json && tsdown → lib/
```

### Change discipline

In order: edit `src/` → build → re-run the tests → sync to the profile
(above).

- `lib/` is **committed output**, so a rebuild shows up in `git status` —
  never hand-edit it.
- Semantics changes must move the tests with them.
- Source imports are spelled with `.ts` extensions
  (`allowImportingTsExtensions` rewrites them to `.js` on emit) — keep new
  imports in that style.
- The test suites are plain `tsx` scripts (no framework): `validate`,
  `execution`, `message`, `runner`, and `runs`, mirroring the pure core and
  the runner/run registry. See
  [../reference/architecture.md](../reference/architecture.md) for what each
  module owns.
