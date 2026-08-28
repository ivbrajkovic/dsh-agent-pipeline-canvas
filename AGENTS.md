# AGENTS.md

`dsh-agent-pipeline-canvas` is a DSH Web plugin that provides a visual canvas for building and running agent pipelines. Pipelines are DAGs of agents executed through the DeepSeek Harness `subagents` service and persisted per workspace.

The DeepSeek Harness repository at `~/Desktop/deepseek-harness` is the reference and source of truth for Harness APIs, services, patterns, and behavior. It is extensively documented. Research it when needed instead of guessing or duplicating Harness knowledge here. **Do not modify the Harness repository.**

The relevant projects are indexed by Codebase Memory. Prefer its code graph for discovery and cross-project research when possible; use graph nodes and relationships to quickly locate relevant implementations, APIs, services, and dependencies before manually searching through repositories.

## Development

Publish local changes to the active DSH Web profile with:

```bash id="b81d52"
pnpm build && rsync -a --delete --exclude .git --exclude node_modules ./ ~/.dsh/profiles/web/node_modules/dsh-agent-pipeline-canvas/
```

For UI work, use /chrome-devtools to verify changes in the running application. Attach to the existing Chrome window/tab instead of opening a new browser instance.
