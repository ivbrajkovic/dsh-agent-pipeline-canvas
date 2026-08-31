// The node context menu: a thin wrapper around the harness `Menu` primitive
// (@deepseek-ai/dsh-client-ui-primitives — a host platform module, required
// from the browser module table). The plugin owns the open point — portal mode
// anchored at a zero-size rect on the pointer — and the entry list comes in as
// plain entries from the view (availability logic stays there); the wrapper
// pins the plan's close-on-activation rule: every entry activation closes the
// menu BEFORE its action runs (Edit agent must not leave the menu floating
// above the config panel it opens). Dismissal (Escape, outside pointerdown)
// and viewport clamping are the primitive's; it also owns and tears down its
// own document/window listeners on close and unmount.
import * as React from "react";
import { Menu } from "@deepseek-ai/dsh-client-ui-primitives";
import type { MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";

/** Where and on whom the menu is open: the agent it targets and the viewport
 * point (clientX/clientY) it opened at — the portal anchors a zero-size rect
 * there. */
export interface NodeMenuTarget {
	agentId: string;
	x: number;
	y: number;
}

export function NodeMenu({ target, entries, onAction, onClose }: {
	target: NodeMenuTarget;
	entries: readonly MenuEntry[];
	/** Runs the entry's action; only reached for enabled rows. */
	onAction: (id: string) => void;
	onClose: () => void;
}) {
	// Rendered only while open, so `open` is a constant: unmount is the close.
	return (
		<Menu
			open
			anchor={null}
			portal
			items={entries}
			onSelect={(id) => { onClose(); onAction(id); }}
			onClose={onClose}
			getAnchorRect={() => new DOMRect(target.x, target.y, 0, 0)}
		/>
	);
}
