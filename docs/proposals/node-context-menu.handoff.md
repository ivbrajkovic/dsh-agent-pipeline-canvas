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
