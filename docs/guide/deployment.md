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

## Install

The package ships as a DSH bundle — `dsh.bundle` → `./cordis.patch.yml`,
with `lib/` committed — so the public install is one command: `dsh` links
the checkout, appends it to `dsh.profile.bundles`, and the shipped layer
inserts the plugin row. No build step and no pnpm `allowBuilds` allowance
are needed:

```
dsh plugin --profile <name> add github:ivbrajkovic/dsh-agent-pipeline-canvas
```

### Local profile

The local development profile installs the checkout the same way — point
`dsh plugin add` at this directory and pnpm links it (`link:`), so the
profile serves these very files and there is no copy step.

## Deploying changes

`npm run sync` typechecks, runs the tests, and builds:

```
npm run sync
```

**Client-only changes** need just the build plus a hard browser refresh (the
client is served fresh, no cache). **Host changes** additionally need a web
profile restart so the routes re-mount.

A full `pnpm install` inside the profile is blocked by a pre-existing
supply-chain policy entry (`dshmarket@1.34.0` and the `minimumReleaseAge`
policy); the partial installs that `dsh plugin add`/`remove` perform are not
affected.

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
