# Handoff — node context menu

Living log for [node-context-menu.md](node-context-menu.md). Read it before
starting a phase. Append an entry at the end of a phase ONLY when the
implementation materially diverged from the plan: what changed, and why.
Do not record anything the plan or the code already shows.

## Entries

### N2 — the RUNNING-node transcript claim holds only for breakpointed agents

The implementation follows the plan verbatim (availability = the projected
`childSessionId`). But the design stance's "the executor assigns it the
moment the child starts — so a RUNNING node opens its live transcript" is
true only on the continuable path: breakpointed agents commit the id at
child start (`runContinuableEpoch`, one commit after `startContinuableAgent`
resolves), while ONE-SHOT agents adopt it in the settle commit
(`settleOneShotFiring` — the spawn outcome is the first time the plugin
learns the id). Observed live: a running one-shot node's record never
carries the id mid-run, so its entry stays disabled until the firing
settles — correct per the pinned availability rule (there is no transcript
address to open yet). "Mid-run for a node that already fired" works for
every agent, and the RUNNING-node live transcript was verified by arming a
breakpoint (continuable): entry enabled while the node ran, activation
landed in the streaming child session. N3's guide wording should state the
rule as "enabled once the node has a child session — running one-shot nodes
gain one only when they settle".

### N3 — the gesture guard is a net, not the gate: the press itself cancels the gesture

The N3 gate ("the menu opens only when no connection gesture is in flight,
`connectRef.current === null`") premised the gesture surviving until the
`contextmenu` event. It does not: the right-button pointerdown bubbles past
the node's primary-button guards (they return early on `button !== 0`
without `stopPropagation`) to the canvas pointerdown, which cancels the
gesture on ANY button — and any right-button pointerup bubbles to the
container's cancel too. By the time `contextmenu` fires (after mouseup on
Windows, the primary platform), `connectRef.current` is already null.
Verified in the browser with the full pointerdown(2) → pointerup(2) →
contextmenu sequence: the drag cancels and the menu then opens. Shipped
behavior — and what canvas.md now states — is "any canvas press ends an
in-flight connection drag; a right-click on a node cancels the drag and
then opens the menu" (Escape still cancels). The guard line stays as a
cheap net for orderings where the gesture genuinely is alive at
`contextmenu` (a macOS right-press on the node's embedded
breakpoint/edit buttons, which `stopPropagation` for every button): there
the menu stays closed over a live gesture. Verification note: dispatching a
bare `contextmenu` event produces a FALSE pass (the gesture is never
cancelled, so the guard trips); the honest test is the full press sequence.
