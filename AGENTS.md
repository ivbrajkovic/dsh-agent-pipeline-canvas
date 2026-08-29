`dsh-agent-pipeline-canvas` is a DSH Web plugin that provides a visual canvas for building and running agent pipelines. Pipelines are DAGs of agents executed through the DeepSeek Harness `subagents` service and persisted per workspace.

The DeepSeek Harness repository at `~/Desktop/deepseek-harness` is the reference and source of truth for Harness APIs, services, patterns, and behavior. It is extensively documented. Research it when needed instead of guessing or duplicating Harness knowledge here. **Do not modify the Harness repository.**

The relevant projects are indexed by Codebase Memory. Prefer its code graph for discovery and cross-project research when possible; use graph nodes and relationships to quickly locate relevant implementations, APIs, services, and dependencies before manually searching through repositories.

Project documentation lives in `docs/` — start at `docs/index.md`. The README is a short overview; the guides (`docs/guide/`) and reference documents (`docs/reference/`) carry the details, so link to them instead of growing the README.

## Development

The active DSH Web profile installs this checkout as a DSH bundle (pnpm `link:` — the profile serves these files directly), so publishing changes is:

```bash id="b81d52"
pnpm build
```

Then restart the web profile host to remount Host routes; client-only changes need just a hard browser refresh.

The package is a public DSH bundle: `cordis.patch.yml` carries the `agent-pipeline-canvas` activation row, and the `files` field in package.json controls what ships. Keep both in sync when the plugin row or shipped paths change. Public installs use `dsh plugin --profile <name> add github:ivbrajkovic/dsh-agent-pipeline-canvas` (details in `docs/guide/deployment.md`); the local profile was installed the same way, pointing at this directory.

For UI work, use /chrome-devtools to verify changes in the running application. Attach to the existing Chrome window/tab instead of opening a new browser instance.
