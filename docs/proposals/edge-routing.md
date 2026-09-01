# Edge routing — readable connection lines

**Status: Built** — two iterations shipped. Iteration 1: per-port anchor
slots and the back-edge lane, verified on the Coder → Reviewer loop sample.
Iteration 2 ([below](#iteration-2--ports-on-four-sides)): ports may take any
node edge, and a loop brackets over or under the band per its ports' sides.
General obstacle avoidance remains a recorded non-goal.

## The issue

Connection lines are hard to read on any graph with a back edge (loops are
legal wiring — the `cycle-present` warning is informational). Two rendering
facts cause it:

- **Geometry ignores port names.** Every edge anchors at the node's
  right-middle (out) and left-middle (in) — `outPoint` / `inPoint` in
  `pipeline-view.tsx` — so declared ports (`feedback`, `result`, …) all stack
  on one anchor pair per side.
- **The path is one fixed S-curve beneath the nodes.** `edgePath` draws the
  same bezier for every edge, and the edge SVG layer renders before the node
  divs. A back edge therefore sweeps from the source's right side to the
  target's left side, crossing (or sitting on) the forward edge at the same
  midheight and passing beneath whatever nodes lie in the way. Observed on
  the Coder → Reviewer loop sample: the return line crosses the forward line
  mid-gap.

## Proposal 1 — per-port anchor slots

Each declared input port gets its own tick on the node's left edge and each
declared output port its own tick on the right, laid out top-to-bottom in
declaration order: slot *i* of *k* at `NODE_H · (i+1)/(k+1)` — one declared
port keeps the centered default, so undeclared nodes are unchanged. Edges
anchor at the named port's tick instead of the stacked midpoint, which makes
the wiring legible and removes the overlap.

The gesture model is unchanged: the port tick is the drop zone (the hover
highlight shows on the target's port ticks), and the Connect-ports
picker still selects names. One refinement: drafting from a specific output
tick defaults the picker's source port to that tick.

*(Later iteration — port reveal — supersedes the always-visible-tick part:
ticks now hide at rest and reveal on hover / during a drag, the whole node
became the drop zone, and the drafted wire snaps to the nearest input tick.
See [canvas.md](../guide/canvas.md#nodes-ports-and-connections).)*

## Proposal 2 — back-edge lane

`edgePath` gains one geometric rule: when the target anchor sits left of the
source anchor (a back edge), the bezier is routed through a lane **below the
node band** — control points pushed to the lower node's bottom edge plus
clearance — instead of across the gap. Forward edges keep the current
S-curve; the temp edge during drafting follows the same rule, and a back
edge's label sits on the lane. The rule is geometric (target left of
source), not semantic: any leftward edge gets the lane.

## Scope

Client-only rendering in `pipeline-view.tsx` (+ `canvas.css`). No graph
schema, validation, kernel, or persistence changes. Edges remain under the
node layer; lines that still cross at shallow angles are accepted — only the
under-node sweep and the stacked-anchor overlap are being fixed.

## Iteration 2 — ports on four sides

Iteration 1 still hard-codes "loops go under": the lane is a rule about the
line, not a choice of the author, and two loops in one graph would share the
lane below and overlap each other. The generalization: ports may occupy any
node edge.

- **Ports gain a side.** `InputPortSpec.side` and a per-agent
  `outputPortSides` map (name → side; `outputPorts` stays a name list so the
  kernel's port derivation is untouched). Absent = the side default — inputs
  `left`, outputs `right` — so existing graphs render identically. Purely
  presentational: the executor never reads sides.
- **The cap is a warning, not an error.** At most one port per resolved node
  edge (`agent-port-side-conflict`, `cycle-present`-style): default sides
  already stack multi-port nodes that predate explicit sides — the repo's own
  binding samples and this repo's loop sample would be invalid under an
  error — so overlap renders stacked (iteration 1's slot logic) and the
  warning tells the author how to spread them. Malformed side data (an
  unknown side value, a map key naming an undeclared port) is an error
  (`agent-port-side-invalid`).
- **The arc is driven by both ends.** A clean over/under return needs the
  loop's source and target ports on the SAME vertical edge — top/top runs
  above, bottom/bottom runs below — and renders as an orthogonal bracket (out
  of
  the port, along a lane past the band, straight back into the port's axis,
  the arrowhead landing on that final vertical run; a bezier curling into a
  vertical port reads badly at the tip). Mixed side pairs keep the
  tangent-aware bezier, entering and leaving perpendicular to their edges.
  `edgePath` becomes side-aware accordingly; iteration 1's lane remains the
  fallback for a leftward wire whose ends are both on horizontal edges.
- **The edit panel grows a side select per port row**; output ports move from
  a comma-separated textbox to rows (name + side), assembling back to the
  name list plus the sides map (non-default sides only).

Shipped and verified on the loop sample: Coder's `feedback` input and
Reviewer's `feedback` output on `bottom` — the return edge brackets under the
band, label riding the arc; the two side-conflict warnings clear once the
sides are assigned.
