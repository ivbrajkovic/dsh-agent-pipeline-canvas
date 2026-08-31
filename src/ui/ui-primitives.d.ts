// Type shim for the host platform module `@deepseek-ai/dsh-client-ui-primitives`.
// The real package is served from the browser module table (deepseek-harness
// web/src/seed.ts seeds it from PLATFORM_MODULES), not installed in this
// standalone plugin, so this file types only the surface this plugin consumes.
// Mirror the source (packages/client/ui-primitives/src/Menu.tsx) when the used
// surface grows.

declare module "@deepseek-ai/dsh-client-ui-primitives" {
	import * as React from "react";

	/** Selectable row (optionally with a nested submenu). */
	export interface MenuItem {
		id: string;
		label: React.ReactNode;
		disabled?: boolean;
		/** Leading icon (figma .Menu_cell gap 8). */
		icon?: React.ReactNode;
		/** Destructive row: error-colored text/icon and danger hover fill. */
		danger?: boolean;
		/** Nested card opened to the right on hover/focus. */
		submenu?: readonly MenuItem[];
	}

	/** Hairline between item groups (not selectable). */
	export interface MenuSeparator {
		type: "separator";
		id: string;
	}

	/** Non-interactive heading row above a group of items. */
	export interface MenuLabel {
		type: "label";
		id: string;
		text: string;
	}

	/** One primary-menu entry: a row, a separator, or a heading label. */
	export type MenuEntry = MenuItem | MenuSeparator | MenuLabel;

	/** Render an anchored dropdown menu (portal mode anchors via getAnchorRect). */
	export function Menu(props: {
		/** Whether the list is showing (owner-controlled). */
		open: boolean;
		/** The trigger element (rendered in place). */
		anchor: React.ReactNode;
		/** Selectable rows and optional separators. */
		items: readonly MenuEntry[];
		/** Rows pinned below the scrolling items area, separated by a hairline. */
		footer?: readonly MenuEntry[];
		/** Row shown as selected. */
		selectedId?: string | undefined;
		/** Rows shown as selected when a menu contains independent option groups. */
		selectedIds?: readonly string[] | undefined;
		/** Row click callback (not called for disabled rows). */
		onSelect: (id: string) => void;
		/** Invoked on outside click or Escape. */
		onClose: () => void;
		/** List alignment against the anchor (default "start"). */
		align?: "start" | "end";
		/** Open below ("bottom", default), above ("top"), or to the right. */
		side?: "bottom" | "top" | "right";
		/** Render the list into document.body, fixed-positioned from the anchor
		 * rect (repositions on scroll/resize while open). */
		portal?: boolean;
		/** Close once the pointer has left both trigger and list for the grace. */
		closeOnPointerLeave?: boolean;
		/** Reduce vertical row spacing without changing typography. */
		dense?: boolean;
		/** Reduced menu typography and spacing. */
		compact?: boolean;
		/** Portal mode only: supply the anchor rect directly instead of measuring
		 * the Menu's own wrapper span. Called on open and on every scroll/resize;
		 * return null to skip placement for that frame. */
		getAnchorRect?: () => DOMRect | null;
		className?: string;
	}): React.ReactElement;
}
