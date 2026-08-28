// ---- Trigger + frame-wide panel: the route that works on a brand-new chat ----
//
// The harness hides the whole conversation session body (header tabs and view
// area included) while a session is blank — a brand-new session therefore
// shows NO Pipelines tab, and a plugin cannot change that gate. The supported
// route is the compact composer tool-row trigger (`conversation.input.left`,
// which the hero variant renders too) opening a panel in `shell.overlay` (the
// documented additive frame-wide surface), which renders in EVERY app state.
// The panel binds to the CURRENT session read off the root `useSessions`
// standard hook (the graph itself is stored per workspace cwd), so composing
// and running work from a brand-new session too — new sessions are born
// attached to a workspace, so the cwd is already known there.
import * as React from "react";
import { PipelineView } from "./pipeline-view.tsx";
import type { PipelineServices, UseSessions, UseWorkspaces } from "./shared.ts";
import "./shell.css";

/** Shared open state between the sidebar trigger and the shell-overlay panel. */
function createPanelGate() {
	let open = false;
	const listeners = new Set<() => void>();
	return {
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		get(): boolean { return open; },
		set(next: boolean): void {
			if (open === next) return;
			open = next;
			listeners.forEach((fn) => fn());
		},
	};
}
const panelGate = createPanelGate();

/** A small two-node flow glyph for the trigger (no icon package in the bundle). */
function PipelineGlyph({ size }: { size: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
			<circle cx={3.5} cy={8} r={2.1} fill="none" stroke="currentColor" strokeWidth={1.5} />
			<path d="M5.6 8h4.8" stroke="currentColor" strokeWidth={1.5} />
			<circle cx={12.5} cy={8} r={2.1} fill="none" stroke="currentColor" strokeWidth={1.5} />
		</svg>
	);
}

/**
 * The composer tool-row trigger (`conversation.input.left`): a compact icon
 * button that opens the frame-wide panel. The tool row renders in the hero
 * variant too, so this is the entry that works on a brand-new (blank) chat —
 * the harness hides the title bar and tab ring there, and it renders nothing
 * else of ours. Stateless: no hooks, so it cannot break the host's render
 * contract.
 */
function PipelineComposerTrigger() {
	return (
		<button
			type="button"
			className="pipeline-input-btn"
			aria-label="Pipelines"
			title="Pipelines"
			onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); }}
			onClick={() => { panelGate.set(true); }}
		>
			<PipelineGlyph size={14} />
		</button>
	);
}

/**
 * The shell-overlay entry: a one-hook gate so the hook count never changes
 * between closed and open renders; the panel body mounts fresh when opened.
 */
function PipelinePanelEntry({ useSessions, useWorkspaces, services }: {
	useSessions?: UseSessions | undefined;
	useWorkspaces?: UseWorkspaces | undefined;
	services?: PipelineServices | undefined;
}) {
	const open = React.useSyncExternalStore(panelGate.subscribe, panelGate.get);
	if (!open) return null;
	return <PipelinePanel useSessions={useSessions} useWorkspaces={useWorkspaces} services={services} />;
}

/** The frame-wide panel hosting the canvas for the CURRENT session. */
function PipelinePanel({ useSessions, useWorkspaces, services }: {
	useSessions?: UseSessions | undefined;
	useWorkspaces?: UseWorkspaces | undefined;
	services?: PipelineServices | undefined;
}) {
	const hasSessions = typeof useSessions === "function";
	const current = hasSessions
		? (useSessions as UseSessions)((s) => (s && s.current) as string | undefined)
		: undefined;
	const cwd = hasSessions
		? (useSessions as UseSessions)((s) => {
			const id = s && s.current;
			if (!id || !s.byId) return undefined;
			const row = s.byId[id];
			return row ? row.cwd : undefined;
		})
		: undefined;
	const close = () => { panelGate.set(false); };
	return (
		<div className="pipeline-shell-backdrop">
			<div className="pipeline-shell" data-pipeline-shell="true">
				<div className="pipeline-shell-head">
					<h4>Pipelines</h4>
					{cwd ? <span className="pipeline-shell-cwd" title={cwd}>{cwd}</span> : null}
					<div className="spacer" />
					<button
						className="pipeline-btn"
						title="Close the pipelines panel"
						onClick={close}
					>Close</button>
				</div>
				{hasSessions && typeof current === "string" && current.length > 0 ? (
					<PipelineView
						sessionId={current}
						useSessions={useSessions as UseSessions}
						useWorkspaces={useWorkspaces}
						services={services}
						onDismiss={close}
					/>
				) : (
					<div className="pipeline-shell-empty">
						{hasSessions
							? "Open a session to compose and run pipelines — the graph is stored per workspace."
							: "The session feed is unavailable here; open the Pipelines tab inside a session instead."}
					</div>
				)}
			</div>
		</div>
	);
}

export { PipelineComposerTrigger, PipelinePanelEntry };
