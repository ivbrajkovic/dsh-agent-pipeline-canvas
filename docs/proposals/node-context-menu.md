# The node context menu — per-agent actions on the canvas

**Status: Built** — all three phases shipped (N1 wiring, N2 Go to transcript,
N3 hardening + docs). Reviewed via the scrutinize
pass before implementation (verdict: fix-then-ship; findings applied — the
menu reuses the harness `Menu` primitive, close-on-activation and the
registration-commit step are pinned). The living phase-delta handoff lives in
[node-context-menu.handoff.md](node-context-menu.handoff.md).

Today the only route into an agent's transcript is the result modal (or the
paused-run inspection modal): after a run ends, open **Result**, find the
agent's row, press **Transcript**. This plan adds a right-click context menu
on each agent node, headed by **Go to transcript**, plus the node actions the
canvas already offers as buttons (edit, breakpoint, delete) so they are
reachable in place.

## Design stance (pinned)

- **Client-only.** No Host routes, no persisted state, no graph-schema change.
  The menu acts through handlers `pipeline-view.tsx` already has
  (`setConfigAgentId`, the breakpoint toggle, node deletion, `openTranscript`).
- **Reuse the harness `Menu` primitive.**
  `@deepseek-ai/dsh-client-ui-primitives` is a host platform module
  (`deepseek-harness` `packages/client/web/src/platform.ts` `PLATFORM_MODULES`,
  statically seeded into the frozen module table by `web/src/seed.ts` — the
  same table that answers this bundle's `require("react")`), so the plugin's
  bundle can require it directly. Wiring: add the specifier to
  `MODULE_TABLE_EXTERNALS` in `tsdown.config.ts` and carry a local `.d.ts`
  shim for typecheck (the package is not a devDependency of this standalone
  plugin). The primitive already implements the entire interaction set this
  plan would otherwise hand-roll — portal to `document.body` with fixed
  positioning, `getAnchorRect` for the pointer point, Escape +
  outside-`pointerdown` dismissal, viewport clamping, pointer grace, disabled
  and danger rows, submenu — and the HOST styles it, so there is no plugin CSS
  and no z-index decision (host-owned layering; same visual language as the
  host app). The coupling is as version-stable as the existing `react`
  external: the specifier is part of the host's closed platform-module union.
- **Go to transcript availability = the node's projected `childSessionId`.**
  The projection computes it for live, paused, and restored-last-run records
  alike, and the executor assigns it the moment the child starts — so a
  RUNNING node opens its live transcript. A node that never fired shows the
  item **disabled**. `MenuItem` has no tooltip field, so availability is
  signaled by the disabled state alone; the guides carry the rule.
- **The transcript action reuses `openTranscript` verbatim** — its per-session
  view-tab handoff (`pendingChatView`), same-session fast path, and panel
  dismissal are already correct. No new navigation machinery.
- **Entry model = `MenuEntry`** (`MenuItem` with `id` / `label` / `disabled` /
  `danger`, plus separators) dispatched through the Menu's single `onSelect`.
  Submenus come with the primitive but are a non-goal here; full arrow-key
  roving is not part of the primitive either (recorded known limit).

### Pinned menu shape

```
Go to transcript        (disabled until the node has a child session)
────────────────────
Edit agent
Arm breakpoint / Disarm breakpoint   (label reflects state)
────────────────────
Delete agent            (danger)
```

Ordering: the transcript route first (the headline), then editing, then the
destructive item last.

## Working context (read before starting any phase)

- **Where things live** — `src/ui/pipeline-view.tsx`: node rendering (the
  `nodes` map, ~line 792), pointer handlers (`onNodePointerDown/Move/Up`,
  `onOutputPointerDown`), `runProjection` (live `activeRun` or terminal
  `doneRun`), `openTranscript` (~line 481), the modals. Precedent for the
  Transcript button: `src/ui/result-modal.tsx` (per-run rows) and
  `src/ui/inspect-modal.tsx` (paused node). Availability source:
  `src/projection.ts` (`ProjectedNode.childSessionId`, latest-defined across a
  node's firings); assignment point in the executor:
  `src/runs.ts` (~line 788).
- **Known wrinkle to fix in N1** — `onNodePointerDown` and
  `onOutputPointerDown` start a drag/gesture on ANY pointer button. Right-click
  must not drag the node or draft a connection: guard both to
  `e.button === 0`. The input port's own `onPointerDown` only preventDefaults —
  guarding it keeps right-click there unhandled by the port so the event
  bubbles to the node and opens the menu (desired).
- **Commits before N1** — two, in order: (1) the finished transcript-navigation
  fix now in the working tree (`pendingChatView` in `pipeline-view.tsx`,
  rebuilt `lib/client.js`, a paragraph in `guide/running-pipelines.md`) as its
  own commit; (2) this plan's registration (`docs/index.md` row plus the two
  `docs/proposals/node-context-menu*` files) as another. Every phase then
  builds on a clean tree.
- **Verification baseline** — `pnpm typecheck`, `pnpm test` (five pure-logic
  suites: validate, execution, message, runner, runs) and `pnpm build` are
  green and must stay green. The UI is not unit-tested; each phase is verified
  in the browser (below). `lib/client.js` is committed build output — rebuild
  every phase so the bundle ships with the source.
- **Browser verification recipe (every phase)** — `pnpm build` (client-only
  change: a hard browser refresh remounts it; no Host restart needed), attach
  Chrome DevTools to the EXISTING Chrome window/tab (never a new instance),
  hard-refresh the DSH Web tab, open a session's Pipelines tab, and exercise
  the menu. Check the frame-wide shell panel host too when the change could
  differ there (it lacks `openView`; `openTranscript` then dismisses the panel).

## N1 — Menu wiring on the node

**Scope.** A thin `src/ui/node-menu.tsx` wrapper around the harness `Menu`
primitive: the plugin supplies the open point
(`portal` + `getAnchorRect={() => new DOMRect(x, y, 0, 0)}`), the pinned
entries, and an `onSelect` that dispatches AND closes — **every entry
activation closes the menu** (e.g. Edit agent must not leave the menu floating
above the config panel it opened). Build wiring: the specifier joins
`MODULE_TABLE_EXTERNALS` in `tsdown.config.ts`; a `.d.ts` shim (e.g.
`src/ui/ui-primitives.d.ts`) types the small surface used. In
`pipeline-view.tsx`: menu state `{ agentId, x, y } | null`; `onContextMenu` on
the node div (preventDefault + stopPropagation, select the node, open at the
pointer); the primary-button guards on the node/port pointer handlers; an
effect that closes the menu when its agent vanishes (Delete key, toolbar
Delete, Clear), plus the wrapper's own cleanup on unmount. Entries wired to
existing handlers: **Edit agent** (`setConfigAgentId`), **Arm/Disarm
breakpoint** (dynamic label), **Delete agent** (node + its connections;
danger). The transcript entry is NOT in this phase — the menu renders the
pinned shape minus its first item.

**Expected outcome.** Right-clicking a node opens the host-styled menu at the
cursor with three working actions; each activation closes the menu before its
action takes effect; left-drag, ports, and the existing node buttons behave
exactly as before; the browser's native menu is suppressed on nodes only
(canvas background keeps native behavior — pinned non-goal: no background
menu).

**Verification.** `pnpm typecheck`, `pnpm test`, `pnpm build` green. Browser:
right-click opens/closes correctly (item, Escape, outside click); each action
performs its existing behavior with the menu closed afterward; right-button
press no longer drags the node or drafts a connection; deleting a node while
its menu is open closes the menu; verify in the shell-panel host as well.

## N2 — "Go to transcript"

**Scope.** `pipeline-view.tsx` computes the entry list per node: the first
entry is **Go to transcript**, disabled unless
`runProjection?.nodes[agent.id]?.childSessionId` is a non-empty string (the
same projection the status chips read — live, paused, and restored-last-run
records all work). On activation: `openTranscript(childSessionId)` and close
the menu. The menu receives only plain entries + a dispatch callback;
availability logic stays in the view.

**Expected outcome.** After any run — or mid-run for a node that already
fired — right-click → Go to transcript lands in the child session's Chat tab
(the `pendingChatView` handoff applies unchanged; from the shell-panel host
the panel dismisses over the transcript). A never-fired node shows the item
disabled. Closing the result modal changes nothing: the menu route is
independent of it.

**Verification.** Typecheck/test/build green. Browser: restore path — reload
a workspace with a finished run, right-click a done node, transcript opens;
fresh run — right-click a running node mid-run, the live transcript opens;
right-click a never-run agent, the item is disabled.

## N3 — Hardening and docs

**Scope.** Pin the remaining interactions: the menu opens only when no
connection gesture is in flight (`connectRef.current === null` — Escape stays
the gesture's cancel path); SSE record updates while the menu is open must
not displace it (the primitive re-places on scroll/resize; entries simply
re-evaluate on re-render); a terminal transition that opens the result modal
closes the menu (clear menu state where `adoptRecord` goes terminal and in
`clearAll`); layering sanity confirmed against the host-styled portal (with
close-on-activation and the terminal close, the menu should never visibly
stack with a modal — verify, don't engineer). Docs: `guide/canvas.md` — a
short "Node context menu" paragraph under "Nodes, ports, and connections"
(actions + the disabled-transcript rule); `guide/running-pipelines.md` — the
Transcript paragraph (~line 250) mentions the node route alongside the result
and inspection modals; this proposal's status line AND its `docs/index.md`
row flip from Planned to Built. Then a final full pass: `pnpm sync`, both
hosts in the browser, handoff wrap-up.

**Expected outcome.** The menu behaves sanely in every canvas state (editing,
gesturing, running, paused, modal open) and the guides describe it as shipped
behavior.

**Verification.** Full `pnpm sync` green; browser pass across both hosts: menu
during a live run (statuses update under the open menu; a mid-run terminal
transition closes it), gesture conflict suppressed, docs read correctly
against the implementation.

## Delta protocol

The living handoff is [node-context-menu.handoff.md](node-context-menu.handoff.md).
Before starting a phase, read it. At the end of a phase, append an entry ONLY
if the implementation materially diverged from this plan — what changed and
why, nothing recoverable from the code. A phase that follows the plan adds
nothing.
