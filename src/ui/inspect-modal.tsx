// The paused-run inspection modal: when a run parks at a breakpoint, this shows
// the paused firing's composed input (immutable for the run), its adopted
// output, and the settlement status, and offers the control actions — Resume
// (continue the pipeline with this output), Rerun (a fresh firing with the same
// input), Steer (deliver feedback to the SAME child; it keeps its transcript),
// and Abort (stop the whole run). The node view is the projection of the run's
// firing log (../projection.ts). The Transcript route opens the agent's durable
// child session. Steer requires text; the other buttons are always available
// while paused.
import * as React from "react";
import type { ProjectedNode } from "../projection.ts";
import "./inspect-modal.css";

function InspectModal({
	agentName, node, busy, status, canSteer, onOpenSession,
	onResume, onRerun, onSteer, onAbort, onClose,
}: {
	agentName: string;
	node: ProjectedNode;
	busy: string | null;
	status: string | null;
	/** False on a degraded deployment (no continuable runtime): steering is unavailable. */
	canSteer: boolean;
	onOpenSession: (childSessionId: string) => void;
	onResume: () => void;
	onRerun: () => void;
	onSteer: (feedback: string) => void;
	onAbort: () => void;
	onClose: () => void;
}) {
	const [feedback, setFeedback] = React.useState("");
	function stopKey(e: React.KeyboardEvent) {
		e.stopPropagation();
		if (e.key === "Escape") onClose();
	}
	const stopped = busy !== null;
	return (
		<div className="pipeline-modal-overlay" onPointerDown={(e) => { e.stopPropagation(); }}>
			<div className="pipeline-modal">
				<h3>Paused at {agentName}</h3>
				<div className="pipeline-inspect-meta">
					<span className={"run-status" + (node.stopReason && node.stopReason !== "completed" ? " warn" : "")}>
						{node.stopReason || "settled"}
					</span>
					{node.childSessionId ? (
						<button
							className="pipeline-btn pipeline-btn-mini"
							title="Open this agent's child session — the full transcript"
							disabled={stopped}
							onClick={() => { onOpenSession(node.childSessionId as string); }}
						>Transcript</button>
					) : null}
					<span className="pipeline-inspect-hint">The pipeline is paused before any downstream agent runs.</span>
				</div>
				<div className="modal-row">
					<label>Composed input (fixed for this run)</label>
					<pre className="pipeline-inspect-block">{node.input || "(empty)"}</pre>
				</div>
				<div className="modal-row">
					<label>Output</label>
					<pre className="pipeline-inspect-block">{node.output && node.output.length > 0 ? node.output : "(no output)"}</pre>
					{node.error ? <div className="pipeline-inspect-error">{node.error}</div> : null}
				</div>
				{canSteer ? (
					<div className="modal-row">
						<label>Steer — send feedback to this same agent (it keeps its transcript)</label>
						<textarea
							value={feedback}
							placeholder="What should the agent do differently?"
							onChange={(e) => { setFeedback(e.target.value); }}
							onKeyDown={stopKey}
						/>
					</div>
				) : (
					<div className="pipeline-picker-status">
						Steering is unavailable in this deployment (no continuable subagent runtime); Rerun still works.
					</div>
				)}
				{status ? <div className="pipeline-modal-status">{status}</div> : null}
				<div className="pipeline-modal-actions">
					<button
						className="pipeline-btn pipeline-btn-danger"
						title="Abort the whole run — completed outputs are preserved"
						disabled={stopped}
						onClick={onAbort}
					>Abort</button>
					<span className="pipeline-inspect-spacer" />
					<button className="pipeline-btn" onClick={onClose}>Close</button>
					{canSteer ? (
						<button
							className="pipeline-btn"
							title="Deliver the feedback to this same child and adopt its new answer (stay paused)"
							disabled={stopped || !canSteer || feedback.trim().length === 0}
							onClick={() => { onSteer(feedback); }}
						>{busy === "steer" ? "Steering…" : "Steer"}</button>
					) : null}
					<button
						className="pipeline-btn"
						title="Run this agent again from scratch with the SAME input (a fresh transcript; the old one is kept)"
						disabled={stopped}
						onClick={onRerun}
					>{busy === "rerun" ? "Rerunning…" : "Rerun"}</button>
					<button
						className="pipeline-btn pipeline-btn-run"
						title="Continue the pipeline with the current output"
						disabled={stopped}
						onClick={onResume}
					>{busy === "resume" ? "Resuming…" : "Resume"}</button>
				</div>
			</div>
		</div>
	);
}

export { InspectModal };
