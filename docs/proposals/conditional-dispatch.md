# Conditional dispatch — selective emission

**Status:** agreed direction.
**Extends:** the node model — nodes gain multiple named output ports.

Under the stream model, conditionality is not a construct. It is what output
ports do: **a node emits on some output ports and not on others.**

## 1. The use case

```
                     ┌── port "mail"  → [Send mail]  ──┐
[Analyze doc] ─────→ [            ]                    ├── [Log]
                     └── port "slack" → [Ask on Slack]─┘
```

The analyze node's structured output carries the decision —
`{ action: "mail" | "slack", … }`. **Port bindings** on the node map the
field to a port deterministically: `action == "mail"` → port `mail`. The
executor compares fields — no extra model call decides the routing, and the
branch that is not selected never starts: its port stays quiet, so nothing
downstream of it ever fires.

## 2. The mechanics

- **Named output ports.** Nodes declare ports as a list; today's single
  `<id>:out` is the default single entry. Input ports keep their policies
  (`all-of` / `any-of`) and bounds.
- **Port bindings.** A binding maps a structured-output field value to a port
  (`field == value → port`). Bindings are data on the node — persisted,
  visible, editable in the panel. The executor does the comparison.
- **A quiet port is honest.** An unselected branch is not "skipped" by some
  machinery — its input port simply receives nothing, which is what the
  canvas shows.
- **The join is declared.** A downstream node that should proceed on
  whichever branch ran wires its input as **any-of**; a node that legitimately
  waits for several sources uses **all-of** and is reported if starved. No
  belonging rules, no merge constructs — ports and policies are the whole
  story, and cross-branch wiring is expressible where it is genuinely wanted.

## 3. Loops compose for free

The refine loop is the same mechanic: the reviewer has two output ports —
`feedback` (wired back into the coder) and `verdict` (wired forward). Emitting
on `feedback` continues the loop; emitting only on `verdict` ends it. A bound
on the feedback port caps the iterations. Conditionality and iteration are
one primitive: selective emission.

## 4. Failure semantics

- A firing whose selector value matches no binding emits on no port — the
  record shows it, and starved downstream nodes surface in the run report. A
  **catch-all binding** may be declared where a fallback is genuinely wanted.
- A firing that fails the run follows the global fail-fast rule (see
  [parallel execution](parallel-execution.md)).

## Related

- [parallel-execution.md](parallel-execution.md) — the firing kernel these
  mechanics run on.
- [../reference/design-principles.md](../reference/design-principles.md) —
  the stream model.
