// dsh-agent-pipeline-canvas — browser half (entry).
//
// A TypeScript module bundled into lib/client.js by tsdown (the
// window.__ModuleLoader__.load({ id, factory }) format the browser module
// system consumes). Because tsdown bundles the client from this source tree,
// it can import the canonical validateGraph (via the view) and the shared
// contract types. Pure type shapes are type-only imports (erased before the
// bundle is built), so the browser's module-table require() only ever answers
// the real externally-requested `react` rows.
//
// This module is ONLY the slot registration; the components live in src/ui/
// (one module + one stylesheet per surface, injected as tagged
// <style data-plugin-css> tags by the build's pipeline-css-inline loader —
// see tsdown.config.ts):
//
//   - ui/pipeline-view.tsx — the canvas workspace (rendered by the harness in
//     `conversation.view` for non-blank sessions).
//   - ui/shell-panel.tsx   — the composer tool-row trigger
//     (`conversation.input.left`, rendered on the blank-session Hero too) and
//     the frame-wide `shell.overlay` panel it opens, which renders in EVERY
//     app state and binds to the CURRENT session.
//   - ui/agent-config.tsx  — the agent edit modal (incl. the agent settings,
//     fed by the Host's options route).
//   - ui/run-modal.tsx / ui/result-modal.tsx — the Run dialog and the result +
//     continue-routes modal (see ui/pipeline-view.tsx's run logic and
//     ui/result-modal.tsx).
//   - ui/shared.ts         — constants, structural service views, canvas
//     state shapes, graph serialization.
//
// The view renders the whole node workspace: a palette with a draggable Agent,
// a canvas, node move/select, and output→input connections with directed edges.
//
// Running: the Run button opens an INPUT MODAL (multiline text + workspace
// files attached as ABSOLUTE PATHS via the harness `@`-mention file-reference
// completion or manual entry; contents are never inlined — the first agent
// reads them with its own tools). A run is DURABLE: POST /run starts a run
// executor in the Host process and returns a runId; the view follows the run's
// record over SSE and re-discovers an active run after a reload via the
// pipeline GET's `run` field — runs outlive the tab. Each per-agent breakpoint
// (armed on the node) parks the run before its downstream: an inspection modal
// shows the composed input and the output and offers Resume / Rerun / Steer
// (feedback to the SAME continuable child) / Abort. On a terminal state a
// RESULT MODAL offers the continue routes: "Continue in chat" prefills this
// session's composer via the standard `inputActions` and opens the chat view;
// "Continue in a new session" resolves the pipeline's workspace (cwd match
// first, then the session's own) and opens a session ATTACHED to it via
// `uiWorkspace.connectWorkspace` — so the chat lands in
// `workspace.sessionIds` and shows in the sidebar;
// "Send to session…" prefills another
// session's composer by id. Nothing ever auto-sends — every route stages the
// text and the user presses send. Each run node also carries the agent's
// child session id (`childSessionId`), and both modals offer a Transcript
// route that opens that durable child session — the agent's full transcript.
//
// Per-agent settings: the edit modal's right column holds the settings that
// shape the harness start request (agent options
// provider/model/reasoning-effort/max-tokens, tool filter, delegation depth,
// object-rooted JSON output schema). They are persisted on the agent in
// pipeline.json and forwarded by the runner (see types.ts AgentSettings); a
// structured result is preferred over raw text downstream.
// The system prompt (the harness persona slot) is NOT an override — it is a
// first-class agent field, `Agent.systemPrompt` (see types.ts and
// docs/reference/system-prompt.md).
//
// Persistence: the graph is stored PER SESSION — the view's load GET and
// debounced save POST carry the session id, so each session owns
// `.agent-pipeline/pipelines/<sessionId>.json` (written by the Host half via
// the `/dsh-agent-pipeline` route); the first edit in a session forks that
// file from the legacy workspace-wide `.agent-pipeline/pipeline.json`, which
// keeps serving as the read-through fallback until then. The view
// recovers the session's workspace root (cwd) from the framework standard kit
// (`useSessions`), loads the saved graph on mount, and persists the graph after
// every structural change (add / delete / clear / connect / move). Because the
// view-ring slot only mounts the active tab, switching away would otherwise
// discard the React-local state — persisting to disk makes the pipeline survive
// tab switches, UI reloads, and reopen. If no cwd is known yet, the canvas
// still works in-memory and quietly awaits load/save.

import { PipelineView } from "./ui/pipeline-view.tsx";
import { PipelineComposerTrigger, PipelinePanelEntry } from "./ui/shell-panel.tsx";
import type { PipelineCtx, UseSessions, UseWorkspaces } from "./ui/shared.ts";
import "./ui/shared.css";

// Declared services are BOTH the activation gate (the runner parks the
// package until each provider exists) and the guard allowlist — the dynamic
// ctx proxy rejects property reads of undeclared services, and nested Remote
// namespaces need their own dotted entry (same convention ui-reference uses).
export const inject = ["slots", "sessions", "uiWorkspace", "conversation", "remote", "remote.fileReferences"];

export function apply(ctx: PipelineCtx): void {
	// Capture the services for the view once; the guard proxy resolves each
	// property read at this point, so keep the captured object stable.
	const services = {
		sessions: ctx.sessions,
		uiWorkspace: ctx.uiWorkspace,
		conversation: ctx.conversation,
		remote: ctx.remote,
	};
	ctx.slots.inject("conversation.view", () =>
		ctx.slots.register(
			{ name: "conversation.view", id: "pipeline", order: 30, label: "Pipelines" },
			(props: Record<string, unknown>) => (
				<PipelineView
					sessionId={props.sessionId as string}
					useSessions={props.useSessions as UseSessions}
					useWorkspaces={props.useWorkspaces as UseWorkspaces | undefined}
					inputActions={props.inputActions as { setDraft(text: string): void }}
					openView={props.openView as (view: string, focus: string) => void}
					services={services}
				/>
			)
		)
	);
	ctx.slots.inject("conversation.input.left", () =>
		ctx.slots.register(
			{ name: "conversation.input.left", id: "pipeline-trigger", order: 40 },
			() => <PipelineComposerTrigger />
		)
	);
	ctx.slots.inject("shell.overlay", () =>
		ctx.slots.register(
			{ name: "shell.overlay", id: "pipeline-panel", order: 20 },
			(props: Record<string, unknown>) => (
				<PipelinePanelEntry
					useSessions={props.useSessions as UseSessions | undefined}
					useWorkspaces={props.useWorkspaces as UseWorkspaces | undefined}
					services={services}
				/>
			)
		)
	);
}
