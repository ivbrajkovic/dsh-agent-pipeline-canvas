// The Result modal: the run's terminal outputs, a per-run status strip (with a
// Transcript route into each agent's durable child session), and the continue
// routes. Every route only STAGES text (composer draft) — the user always
// sends it.
import * as React from "react";
import type { RunResultLike, SessionTarget } from "./shared.ts";
import "./result-modal.css";

function ResultModal({ result, names, targets, busy, status, onOpenSession, onContinueChat, onContinueNewSession, onSendTo, onClose }: {
	result: RunResultLike;
	names: Record<string, string>;
	targets: SessionTarget[];
	busy: string | null;
	status: string | null;
	onOpenSession: (childSessionId: string) => void;
	onContinueChat: () => void;
	onContinueNewSession: () => void;
	onSendTo: (sessionId: string) => void;
	onClose: () => void;
}) {
	const [targetId, setTargetId] = React.useState(targets.length > 0 ? targets[0].id : "");
	function stopKey(e: React.KeyboardEvent) {
		e.stopPropagation();
		if (e.key === "Escape") onClose();
	}
	const termName: Record<string, string> = { ...names };
	const outputRows = Object.keys(result.outputs || {}).map((id) => {
		const v = result.outputs![id];
		const txt = typeof v === "string" ? v : JSON.stringify(v, null, 2);
		return (
			<div key={"o-" + id} className="pipeline-result-row">
				<div className="pipeline-result-label">{termName[id] || id}</div>
				<pre className="pipeline-result-value">{txt}</pre>
			</div>
		);
	});
	const canContinue = result.ok === true;
	return (
		<div className="pipeline-modal-overlay" onPointerDown={(e) => { e.stopPropagation(); }}>
			<div className="pipeline-modal">
				<h3>{result.ok ? "Pipeline Result" : "Pipeline Failed"}</h3>
				<div className="pipeline-result">
					{result.ok ? (
						outputRows.length > 0 ? outputRows : (
							<div className="pipeline-result-row">No terminal output.</div>
						)
					) : (
						<div className="pipeline-result-error">
							{result.error || ("graph is invalid: " + (result.validationErrors || []).map((e) => e.message).join("; "))}
						</div>
					)}
					{result.ok && Array.isArray(result.runs) && result.runs.length > 0 ? (
						<div className="pipeline-runs">
							{result.runs.map((r) => (
								<div key={"run-" + r.id} className="pipeline-run-row">
									<span className="run-name">{termName[r.id] || r.id}</span>
									<span className={"run-status" + (r.status && r.status !== "completed" ? " warn" : "")}>{r.status || "?"}</span>
									{r.error ? <span className="run-error" title={r.error}>{r.error}</span> : null}
									{r.childSessionId ? (
										<button
											className="pipeline-btn pipeline-btn-mini"
											title="Open this agent's child session — the full transcript"
											onClick={() => { onOpenSession(r.childSessionId as string); }}
										>Transcript</button>
									) : null}
								</div>
							))}
						</div>
					) : null}
				</div>
				{canContinue ? (
					<div className="modal-row">
						<div className="pipeline-modal-actions" style={{ marginTop: 0 }}>
							<button
								className="pipeline-btn"
								disabled={busy !== null}
								title="Prefill this session's composer with the final output (you send it)"
								onClick={onContinueChat}
							>{busy === "chat" ? "Working…" : "Continue in chat"}</button>
							<button
								className="pipeline-btn"
								disabled={busy !== null}
								title="Create a session in this workspace and prefill its composer (you send it)"
								onClick={onContinueNewSession}
							>{busy === "new" ? "Working…" : "Continue in a new session"}</button>
						</div>
						{targets.length > 0 ? (
							<div className="pipeline-modal-actions" style={{ marginTop: 0 }}>
								<select
									value={targetId}
									onChange={(e) => { setTargetId(e.target.value); }}
									onKeyDown={stopKey}
									aria-label="Target session"
								>
									{targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
								</select>
								<button
									className="pipeline-btn"
									disabled={busy !== null || targetId.length === 0}
									title="Open that session and prefill its composer (you send it)"
									onClick={() => { onSendTo(targetId); }}
								>{busy === "send" ? "Working…" : "Send to session…"}</button>
							</div>
						) : null}
						<div className="pipeline-picker-status">
							Every route only prefills a composer — you review and press send.
						</div>
					</div>
				) : null}
				{status ? <div className="pipeline-modal-status">{status}</div> : null}
				<div className="pipeline-modal-actions">
					<button className="pipeline-btn" onClick={onClose}>Close</button>
				</div>
			</div>
		</div>
	);
}

export { ResultModal };
