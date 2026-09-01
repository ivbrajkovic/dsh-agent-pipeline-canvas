# The harness system prompt — what a pipeline agent sees

A DSH agent's system prompt is not one blob of text. It is **assembled from
small named sections**, each with an explicit order number, joined with blank
lines. The harness owns almost all of them; a pipeline agent's **system
prompt** field (the harness calls this slot the *persona*) replaces exactly
one slot and touches nothing else. This file records the layout so nobody has
to re-derive it from the harness checkout.

Reference (read-only): `packages/core/system-prompt/src/index.ts` and
`packages/subagent/subagent/src/child-agent.ts` in the harness checkout
(`~/Desktop/deepseek-harness`).

## The section stack, in prompt order

Order numbers are `FIRST_PARTY_SECTION_ORDER` from the system-prompt package.
Sections sort by order (ties: by name); lower renders first.

| Order | Section name       | What it says | Who owns it |
|------:|--------------------|--------------|-------------|
| -1000 | `harness:identity` | "You are an AI agent powered by DeepSeek Harness." | Fixed (on by default) |
|  -900 | `harness:source`   | Where the harness checkout lives; never infer the cwd from it | App bin, at boot |
|  -800 | `app:web-surface`  | Describes the DSH Web GUI serving the session | Web app bundle |
|     0 | `deployment:persona` | **The persona slot** — who the agent is, how it behaves. Deployment-wide; **empty on this deployment**. This is the slot our per-agent **System prompt** field replaces | Harness config; **replaceable per pipeline agent** |
|   120 | `subagent:delegation` | "You are a delegated subagent: your permission scope was fixed when you were started…" | Auto-added to every subagent |
|   500+ | plan / team / approval / sandbox policies | Behavior rules (plan mode, approvals, sandbox) | Harness |
|  1000–2900 | `tool:bash`, `tool:read`, `tool:write`, `tool:edit`, `tool:glob`, `tool:grep`, jobs, pty, web-search, web-fetch, lsp, session-query, goal, cordis, subagent, report, … | **One section per harness tool — the tool explanations** | The tool providers themselves |
|  5000+ | SDK tools, deliverable file references, structured output | Trailing mechanics | Harness |

So the tool documentation a pipeline agent sees is the **same** sections the
main session agent sees — registered by the harness's own tool providers,
independent of anything we author.

## What happens when a pipeline agent runs

Each pipeline agent is a `subagents.start("spawn", …)` child. At creation the
child:

1. **Joins the parent's preset composition** — it inherits the full standard
   section stack above (identity, policies, every tool explanation).
2. Gets the fixed `subagent:delegation` section (every subagent does).
3. If the agent has a **system prompt** (`Agent.systemPrompt`), it is
   forwarded as the harness request's `persona` field and registered as a
   *scoped* section named `deployment:persona` — the same name as the
   deployment's slot. The nearest scope wins a name, so the deployment
   persona's text is **swapped out for this child alone**. No duplication, no
   concatenation; everything below order 0 is byte-identical.
4. If there is **no system prompt**, the deployment persona stands. This web
   profile configures none and the schema defaults it to `''`, and **empty
   sections are dropped** — so the slot simply contributes nothing.

Net: the system prompt **replaces one small slot near the top**; it is
neither appended to the tool instructions nor an override of the prompt as a
whole.

## What you can replace — and what you can't

**Can replace:** the persona slot, per agent, via the config modal's
**System prompt** field (left column, above Instructions). It is a
first-class agent field (`Agent.systemPrompt`, persisted with the pipeline
graph — the session's `pipelines/<sessionId>.json` once it forks, else the
legacy `pipeline.json` — forwarded by `src/runner.ts` as
`SubagentStartRequest.persona`).

- Write plain prose. The text goes through the harness's strict
  `{{variable}}` template interpolation (the deployment persona uses the same
  renderer): plain text passes through untouched, but a literal `{{word}}`
  would be read as a variable reference and **throw at run time** unless that
  variable is registered. Avoid double curly braces.
- Leave it empty to inherit the deployment default (here: nothing — just the
  fixed identity line).

**Can't replace (and shouldn't):** identity, harness source, web surface, the
delegation statement, the policy sections, and every tool section. Those are
harness-owned; the plugin has no mechanism (and no need) to touch them.

## Assembly rules, in one line each

- Sections are named; the same name in a nearer scope **shadows** the outer
  one (that is the entire persona mechanism).
- Render = interpolate strict `{{variables}}` → drop empty sections → join
  the rest with blank lines, sorted by order.
- Malformed or unknown `{{references}}` throw at render; a lone `{{` with no
  later `}}` is treated as literal prose.
