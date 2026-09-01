window.__ModuleLoader__.load({
	id: "dsh-agent-pipeline-canvas",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region src/execution.ts
		/**
		* Reserved binding/branch field that tests the firing's own per-node sequence
		* instead of the structured record (docs/proposals/loops.md).
		*/
		const COUNT_KEY = "$count";
		/**
		* True for a row that tests a value — everything but the catch-all. A row
		* authored with an empty-string value IS the catch-all (the executor treats
		* it as absent; lowering normalizes it away on serialize). The one predicate
		* behind the catch-all in both row languages: branch rows (controls.ts) and
		* output bindings (evaluateBindings below, and the guard walk in graph.ts).
		*/
		function isValuedRow(row) {
			return row.value !== void 0 && row.value !== "";
		}
		function idOf(value) {
			return value == null ? "" : String(value);
		}
		/** Deterministic byte-order comparison (pure; identical across runtimes). */
		function cmp(a, b) {
			return a < b ? -1 : a > b ? 1 : 0;
		}
		/**
		* Derive the runtime structure of a graph. This is the classification a runner
		* uses to decide what to run, feed, and collect. It is derived purely from the
		* connection topology (source/target), the same view validateGraph uses.
		*
		* @param graph - a value from ``{ agents, connections }``, or null/undefined.
		* @returns the classification: `agents`, `roots`, `terminals`, `orphans`,
		*   `upstream` and `downstream` adjacency (sorted, deduped id lists).
		*/
		function classifyGraph(graph) {
			const asGraph = graph ?? {};
			const agents = Array.isArray(asGraph.agents) ? asGraph.agents : [];
			const connections = Array.isArray(asGraph.connections) ? asGraph.connections : [];
			const agentIds = [];
			const upstreamSet = /* @__PURE__ */ new Map();
			const downstreamSet = /* @__PURE__ */ new Map();
			for (const agent of agents) {
				const rec = agent;
				if (rec == null || typeof agent !== "object") continue;
				const id = idOf(rec.id);
				if (id.length === 0) continue;
				agentIds.push(id);
				upstreamSet.set(id, /* @__PURE__ */ new Set());
				downstreamSet.set(id, /* @__PURE__ */ new Set());
			}
			const known = new Set(agentIds);
			for (const conn of connections) {
				const rec = conn;
				if (rec == null || typeof conn !== "object") continue;
				const source = idOf(rec.source);
				const target = idOf(rec.target);
				if (source.length === 0 || target.length === 0) continue;
				if (!known.has(source) || !known.has(target)) continue;
				if (source === target) continue;
				downstreamSet.get(source)?.add(target);
				upstreamSet.get(target)?.add(source);
			}
			const roots = [];
			const terminals = [];
			const orphans = [];
			const upstream = {};
			const downstream = {};
			for (const id of agentIds) {
				const ups = [...upstreamSet.get(id) ?? /* @__PURE__ */ new Set()].sort(cmp);
				const downs = [...downstreamSet.get(id) ?? /* @__PURE__ */ new Set()].sort(cmp);
				upstream[id] = ups;
				downstream[id] = downs;
				if (ups.length === 0) roots.push(id);
				if (downs.length === 0) terminals.push(id);
				if (ups.length === 0 && downs.length === 0) orphans.push(id);
			}
			return {
				agents: agentIds,
				roots,
				terminals,
				orphans,
				upstream,
				downstream
			};
		}
		/**
		* Compute a deterministic execution order for a graph's agents. Kahn's
		* algorithm: a node becomes ready only once EVERY upstream agent has been
		* emitted — the fan-in "wait for all upstreams" rule — and ready nodes are
		* popped in stable (id) order so the result is independent of connection-array
		* order. The runner executes this order sequentially.
		*
		* @param graph - a value from ``{ agents, connections }``, or null/undefined.
		* @returns the agent ids in a deterministic topological order. A validated
		*   acyclic graph yields every agent; a graph with a cycle truncates here —
		*   the sequential runner runs only the acyclic prefix (cycles are legal
		*   wiring for the stream executor; validateGraph reports them as a
		*   `cycle-present` warning, not an error).
		*/
		function topoOrder(graph) {
			const { agents, upstream, downstream } = classifyGraph(graph);
			const indeg = {};
			for (const id of agents) indeg[id] = upstream[id].length;
			const ready = agents.filter((id) => indeg[id] === 0);
			const order = [];
			while (ready.length > 0) {
				ready.sort(cmp);
				const id = ready.shift();
				order.push(id);
				for (const next of downstream[id]) {
					indeg[next] -= 1;
					if (indeg[next] === 0) ready.push(next);
				}
			}
			return order;
		}
		/**
		* Derive the port-graph view of a graph: per agent, the declared input/output
		* ports (defaults applied) with every edge resolved onto them. This is the
		* shared derivation behind the stream node model — validateGraph consumes it
		* for port-wiring correctness, and the run kernel queues per-port messages
		* from it.
		*
		* Derivation rules:
		*   - `inputPorts` present  → one port per spec, wire id `<agentId>:<name>`;
		*     `outputPorts` present → one port per name, same wire id convention.
		*   - A list ABSENT → the single legacy default: the agent's `input` / `output`
		*     string (which already IS the wire id), else `<id>:in` / `<id>:out`. Old
		*     files keep wiring exactly as before.
		*   - Malformed declarations (non-object specs, empty/non-string names,
		*     non-positive-integer bounds) are skipped or normalized to the default —
		*     validateGraph reports them; this view stays total. Duplicate port names
		*     keep the first occurrence (validation reports the duplicate).
		*   - An edge attaches to a port only when the connection's port string names
		*     that port exactly; unmatched edges drop here (validation reports them as
		*     port mismatches).
		*
		* @param graph - a value from ``{ agents, connections }``, or null/undefined.
		* @returns the port graph: agent ids (array order) and per-agent port views.
		*/
		function portGraph(graph) {
			const asGraph = graph ?? {};
			const agents = Array.isArray(asGraph.agents) ? asGraph.agents : [];
			const connections = Array.isArray(asGraph.connections) ? asGraph.connections : [];
			const ids = [];
			const byId = {};
			for (const agent of agents) {
				const rec = agent;
				if (rec == null || typeof agent !== "object") continue;
				const id = idOf(rec.id);
				if (id.length === 0 || byId[id] !== void 0) continue;
				const node = {
					id,
					inputs: [],
					outputs: [],
					inputById: {},
					outputById: {}
				};
				if (Array.isArray(rec.inputPorts)) {
					const seen = /* @__PURE__ */ new Set();
					for (const spec of rec.inputPorts) {
						const s = spec;
						if (s == null || typeof s !== "object" || typeof s.name !== "string" || s.name.length === 0) continue;
						if (seen.has(s.name)) continue;
						seen.add(s.name);
						const port = {
							name: s.name,
							portId: `${id}:${s.name}`,
							policy: s.policy === "any-of" ? "any-of" : "all-of",
							...typeof s.bound === "number" && Number.isInteger(s.bound) && s.bound >= 1 ? { bound: s.bound } : {},
							edges: [],
							sources: []
						};
						node.inputs.push(port);
						node.inputById[port.portId] = port;
					}
				} else {
					const portId = typeof rec.input === "string" && rec.input.length > 0 ? rec.input : `${id}:in`;
					const port = {
						name: "in",
						portId,
						policy: "all-of",
						edges: [],
						sources: []
					};
					node.inputs.push(port);
					node.inputById[portId] = port;
				}
				if (Array.isArray(rec.outputPorts)) {
					const seen = /* @__PURE__ */ new Set();
					for (const name of rec.outputPorts) {
						if (typeof name !== "string" || name.length === 0) continue;
						if (seen.has(name)) continue;
						seen.add(name);
						const port = {
							name,
							portId: `${id}:${name}`,
							edges: [],
							targets: []
						};
						node.outputs.push(port);
						node.outputById[port.portId] = port;
					}
				} else {
					const portId = typeof rec.output === "string" && rec.output.length > 0 ? rec.output : `${id}:out`;
					const port = {
						name: "out",
						portId,
						edges: [],
						targets: []
					};
					node.outputs.push(port);
					node.outputById[portId] = port;
				}
				byId[id] = node;
				ids.push(id);
			}
			for (const conn of connections) {
				const rec = conn;
				if (rec == null || typeof conn !== "object") continue;
				const sourceNode = byId[idOf(rec.source)];
				const targetNode = byId[idOf(rec.target)];
				if (sourceNode === void 0 || targetNode === void 0) continue;
				const sourcePort = idOf(rec.sourcePort);
				const targetPort = idOf(rec.targetPort);
				const source = sourceNode.id;
				const target = targetNode.id;
				const out = sourceNode.outputById[sourcePort];
				if (out !== void 0) out.edges.push({
					connectionId: idOf(rec.id),
					target,
					targetPort
				});
				const into = targetNode.inputById[targetPort];
				if (into !== void 0) into.edges.push({
					connectionId: idOf(rec.id),
					source,
					sourcePort
				});
			}
			for (const id of ids) {
				const node = byId[id];
				for (const port of node.inputs) port.sources = [...new Set(port.edges.map((e) => e.source))].sort(cmp);
				for (const port of node.outputs) port.targets = [...new Set(port.edges.map((e) => e.target))].sort(cmp);
			}
			return {
				ids,
				byId
			};
		}
		/**
		* Render a value as prompt text: verbatim strings, structured values as JSON.
		* Shared with the message-composition module so the Host prompt framing and
		* the client's result framing render values identically.
		*/
		function renderValue(value) {
			if (typeof value === "string") return value;
			if (value === void 0) return "";
			try {
				return JSON.stringify(value, null, 2);
			} catch {
				return String(value);
			}
		}
		//#endregion
		//#region src/controls.ts
		/** Node edges a branch tick may render on (same vocabulary as graph.ts). */
		const PORT_SIDES$3 = [
			"left",
			"right",
			"top",
			"bottom"
		];
		const DEFAULT_BRANCH_SIDE = "right";
		/** Comparison operators a branch row may declare; absent means "==" (docs/proposals/loops.md). */
		const BRANCH_OPS$1 = ["==", ">="];
		function argStr$1(value) {
			return value == null ? "" : String(value);
		}
		/**
		* The control-aware validation rules, run by validateGraph after the agents
		* pass and before the connections pass (which consumes the returned
		* analysis). Control-specific failures report on the control
		* (`control-invalid` shape/ids, `if-source-invalid` feeding, `if-owner-conflict`
		* emission ownership, `if-branch-invalid` branch rules); non-fatal findings
		* ride `warnings` (`if-side-conflict` side stacking, plus the never-fire
		* warnings for a schema-less or breakpointed source). Only `kind: "if"`
		* controls carry the if rules — a future kind passes the shape checks and
		* owns its own.
		*
		* @param graph - the raw graph value (agents/connections/controls as unknown).
		* @param agentIds - the known agent ids (from validateGraph's agents pass).
		* @param errors - validateGraph's error sink.
		* @param warnings - validateGraph's warning sink.
		* @returns the analysis for graph.ts's endpoint/cycle handling.
		*/
		function validateControls(graph, agentIds, errors, warnings) {
			const ids = /* @__PURE__ */ new Set();
			const sourceByControl = /* @__PURE__ */ new Map();
			const branchNames = /* @__PURE__ */ new Map();
			const raw = graph.controls;
			if (raw == null) return {
				ids,
				sourceByControl,
				branchNames
			};
			if (!Array.isArray(raw)) {
				errors.push({
					code: "control-invalid",
					message: "pipeline 'controls' must be an array"
				});
				return {
					ids,
					sourceByControl,
					branchNames
				};
			}
			const controls = [];
			const seenIds = /* @__PURE__ */ new Set();
			for (const entry of raw) {
				if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
					errors.push({
						code: "control-invalid",
						message: "a control entry is not an object"
					});
					continue;
				}
				const rec = entry;
				const id = rec.id == null ? "" : String(rec.id);
				if (id.length === 0) {
					errors.push({
						code: "control-invalid",
						message: "a control is missing an id"
					});
					continue;
				}
				if (rec.kind == null || String(rec.kind).length === 0) {
					errors.push({
						code: "control-invalid",
						message: `control "${id}" is missing a kind`
					});
					continue;
				}
				if (seenIds.has(id)) {
					errors.push({
						code: "control-invalid",
						message: `duplicate control id "${id}"`
					});
					continue;
				}
				if (agentIds.has(id)) {
					errors.push({
						code: "control-invalid",
						message: `control id "${id}" collides with an agent id — control ids live in their own space`
					});
					continue;
				}
				seenIds.add(id);
				ids.add(id);
				controls.push(entry);
			}
			const agents = Array.isArray(graph.agents) ? graph.agents : [];
			const connections = Array.isArray(graph.connections) ? graph.connections : [];
			const incoming = /* @__PURE__ */ new Map();
			const outgoing = /* @__PURE__ */ new Map();
			for (const conn of connections) {
				if (conn == null || typeof conn !== "object") continue;
				const rec = conn;
				const source = argStr$1(rec.source);
				const target = argStr$1(rec.target);
				if (target.length > 0 && ids.has(target)) incoming.set(target, (incoming.get(target) ?? []).concat([source]));
				if (source.length > 0) outgoing.set(source, (outgoing.get(source) ?? 0) + 1);
			}
			for (const control of controls) {
				const id = control.id;
				if (control.kind !== "if") continue;
				branchNames.set(id, validateBranches(id, control.branches, errors));
				const sources = incoming.get(id) ?? [];
				if (sources.length !== 1) {
					errors.push({
						code: "if-source-invalid",
						message: sources.length === 0 ? `control "${id}" has no incoming connection — exactly one agent must feed it` : `control "${id}" has ${sources.length} incoming connections — exactly one agent must feed it`
					});
					continue;
				}
				const source = sources[0];
				if (ids.has(source)) {
					errors.push({
						code: "if-source-invalid",
						message: `control "${id}" is fed by another control ("${source}") — control-to-control chaining is not supported`
					});
					continue;
				}
				if (!agentIds.has(source)) continue;
				sourceByControl.set(id, source);
				const owner = findAgent(agents, source);
				if (owner !== void 0) {
					validateOwner(id, source, owner, outgoing, errors);
					warnUnreachable(id, source, owner, control.branches, warnings);
				}
				warnSideConflict(id, control.branches, warnings);
			}
			return {
				ids,
				sourceByControl,
				branchNames
			};
		}
		/**
		* One control's branch rules: at least one branch; unique non-empty names;
		* every valued branch carries a non-empty `field`; at most one catch-all and
		* only as the last branch; a known side; a known op (`==`/`>=` — a `>=` row's
		* value must coerce to a finite number). Returns the declared branch names —
		* reported even on a branch that failed another rule, so a connection naming
		* it is not double-reported.
		*/
		function validateBranches(controlId, branches, errors) {
			if (!Array.isArray(branches) || branches.length === 0) {
				errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" has no branches — add at least one`
				});
				return [];
			}
			const names = [];
			const seen = /* @__PURE__ */ new Set();
			branches.forEach((entry, index) => {
				if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
					errors.push({
						code: "if-branch-invalid",
						message: `control "${controlId}" branch #${index + 1} is not an object`
					});
					return;
				}
				const branch = entry;
				const name = argStr$1(branch.name);
				const label = name.length > 0 ? `"${name}"` : `#${index + 1}`;
				if (name.length === 0) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" branch #${index + 1} has no name`
				});
				else if (seen.has(name)) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" declares branch "${name}" more than once`
				});
				else {
					seen.add(name);
					names.push(name);
				}
				if (isValuedRow(branch) && (typeof branch.field !== "string" || branch.field.length === 0)) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" branch ${label} compares a value but names no field`
				});
				if (!isValuedRow(branch) && index < branches.length - 1) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" branch ${label} is a catch-all but not last — the catch-all must be the final branch`
				});
				if (branch.side !== void 0 && !PORT_SIDES$3.includes(branch.side)) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" branch ${label} has an unknown side "${argStr$1(branch.side)}" (expected "left", "right", "top" or "bottom")`
				});
				if (branch.op !== void 0 && !BRANCH_OPS$1.includes(branch.op)) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" branch ${label} has an unknown op "${argStr$1(branch.op)}" (expected "==" or ">=")`
				});
				if (branch.op === ">=" && !Number.isFinite(Number(branch.value))) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" branch ${label} compares with ">=" but its value is not a finite number`
				});
			});
			return names;
		}
		/**
		* The if OWNS its source agent's entire emission surface: the source declares
		* no `outputPorts`/`bindings` of its own and feeds exactly this one control
		* with no other outgoing edges.
		*/
		function validateOwner(controlId, sourceId, owner, outgoing, errors) {
			if (owner.outputPorts !== void 0) errors.push({
				code: "if-owner-conflict",
				message: `agent "${sourceId}" declares its own output ports but feeds control "${controlId}" — the if owns the agent's whole emission surface; clear the agent's output ports`
			});
			if (owner.bindings !== void 0) errors.push({
				code: "if-owner-conflict",
				message: `agent "${sourceId}" declares its own output bindings but feeds control "${controlId}" — the if owns the agent's whole emission surface; clear the agent's bindings`
			});
			const count = outgoing.get(sourceId) ?? 0;
			if (count > 1) errors.push({
				code: "if-owner-conflict",
				message: `agent "${sourceId}" feeds control "${controlId}" but has ${count} outgoing connections — an if's source feeds exactly that one control and nothing else`
			});
		}
		/**
		* Non-fatal: the branches can never fire when the source lacks
		* `settings.outputSchema` (content bindings evaluate only against a structured
		* result) or is breakpointed (a continuable child produces none). The
		* no-schema warning is SUPPRESSED when every valued branch is a `$count` row —
		* counter rows test the firing's sequence, not the record, so they can fire
		* without a schema (docs/proposals/loops.md). It still fires when the control
		* has no valued branch at all: a bare catch-all needs a structured result, so
		* the warning stays accurate there. The breakpointed warning always stays —
		* accurate for content rows, stale only for `$count` rows (L4's docs reword it).
		*/
		function warnUnreachable(controlId, sourceId, owner, branches, warnings) {
			if (owner.breakpoint === true) warnings.push({
				code: "if-source-breakpointed",
				message: `control "${controlId}" feeds from breakpointed agent "${sourceId}" — a continuable child cannot produce structured output, so its branches can never fire`
			});
			const settings = owner.settings;
			const schema = settings != null && typeof settings === "object" ? settings.outputSchema : void 0;
			if ((schema === void 0 || schema === null) && !countsOnly(branches)) warnings.push({
				code: "if-source-no-schema",
				message: `control "${controlId}" feeds from agent "${sourceId}" which has no settings.outputSchema — its branches compare a structured result, so they can never fire`
			});
		}
		/** True when at least one branch is valued and every valued branch tests `$count`. */
		function countsOnly(branches) {
			if (!Array.isArray(branches)) return false;
			let valued = 0;
			for (const entry of branches) {
				if (entry == null || typeof entry !== "object") continue;
				const branch = entry;
				if (!isValuedRow(branch)) continue;
				valued += 1;
				if (branch.field !== "$count") return false;
			}
			return valued > 0;
		}
		/**
		* Non-fatal (mirrors `agent-port-side-conflict`): two or more branches of one
		* control resolve to the same node edge; the control renders the stack.
		*/
		function warnSideConflict(controlId, branches, warnings) {
			if (!Array.isArray(branches)) return;
			const bySide = /* @__PURE__ */ new Map();
			for (const entry of branches) {
				if (entry == null || typeof entry !== "object") continue;
				const branch = entry;
				const name = argStr$1(branch.name);
				if (name.length === 0) continue;
				const side = branch.side === void 0 ? DEFAULT_BRANCH_SIDE : String(branch.side);
				bySide.set(side, (bySide.get(side) ?? []).concat([name]));
			}
			for (const [side, names] of bySide) if (names.length > 1) warnings.push({
				code: "if-side-conflict",
				message: `control "${controlId}" puts more than one branch on the ${side} edge: ${names.join(", ")} — they render stacked; assign distinct sides to spread them`
			});
		}
		/** Read one agent record out of the raw agents array by id (first match). */
		function findAgent(agents, id) {
			for (const agent of agents) {
				if (agent == null || typeof agent !== "object") continue;
				if (argStr$1(agent.id) === id) return agent;
			}
		}
		/**
		* Lower an honest graph (controls as nodes) onto the port/binding mechanics
		* the kernel already runs: for control `K` with source agent `A`, `A` gains
		* `K.branches[].name` as its `outputPorts` and the branch rules as its
		* `bindings`, every connection `K:<branch> → T:<port>` becomes
		* `A:<branch> → T:<port>` (the sourcePort wire id re-prefixed), and `K` —
		* with its feeding edge — is dropped. The result is exactly the graph a
		* hand-authored ports+bindings twin would be:
		*
		*   - a branch authored `value: ""` lowers to a binding with NO `value` key
		*     (the executor's catch-all test is `value === undefined`, so a literal
		*     empty string would compare against "" and never catch);
		*   - a `>=` branch forwards its `op` into the binding (the key drops for
		*     `==`/absent — the house convention for non-defaults; `$count` fields
		*     pass through untouched);
		*   - non-default branch sides forward into `A`'s `outputPortSides`, the map
		*     omitted when it would be empty (the house convention);
		*   - the `controls` key is absent from the result (it is never persisted).
		*
		* TOTAL over malformed records: a hand-edited control normalizes or skips,
		* never throws — the resurrection path re-enters run() without validation.
		* A graph without controls lowers to itself.
		*/
		function lowerControls(graph) {
			if (graph == null || typeof graph !== "object" || Array.isArray(graph)) return {
				agents: [],
				connections: []
			};
			const raw = graph.controls;
			if (!Array.isArray(raw) || raw.length === 0) return graph;
			const agentsRaw = Array.isArray(graph.agents) ? graph.agents : [];
			const connectionsRaw = Array.isArray(graph.connections) ? graph.connections : [];
			const agentIds = /* @__PURE__ */ new Set();
			for (const agent of agentsRaw) {
				const id = agent != null && typeof agent === "object" ? argStr$1(agent.id) : "";
				if (id.length > 0 && !agentIds.has(id)) agentIds.add(id);
			}
			const controlIds = /* @__PURE__ */ new Set();
			for (const entry of raw) {
				const id = entry != null && typeof entry === "object" ? argStr$1(entry.id) : "";
				if (id.length > 0) controlIds.add(id);
			}
			const firstAgentSource = (controlId) => {
				for (const conn of connectionsRaw) {
					if (conn == null || typeof conn !== "object") continue;
					const rec = conn;
					if (argStr$1(rec.target) !== controlId) continue;
					const source = argStr$1(rec.source);
					if (source.length > 0 && agentIds.has(source)) return source;
				}
				return null;
			};
			const lowerings = /* @__PURE__ */ new Map();
			for (const entry of raw) {
				if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
				const control = entry;
				const id = argStr$1(control.id);
				if (id.length === 0 || control.kind !== "if") continue;
				const owner = firstAgentSource(id);
				if (owner === null) continue;
				const outputPorts = [];
				const bindings = [];
				const sides = {};
				for (const branch of Array.isArray(control.branches) ? control.branches : []) {
					if (branch == null || typeof branch !== "object") continue;
					const spec = branch;
					const name = argStr$1(spec.name);
					if (name.length === 0) continue;
					outputPorts.push(name);
					const branchValue = spec.value;
					const valued = isValuedRow(spec);
					const field = typeof spec.field === "string" && spec.field.length > 0 ? spec.field : null;
					const op = spec.op === ">=" ? { op: spec.op } : {};
					const binding = field !== null ? valued ? {
						field,
						port: name,
						value: branchValue,
						...op
					} : {
						field,
						port: name,
						...op
					} : valued ? {
						port: name,
						value: branchValue,
						...op
					} : {
						port: name,
						...op
					};
					bindings.push(binding);
					if (spec.side !== void 0 && PORT_SIDES$3.includes(spec.side) && spec.side !== DEFAULT_BRANCH_SIDE) sides[name] = spec.side;
				}
				lowerings.set(id, {
					owner,
					outputPorts,
					bindings,
					sides
				});
			}
			const owners = /* @__PURE__ */ new Map();
			for (const lowering of lowerings.values()) if (!owners.has(lowering.owner)) owners.set(lowering.owner, lowering);
			const agents = agentsRaw.map((agent) => {
				const id = agent != null && typeof agent === "object" ? argStr$1(agent.id) : "";
				const lowering = owners.get(id);
				if (lowering === void 0 || agent == null || typeof agent !== "object") return agent;
				const clone = {
					...agent,
					outputPorts: [...lowering.outputPorts],
					bindings: lowering.bindings.map((b) => ({ ...b }))
				};
				if (Object.keys(lowering.sides).length > 0) clone.outputPortSides = { ...lowering.sides };
				else delete clone.outputPortSides;
				return clone;
			});
			const connections = [];
			for (const conn of connectionsRaw) {
				if (conn == null || typeof conn !== "object") continue;
				const rec = conn;
				const source = argStr$1(rec.source);
				const target = argStr$1(rec.target);
				if (controlIds.has(target)) continue;
				const lowering = lowerings.get(source);
				if (lowering !== void 0) {
					const prefix = source + ":";
					const branchPart = typeof rec.sourcePort === "string" && rec.sourcePort.startsWith(prefix) ? rec.sourcePort.slice(prefix.length) : null;
					connections.push({
						...conn,
						source: lowering.owner,
						...branchPart !== null ? { sourcePort: lowering.owner + ":" + branchPart } : {}
					});
					continue;
				}
				if (controlIds.has(source)) continue;
				connections.push(conn);
			}
			return {
				agents,
				connections
			};
		}
		/**
		* The branches one source-agent firing CHOSE, from the firing's `emittedTo`
		* (the P7 kernel's emission record). Lowering maps each branch onto an output
		* port of the SAME name, so `emittedTo`'s port names are the branch names;
		* intersecting with the declared branches keeps a drifted or hand-edited graph
		* honest — a port the control never declared reports no branch. Returns the
		* chosen names in declaration order. Total over malformed input, and `[]` is
		* also the no-selection answer: the caller distinguishes "decided quiet" from
		* "not yet decided" by whether the firing carries an `emittedTo` at all, not
		* by this return value.
		*/
		function firedBranches(branches, emittedTo) {
			if (!Array.isArray(emittedTo)) return [];
			const chosen = new Set(emittedTo.map(argStr$1).filter((name) => name.length > 0));
			if (chosen.size === 0) return [];
			return (Array.isArray(branches) ? branches.map((branch) => branch != null && typeof branch === "object" ? argStr$1(branch.name) : "").filter((name) => name.length > 0) : []).filter((name) => chosen.has(name));
		}
		/**
		* The loop budget a control's branches declare, for the run view's iteration
		* display (docs/proposals/loops.md L4): the first valued `$count >=` row
		* whose value coerces to a finite number. `==` count rows are deliberately
		* not read as a budget (guard analysis is shape-only — whether a row matches
		* a run is data, not shape), a valueless row is the catch-all rather than a
		* threshold, and the malformed `>=` shapes validation reports simply parse to
		* nothing. Null when no threshold parses — the diamond then shows a plain
		* `iter N`. Total over malformed input; never throws.
		*/
		function countThreshold(branches) {
			if (!Array.isArray(branches)) return null;
			for (const entry of branches) {
				if (entry == null || typeof entry !== "object") continue;
				const row = entry;
				if (row.field !== "$count" || row.op !== ">=" || !isValuedRow(row)) continue;
				const threshold = Number(row.value);
				if (Number.isFinite(threshold)) return threshold;
			}
			return null;
		}
		//#endregion
		//#region src/graph.ts
		/** Input-port delivery policies a spec may declare. */
		const PORT_POLICIES = ["all-of", "any-of"];
		/** Comparison ops a binding may declare; absent means "==" (same vocabulary as controls.ts). */
		const BINDING_OPS = ["==", ">="];
		/** Node edges a port may render on (edge-routing iteration 2; geometry only). */
		const PORT_SIDES$2 = [
			"left",
			"right",
			"top",
			"bottom"
		];
		const DEFAULT_INPUT_SIDE = "left";
		const DEFAULT_OUTPUT_SIDE = "right";
		/**
		* Validate a pipeline graph against the port-graph contract above.
		*
		* @param graph - a value from ``{ agents, connections }``, or null/undefined
		*   (an absent pipeline is valid: there is simply nothing to run).
		* @returns `{ ok, errors, warnings? }` where `ok` is true only when `errors`
		*   is empty. Each error/warning is `{ code, message }`; `code` is a stable
		*   discriminator (link of the class of problem) and `message` is a
		*   human-readable, targeted string (e.g. which agent / connection / port is
		*   at fault). `warnings` carries non-fatal findings (`cycle-present`) and is
		*   present only when non-empty.
		*/
		function validateGraph(graph) {
			const errors = [];
			const warnings = [];
			if (graph == null) return {
				ok: true,
				errors
			};
			if (typeof graph !== "object" || Array.isArray(graph)) {
				errors.push({
					code: "graph-invalid",
					message: "pipeline must be an object with agents and connections"
				});
				return {
					ok: false,
					errors
				};
			}
			const asGraph = graph;
			if (asGraph.agents != null && !Array.isArray(asGraph.agents)) errors.push({
				code: "agents-not-array",
				message: "pipeline 'agents' must be an array"
			});
			if (asGraph.connections != null && !Array.isArray(asGraph.connections)) errors.push({
				code: "connections-not-array",
				message: "pipeline 'connections' must be an array"
			});
			const agents = Array.isArray(asGraph.agents) ? asGraph.agents : [];
			const connections = Array.isArray(asGraph.connections) ? asGraph.connections : [];
			const agentIds = /* @__PURE__ */ new Set();
			for (const agent of agents) {
				if (agent == null || typeof agent !== "object") {
					errors.push({
						code: "agent-invalid",
						message: "an agent entry is not an object"
					});
					continue;
				}
				const rec = agent;
				const id = rec.id == null ? "" : String(rec.id);
				if (id.length === 0) {
					errors.push({
						code: "agent-missing-id",
						message: "an agent is missing an id"
					});
					continue;
				}
				if (agentIds.has(id)) {
					errors.push({
						code: "agent-duplicate-id",
						message: `duplicate agent id "${id}"`
					});
					continue;
				}
				agentIds.add(id);
				if (rec.input != null && (typeof rec.input !== "string" || rec.input.length === 0)) errors.push({
					code: "agent-port-invalid",
					message: `agent "${id}" has an invalid input port`
				});
				if (rec.output != null && (typeof rec.output !== "string" || rec.output.length === 0)) errors.push({
					code: "agent-port-invalid",
					message: `agent "${id}" has an invalid output port`
				});
				validatePortDeclarations(id, rec, errors, warnings);
			}
			const analysis = validateControls(asGraph, agentIds, errors, warnings);
			const ports = portGraph(graph);
			for (const agent of agents) {
				if (agent == null || typeof agent !== "object") continue;
				const rec = agent;
				if (rec.bindings === void 0) continue;
				const id = rec.id == null ? "" : String(rec.id);
				const declared = ports.byId[id]?.outputs.map((p) => p.name) ?? [];
				if (!Array.isArray(rec.bindings)) {
					errors.push({
						code: "agent-binding-invalid",
						message: `agent "${id}" has an invalid bindings declaration (must be an array)`
					});
					continue;
				}
				rec.bindings.forEach((entry, index) => {
					const binding = entry;
					const field = binding != null && typeof binding === "object" && typeof binding.field === "string" ? binding.field : "";
					if (field.length === 0) {
						errors.push({
							code: "agent-binding-invalid",
							message: `agent "${id}" has an output binding without a field (binding #${index + 1})`
						});
						return;
					}
					const port = binding != null && typeof binding === "object" && typeof binding.port === "string" ? binding.port : "";
					if (port.length === 0) {
						errors.push({
							code: "agent-binding-invalid",
							message: `agent "${id}" binding "${field}" names no output port`
						});
						return;
					}
					const op = binding != null && typeof binding === "object" ? binding.op : void 0;
					if (op !== void 0 && !BINDING_OPS.includes(op)) {
						errors.push({
							code: "agent-binding-invalid",
							message: `agent "${id}" binding "${field}" has an unknown op "${argStr(op)}" (expected "==" or ">=")`
						});
						return;
					}
					if (op === ">=" && !Number.isFinite(Number(binding?.value))) {
						errors.push({
							code: "agent-binding-invalid",
							message: `agent "${id}" binding "${field}" compares with ">=" but its value is not a finite number`
						});
						return;
					}
					if (!declared.includes(port)) errors.push({
						code: "agent-binding-port-mismatch",
						message: `agent "${id}" binding "${field}" targets port "${port}" but "${id}" declares output ports: ${declared.length > 0 ? declared.join(", ") : "none"}`
					});
				});
			}
			for (const agent of agents) {
				if (agent == null || typeof agent !== "object") continue;
				const rec = agent;
				if (!Array.isArray(rec.bindings)) continue;
				const id = rec.id == null ? "" : String(rec.id);
				const node = ports.byId[id];
				if (node === void 0) continue;
				const selected = new Set(rec.bindings.map((b) => b != null && typeof b === "object" ? argStr(b.port) : "").filter((p) => p.length > 0));
				for (const port of node.outputs) {
					if (port.edges.length === 0 || selected.has(port.name)) continue;
					warnings.push({
						code: "agent-port-unselected",
						message: `agent "${id}" output port "${port.name}" is wired to ${port.targets.length} downstream node${port.targets.length === 1 ? "" : "s"} but no binding row selects it — bindings are first-match, so those wires never carry a message; add a binding row targeting "${port.name}"`
					});
				}
			}
			const seenEdges = /* @__PURE__ */ new Set();
			for (const conn of connections) {
				if (conn == null || typeof conn !== "object") {
					errors.push({
						code: "connection-invalid",
						message: "a connection entry is not an object"
					});
					continue;
				}
				const rec = conn;
				const source = argStr(rec.source);
				const target = argStr(rec.target);
				const sourcePort = argStr(rec.sourcePort);
				const targetPort = argStr(rec.targetPort);
				if (source.length === 0) errors.push({
					code: "connection-missing-source",
					message: "a connection is missing a source agent"
				});
				if (target.length === 0) errors.push({
					code: "connection-missing-target",
					message: "a connection is missing a target agent"
				});
				const sourceIsControl = !agentIds.has(source) && analysis.ids.has(source);
				const targetIsControl = !agentIds.has(target) && analysis.ids.has(target);
				const hasSource = source.length > 0 && (agentIds.has(source) || sourceIsControl);
				const hasTarget = target.length > 0 && (agentIds.has(target) || targetIsControl);
				if (source.length > 0 && !hasSource) errors.push({
					code: "connection-source-missing",
					message: `connection references unknown source agent "${source}"`
				});
				if (target.length > 0 && !hasTarget) errors.push({
					code: "connection-target-missing",
					message: `connection references unknown target agent "${target}"`
				});
				if (source.length > 0 && target.length > 0 && source === target) errors.push({
					code: "connection-self",
					message: `connection ${source} -> ${target} connects an agent to itself`
				});
				const srcNode = hasSource && !sourceIsControl ? ports.byId[source] : void 0;
				const tgtNode = hasTarget && !targetIsControl ? ports.byId[target] : void 0;
				if (sourceIsControl) {
					const declared = analysis.branchNames.get(source) ?? [];
					const prefix = source + ":";
					const branch = sourcePort.startsWith(prefix) ? sourcePort.slice(prefix.length) : "";
					if (!declared.includes(branch)) errors.push({
						code: "if-edge-port-unknown",
						message: `connection from control "${source}" uses source port "${sourcePort}" but the control declares branches: ${declared.length > 0 ? declared.join(", ") : "none"}`
					});
				} else if (hasSource) {
					if (sourcePort.length === 0) errors.push({
						code: "connection-missing-source-port",
						message: `connection from "${source}" is missing a source port`
					});
					else if (srcNode === void 0 || srcNode.outputById[sourcePort] === void 0) {
						const declared = srcNode ? srcNode.outputs.map((p) => p.portId).join(", ") : "";
						errors.push({
							code: "connection-source-port-mismatch",
							message: `connection from "${source}" uses source port "${sourcePort}" but "${source}" declares output ports: ${declared.length > 0 ? declared : "none"}`
						});
					}
				}
				if (targetIsControl) {
					if (targetPort.length > 0) errors.push({
						code: "if-edge-port-unknown",
						message: `connection to control "${target}" names a target port ("${targetPort}") — a control takes a single unnamed input; drop the target port`
					});
				} else if (hasTarget) {
					if (targetPort.length === 0) errors.push({
						code: "connection-missing-target-port",
						message: `connection to "${target}" is missing a target port`
					});
					else if (tgtNode === void 0 || tgtNode.inputById[targetPort] === void 0) {
						const declared = tgtNode ? tgtNode.inputs.map((p) => p.portId).join(", ") : "";
						errors.push({
							code: "connection-target-port-mismatch",
							message: `connection to "${target}" uses target port "${targetPort}" but "${target}" declares input ports: ${declared.length > 0 ? declared : "none"}`
						});
					}
				}
				if (source.length > 0 && target.length > 0) {
					const key = `${source}\u0000${target}\u0000${sourcePort}\u0000${targetPort}`;
					if (seenEdges.has(key)) errors.push({
						code: "connection-duplicate",
						message: `duplicate connection ${source} -> ${target}`
					});
					seenEdges.add(key);
				}
			}
			const walk = walkCycles(agentIds, lowerControls(asGraph), connections);
			if (walk.firstCycle.length > 0) warnings.push({
				code: "cycle-present",
				message: `pipeline contains a cycle: ${walk.firstCycle.join(" -> ")} — legal wiring for the stream executor, but the sequential runner only runs its acyclic prefix`
			});
			if (walk.unguarded !== void 0) errors.push({
				code: "cycle-unguarded",
				message: walk.unguarded
			});
			for (const message of walk.entryWarnings) warnings.push({
				code: "cycle-entry-all-of",
				message
			});
			return {
				ok: errors.length === 0,
				errors,
				...warnings.length > 0 ? { warnings } : {}
			};
		}
		function argStr(value) {
			return value == null ? "" : String(value);
		}
		/**
		* Validate one agent's `inputPorts` / `outputPorts` declarations: lists when
		* present; each input port a spec with a non-empty string name, a known policy
		* ("all-of" | "any-of") and — when present — a positive-integer bound and a
		* known side; each output port a non-empty string name; names unique within
		* their list; `outputPortSides` (when present) a name→side map over the
		* declared output ports. Malformed side data is an error. The side cap — at
		* most one port of a node per DIRECTION per resolved side (an input and an
		* output may share an edge; two of the same direction stack) — is a WARNING,
		* `cycle-present`-style: default sides stack multi-port nodes that predate
		* explicit sides, the canvas renders the stack, and the warning tells the
		* author how to spread the ports.
		*/
		function validatePortDeclarations(id, rec, errors, warnings) {
			if (rec.inputPorts !== void 0) {
				if (!Array.isArray(rec.inputPorts)) errors.push({
					code: "agent-port-invalid",
					message: `agent "${id}" has an invalid inputPorts declaration (must be an array)`
				});
				else {
					const seen = /* @__PURE__ */ new Set();
					for (const spec of rec.inputPorts) {
						const s = spec;
						if (s == null || typeof s !== "object" || Array.isArray(s) || typeof s.name !== "string" || s.name.length === 0) {
							errors.push({
								code: "agent-port-invalid",
								message: `agent "${id}" has an input port without a name`
							});
							continue;
						}
						if (seen.has(s.name)) {
							errors.push({
								code: "agent-port-duplicate",
								message: `agent "${id}" declares input port "${s.name}" more than once`
							});
							continue;
						}
						seen.add(s.name);
						if (s.policy !== void 0 && !PORT_POLICIES.includes(s.policy)) errors.push({
							code: "agent-port-policy-invalid",
							message: `agent "${id}" input port "${s.name}" has an unknown policy "${argStr(s.policy)}" (expected "all-of" or "any-of")`
						});
						if (s.bound !== void 0 && (typeof s.bound !== "number" || !Number.isInteger(s.bound) || s.bound < 1)) {
							const shown = typeof s.bound === "number" ? String(s.bound) : JSON.stringify(s.bound);
							errors.push({
								code: "agent-port-bound-invalid",
								message: `agent "${id}" input port "${s.name}" has an invalid bound ${shown} (must be a positive integer)`
							});
						}
						if (s.side !== void 0 && !PORT_SIDES$2.includes(s.side)) errors.push({
							code: "agent-port-side-invalid",
							message: `agent "${id}" input port "${s.name}" has an unknown side "${argStr(s.side)}" (expected "left", "right", "top" or "bottom")`
						});
					}
				}
			}
			if (rec.outputPorts !== void 0) {
				if (!Array.isArray(rec.outputPorts)) errors.push({
					code: "agent-port-invalid",
					message: `agent "${id}" has an invalid outputPorts declaration (must be an array)`
				});
				else {
					const seen = /* @__PURE__ */ new Set();
					for (const name of rec.outputPorts) {
						if (typeof name !== "string" || name.length === 0) {
							errors.push({
								code: "agent-port-invalid",
								message: `agent "${id}" has an output port without a name`
							});
							continue;
						}
						if (seen.has(name)) {
							errors.push({
								code: "agent-port-duplicate",
								message: `agent "${id}" declares output port "${name}" more than once`
							});
							continue;
						}
						seen.add(name);
					}
				}
			}
			if (rec.outputPortSides !== void 0) {
				if (rec.outputPortSides == null || typeof rec.outputPortSides !== "object" || Array.isArray(rec.outputPortSides)) errors.push({
					code: "agent-port-side-invalid",
					message: `agent "${id}" has an invalid outputPortSides declaration (must be an object of port name → side)`
				});
				else {
					const declared = Array.isArray(rec.outputPorts) ? new Set(rec.outputPorts.filter((n) => typeof n === "string" && n.length > 0)) : /* @__PURE__ */ new Set();
					for (const [name, side] of Object.entries(rec.outputPortSides)) {
						if (!PORT_SIDES$2.includes(side)) errors.push({
							code: "agent-port-side-invalid",
							message: `agent "${id}" output port "${name}" has an unknown side "${argStr(side)}" (expected "left", "right", "top" or "bottom")`
						});
						if (!declared.has(name)) errors.push({
							code: "agent-port-side-invalid",
							message: `agent "${id}" outputPortSides names "${name}" but its declared output ports are: ${declared.size > 0 ? [...declared].join(", ") : "none"}`
						});
					}
				}
			}
			const byDirSide = /* @__PURE__ */ new Map();
			const take = (dir, side, port) => {
				const key = dir + ":" + side;
				byDirSide.set(key, (byDirSide.get(key) ?? []).concat([port]));
			};
			if (Array.isArray(rec.inputPorts)) for (const spec of rec.inputPorts) {
				const s = spec;
				if (s != null && typeof s === "object" && typeof s.name === "string" && s.name.length > 0) take("in", s.side === void 0 ? DEFAULT_INPUT_SIDE : String(s.side), s.name);
			}
			else take("in", DEFAULT_INPUT_SIDE, "in");
			if (Array.isArray(rec.outputPorts)) {
				const sides = rec.outputPortSides != null && typeof rec.outputPortSides === "object" && !Array.isArray(rec.outputPortSides) ? rec.outputPortSides : {};
				for (const name of rec.outputPorts) {
					if (typeof name !== "string" || name.length === 0) continue;
					take("out", sides[name] === void 0 ? DEFAULT_OUTPUT_SIDE : String(sides[name]), name);
				}
			} else take("out", DEFAULT_OUTPUT_SIDE, "out");
			for (const [key, ports] of byDirSide) if (ports.length > 1) {
				const at = key.indexOf(":");
				const dir = key.slice(0, at);
				const side = key.slice(at + 1);
				warnings.push({
					code: "agent-port-side-conflict",
					message: `agent "${id}" puts more than one ${dir} port on the ${side} edge: ${ports.join(", ")} — they render stacked; assign distinct sides to spread them`
				});
			}
		}
		/**
		* The guard walk over a LOWERED graph (lowerControls output): find a cycle;
		* if it carries a guard, exclude its guard hop and repeat until no cycle
		* remains or an unguarded one is found — every directed cycle must carry its
		* own guard, and one guard does not cover a second, disjoint cycle. All
		* discovered cycles feed the `cycle-entry-all-of` scan. Total over malformed
		* declarations: unresolvable edges and missing ports never resolve to a
		* guard, and are otherwise invisible (the passes above report them).
		*
		* @param agentIds - the known agent ids (the walk's node universe).
		* @param lowered - the lowered graph (agents and connections only; controls
		*   are gone).
		* @param honestConnections - the HONEST graph's raw connections array, used
		*   to keep honest self-connections out of the walk (they are reported as
		*   `connection-self` once); only the self-loops LOWERING introduces — a
		*   branch wired back to its own feeder — join the walk, matched by
		*   connection id.
		* @returns the walk findings; never throws.
		*/
		function walkCycles(agentIds, lowered, honestConnections) {
			const ports = portGraph(lowered);
			const bindingsByAgent = /* @__PURE__ */ new Map();
			for (const agent of Array.isArray(lowered.agents) ? lowered.agents : []) {
				if (agent == null || typeof agent !== "object") continue;
				const id = argStr(agent.id);
				const bindings = agent.bindings;
				if (id.length > 0 && Array.isArray(bindings) && !bindingsByAgent.has(id)) bindingsByAgent.set(id, bindings);
			}
			const honestSelfIds = /* @__PURE__ */ new Set();
			for (const conn of honestConnections) {
				if (conn == null || typeof conn !== "object") continue;
				const rec = conn;
				const source = argStr(rec.source);
				if (source.length > 0 && source === argStr(rec.target)) honestSelfIds.add(argStr(rec.id));
			}
			const adjacency = /* @__PURE__ */ new Map();
			for (const id of agentIds) adjacency.set(id, []);
			for (const conn of Array.isArray(lowered.connections) ? lowered.connections : []) {
				if (conn == null || typeof conn !== "object") continue;
				const rec = conn;
				const source = argStr(rec.source);
				const target = argStr(rec.target);
				if (!agentIds.has(source) || !agentIds.has(target)) continue;
				if (source === target && honestSelfIds.has(argStr(rec.id))) continue;
				adjacency.get(source)?.push(target);
			}
			const seenEntries = /* @__PURE__ */ new Set();
			const entryWarnings = [];
			let firstCycle = [];
			let unguarded;
			for (;;) {
				const cycle = findCycleIn(agentIds, adjacency);
				if (cycle.length === 0) break;
				if (firstCycle.length === 0) firstCycle = cycle;
				collectEntryWarnings(cycle, ports, seenEntries, entryWarnings);
				const guard = cycleGuard(cycle, ports, bindingsByAgent);
				if (!guard.guarded) {
					unguarded = `pipeline contains an unguarded cycle: ${cycle.join(" -> ")} — every loop needs a budget: add a bound to the input port one of its hops enters, or put a valued $count row ahead of every row that wires back into the loop${guard.finding !== void 0 ? ` — ${guard.finding}` : ""}`;
					break;
				}
				const [u, v] = guard.hop;
				adjacency.set(u, (adjacency.get(u) ?? []).filter((t) => t !== v));
			}
			return {
				firstCycle,
				...unguarded !== void 0 ? { unguarded } : {},
				entryWarnings
			};
		}
		/**
		* Detect a directed cycle over a ready-built adjacency and return it as a
		* closed path `[a, b, c, a]` (last == first), or [] when none remains. The
		* DFS is the original findCycle's (WHITE/GRAY/BLACK stack walk); the
		* adjacency construction was lifted out so the guard walk can repeat past
		* guarded cycles and so the lowered graph's one-node cycles (a branch wired
		* back to its own feeder — a self-edge on the lowered graph) are visible.
		*/
		function findCycleIn(agentIds, adjacency) {
			const WHITE = 0, GRAY = 1, BLACK = 2;
			const color = /* @__PURE__ */ new Map();
			for (const id of agentIds) color.set(id, WHITE);
			const stackPath = [];
			function visit(node) {
				color.set(node, GRAY);
				stackPath.push(node);
				for (const next of adjacency.get(node) ?? []) {
					if (color.get(next) === GRAY) {
						const start = stackPath.indexOf(next);
						return stackPath.slice(start).concat([next]);
					}
					if (color.get(next) === WHITE) {
						const found = visit(next);
						if (found.length > 0) return found;
					}
				}
				stackPath.pop();
				color.set(node, BLACK);
				return [];
			}
			for (const id of agentIds) if (color.get(id) === WHITE) {
				const found = visit(id);
				if (found.length > 0) return found;
			}
			return [];
		}
		/**
		* The guard test for one cycle path `[a…k, a]`, per docs/proposals/loops.md:
		* (a) some hop (u → v) of the path where every connection u → v lands on an
		* input port of v declaring a `bound` — the delivery-cap mechanics, sound by
		* construction; or (b) a valued `$count` row on a path node whose port wires
		* nowhere on the cycle, positioned before every row that does. First guard
		* wins; the message names rows only when (b) found misplaced candidates.
		*/
		function cycleGuard(cycle, ports, bindingsByAgent) {
			for (let i = 0; i < cycle.length - 1; i++) {
				const u = cycle[i];
				const v = cycle[i + 1];
				if (hopBound(u, v, ports)) return {
					guarded: true,
					hop: [u, v]
				};
			}
			return countEscapeGuard(cycle, ports, bindingsByAgent);
		}
		/**
		* True when the hop u → v is bound-guarded: every connection u → v that
		* resolves lands on an input port of v declaring a `bound`. "Every" is
		* load-bearing — the kernel delivers over each connection independently, so a
		* bound port sharing its hop with an unbounded parallel edge caps nothing.
		* Connections whose ports do not resolve are invisible here (they never
		* deliver; the connections pass reports them).
		*/
		function hopBound(u, v, ports) {
			const node = ports.byId[v];
			if (node === void 0) return false;
			let edges = 0;
			for (const port of node.inputs) for (const edge of port.edges) {
				if (edge.source !== u) continue;
				edges += 1;
				if (port.bound === void 0) return false;
			}
			return edges > 0;
		}
		/**
		* The `$count` escape (guard test (b)): a VALUED `$count` row on a path node
		* whose port wires nowhere on the cycle, positioned before every row that
		* does. Both clauses are load-bearing: a count row shadowed by a row above it
		* that wires back into the cycle never fires (`verdict == fix` above
		* `$count >= 3`), and a count row aimed back INTO the cycle re-matches every
		* firing from the threshold on — neither guards; the finding names the rows.
		* A row whose port wires nowhere guards: from the threshold on the count row
		* matches FIRST (first-match-wins), so the rows below it that loop go quiet —
		* the escape needs to stop the loop-back rows, not to go anywhere. The walk
		* excludes the producer's outgoing hop on the path (that edge is what goes
		* quiet at the threshold).
		*/
		function countEscapeGuard(cycle, ports, bindingsByAgent) {
			const pathNodes = new Set(cycle);
			const wiresInto = (nodeId, portName) => {
				const port = ports.byId[nodeId]?.outputs.find((p) => p.name === portName);
				return port !== void 0 && port.edges.some((edge) => pathNodes.has(edge.target));
			};
			let finding;
			for (const nodeId of cycle.slice(0, -1)) {
				const rows = bindingsByAgent.get(nodeId) ?? [];
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i];
					if (row == null || typeof row !== "object" || row.field !== "$count") continue;
					if (!isValuedRow(row)) continue;
					const label = `the $count row "${argStr(row.port)}" on "${nodeId}"`;
					if (wiresInto(nodeId, argStr(row.port))) {
						finding ??= `${label} wires back into the loop — it re-matches every iteration instead of escaping it`;
						continue;
					}
					let shadower = -1;
					for (let j = 0; j < i; j++) {
						const above = rows[j];
						if (above == null || typeof above !== "object") continue;
						if (wiresInto(nodeId, argStr(above.port))) {
							shadower = j;
							break;
						}
					}
					if (shadower >= 0) {
						finding ??= `${label} sits below row "${argStr(rows[shadower].port)}", which wires back into the loop and shadows it`;
						continue;
					}
					return {
						guarded: true,
						hop: [nodeId, cycle[cycle.indexOf(nodeId) + 1]]
					};
				}
			}
			return {
				guarded: false,
				...finding !== void 0 ? { finding } : {}
			};
		}
		/**
		* The seed-once deadlock, one `cycle-entry-all-of` warning per starved entry
		* port: a cycle node's input port under the default all-of policy that
		* receives an edge from the cycle AND wires at least one more source. all-of
		* is per-SOURCE (the P3 firing rule): a source beyond the loop-back delivers
		* once and is consumed, so from then on the port can never hold a message
		* from every source again — the loop body never fires. When BOTH sources lie
		* on cycles the warning can over-fire (both deliver per iteration); the
		* `any-of` advice stays safe either way. `any-of` is the fix, and the
		* message says so. Deduplicated per port across the walk's cycles.
		*/
		function collectEntryWarnings(cycle, ports, seen, out) {
			const pathNodes = new Set(cycle);
			for (const nodeId of new Set(cycle)) {
				const node = ports.byId[nodeId];
				if (node === void 0) continue;
				for (const port of node.inputs) {
					if (port.policy !== "all-of") continue;
					if (port.sources.length < 2) continue;
					if (!port.sources.some((source) => pathNodes.has(source))) continue;
					const key = `${nodeId}\u0000${port.portId}`;
					if (seen.has(key)) continue;
					seen.add(key);
					out.push(`agent "${nodeId}" input port "${port.portId}" sits on a cycle (${cycle.join(" -> ")}) and receives from ${port.sources.length} sources (${port.sources.join(", ")}) under the default all-of policy — all-of waits for every wired source, and a source beyond the loop-back delivers once and is consumed, so the loop body can never fire; set the port's policy to "any-of"`);
				}
			}
		}
		/**
		* The backward-edge assist's decision (loops L3): does adding this connection
		* close a directed cycle, and which target input port must flip to "any-of"?
		*
		* Cycle detection runs on the lowered form of the honest graph PLUS the
		* prospective connection (lowerControls — the same contraction the run path
		* applies), so a control's branch edge is judged as the owner-agent edge it
		* becomes. The drop closes a cycle exactly when its target can reach its
		* source WITHOUT it — walkCycles reports the first cycle of a graph, not
		* whether a given hop joins one, so the after-graph alone cannot tell a
		* loop-closing back edge from an unrelated wire dropped into an
		* already-cyclic graph (the multi-loop canvases this feature enables); the
		* reachability probe below is the minimal exact consumer of the same lowered
		* machinery.
		*
		* The flip follows the pinned policy: the default entry is declared as
		* `inputPorts: [{ name: "in", policy: "any-of" }]` only when the entered wire
		* id IS the agent's default in-port — a hand-edited legacy `input` string
		* resolves to a different port id, and declaring `inputPorts` there would
		* orphan the existing wiring (skip the flip; the warning speaks) — else the
		* entered declared port's policy set to "any-of" in place (bound and side
		* preserved). A port already at "any-of" needs no flip.
		*
		* Total over malformed input: anything unresolved returns
		* `{ closesCycle: false }`, never throws.
		*
		* @param graph - the HONEST graph in its persisted shape (wire-id ports,
		*   controls allowed) WITHOUT the prospective connection.
		* @param connection - the prospective connection in the same persisted shape
		*   (a control-targeted edge carries no targetPort, a control-sourced one
		*   names its branch as sourcePort).
		*/
		function cycleClosingFlip(graph, connection) {
			if (graph == null || typeof graph !== "object" || Array.isArray(graph)) return { closesCycle: false };
			if (connection == null || typeof connection !== "object") return { closesCycle: false };
			const honest = graph;
			const conn = connection;
			const connId = argStr(conn.id);
			const target = argStr(conn.target);
			if (connId.length === 0 || argStr(conn.source).length === 0 || target.length === 0) return { closesCycle: false };
			const agentIds = /* @__PURE__ */ new Set();
			collectIds(honest.agents, agentIds);
			const after = lowerControls({
				...honest,
				connections: [...Array.isArray(honest.connections) ? honest.connections : [], connection]
			});
			let hopSource = "";
			let hopTarget = "";
			for (const c of Array.isArray(after.connections) ? after.connections : []) {
				if (c == null || typeof c !== "object") continue;
				const rec = c;
				if (argStr(rec.id) !== connId) continue;
				hopSource = argStr(rec.source);
				hopTarget = argStr(rec.target);
				break;
			}
			if (hopSource.length === 0 || hopTarget.length === 0 || !agentIds.has(hopSource) || !agentIds.has(hopTarget)) return { closesCycle: false };
			if (!(hopSource === hopTarget || reaches(lowerControls(honest), hopTarget, hopSource))) return { closesCycle: false };
			const targetNode = portGraph(graph).byId[target];
			if (targetNode === void 0) return { closesCycle: true };
			const wireId = argStr(connection.targetPort) || target + ":in";
			const port = targetNode.inputById[wireId];
			if (port === void 0 || port.policy === "any-of") return { closesCycle: true };
			const rec = agentRecord(honest, target);
			if (rec === void 0) return { closesCycle: true };
			if (Array.isArray(rec.inputPorts)) {
				const prefix = target + ":";
				const name = wireId.startsWith(prefix) ? wireId.slice(prefix.length) : null;
				if (name === null) return { closesCycle: true };
				let hit = false;
				const inputPorts = rec.inputPorts.map((spec) => {
					if (spec == null || typeof spec !== "object" || argStr(spec.name) !== name) return spec;
					hit = true;
					return {
						...spec,
						policy: "any-of"
					};
				});
				return hit ? {
					closesCycle: true,
					inputPorts
				} : { closesCycle: true };
			}
			const legacy = typeof rec.input === "string" && rec.input.length > 0 ? rec.input : target + ":in";
			if (wireId !== target + ":in" || legacy !== target + ":in") return { closesCycle: true };
			return {
				closesCycle: true,
				inputPorts: [{
					name: port.name,
					policy: "any-of"
				}]
			};
		}
		/** Collect the non-empty string ids of one raw record array into `into` (the shared shape behind the graph walks' node universes). */
		function collectIds(records, into) {
			for (const entry of Array.isArray(records) ? records : []) {
				if (entry == null || typeof entry !== "object") continue;
				const id = argStr(entry.id);
				if (id.length > 0) into.add(id);
			}
		}
		/** Adjacency (source -> targets) over a connections array; with `ids`, only edges whose both endpoints are known. */
		function adjacencyOver(connections, ids) {
			const adjacency = /* @__PURE__ */ new Map();
			for (const conn of Array.isArray(connections) ? connections : []) {
				if (conn == null || typeof conn !== "object") continue;
				const rec = conn;
				const source = argStr(rec.source);
				const next = argStr(rec.target);
				if (source.length === 0 || next.length === 0) continue;
				if (ids !== null && (!ids.has(source) || !ids.has(next))) continue;
				adjacency.set(source, (adjacency.get(source) ?? []).concat([next]));
			}
			return adjacency;
		}
		/** The nodes reachable from `start` in one or more hops (start included only via a cycle back to it). */
		function reachableFrom(adjacency, start) {
			const seen = /* @__PURE__ */ new Set();
			const queue = [...adjacency.get(start) ?? []];
			while (queue.length > 0) {
				const node = queue.shift();
				if (seen.has(node)) continue;
				seen.add(node);
				queue.push(...adjacency.get(node) ?? []);
			}
			return seen;
		}
		/** True when `to` is reachable from `from` over the lowered graph's connections. */
		function reaches(lowered, from, to) {
			return reachableFrom(adjacencyOver(lowered.connections, null), from).has(to);
		}
		/** Read one agent record out of the graph's agents array by id (first match). */
		function agentRecord(graph, id) {
			for (const agent of Array.isArray(graph.agents) ? graph.agents : []) {
				if (agent == null || typeof agent !== "object") continue;
				if (argStr(agent.id) === id) return agent;
			}
		}
		/**
		* The control ids lying on at least one directed cycle of the HONEST graph —
		* the canvas's membership test for the run view's iteration display
		* (docs/proposals/loops.md L4: an if on a cycle shows the loop's iteration).
		* A control lies on a cycle exactly when the drawn graph can walk back to it
		* (feeder → control → branch → … → feeder); a feeder that sits on some other
		* loop does not pull its control in, and a branch aimed into an unrelated
		* cycle does not either — participation, not presence (the cycleClosingFlip
		* precedent). Lowering contracts each such cycle onto the feeder, so every
		* cycle found here is one the kernel really runs. Total over malformed
		* declarations; never throws.
		*/
		function loopControlIds(graph) {
			const out = /* @__PURE__ */ new Set();
			if (graph == null || typeof graph !== "object" || Array.isArray(graph)) return out;
			const raw = graph.controls;
			if (!Array.isArray(raw)) return out;
			const known = /* @__PURE__ */ new Set();
			collectIds(graph.agents, known);
			collectIds(raw, known);
			const adjacency = adjacencyOver(graph.connections, known);
			for (const entry of Array.isArray(raw) ? raw : []) {
				if (entry == null || typeof entry !== "object") continue;
				const id = argStr(entry.id);
				if (id.length > 0 && reachableFrom(adjacency, id).has(id)) out.add(id);
			}
			return out;
		}
		/**
		* The agent ids lying on at least one directed cycle of the LOWERED graph —
		* the canvas's membership test for the branch editor's shadowing diagnosis
		* (which branches wire back into a loop). Lowered self-loops count (a branch
		* wired back to its own feeder is a real one-node cycle the kernel runs), and
		* so would an honest self-connection, which validateGraph refuses separately.
		* Total over malformed declarations; never throws.
		*/
		function cycleNodeIds(graph) {
			const lowered = lowerControls(graph);
			const ids = /* @__PURE__ */ new Set();
			collectIds(lowered.agents, ids);
			const adjacency = adjacencyOver(lowered.connections, ids);
			const onCycle = /* @__PURE__ */ new Set();
			for (const id of ids) if (reachableFrom(adjacency, id).has(id)) onCycle.add(id);
			return onCycle;
		}
		/** True when `value` is one of the four node edges. */
		function isPortSide(value) {
			return value === "left" || value === "right" || value === "top" || value === "bottom";
		}
		function sideOr(side, fallback) {
			return isPortSide(side) ? side : fallback;
		}
		/** One agent record's declared input ports with resolved sides (junk skipped; an absent list means the implicit default). */
		function declaredInputSpecs(rec) {
			const list = rec.inputPorts;
			if (!Array.isArray(list)) return [];
			const out = [];
			for (const spec of list) {
				if (spec == null || typeof spec !== "object") continue;
				const name = argStr(spec.name);
				if (name.length === 0) continue;
				out.push({
					name,
					side: sideOr(spec.side, DEFAULT_INPUT_SIDE)
				});
			}
			return out;
		}
		/** One agent record's declared output ports with resolved sides (junk skipped; an absent list means the implicit default). */
		function declaredOutputNames(rec) {
			const list = rec.outputPorts;
			if (!Array.isArray(list)) return [];
			const sides = rec.outputPortSides != null && typeof rec.outputPortSides === "object" && !Array.isArray(rec.outputPortSides) ? rec.outputPortSides : {};
			const out = [];
			for (const entry of list) {
				if (typeof entry !== "string" || entry.length === 0) continue;
				out.push({
					name: entry,
					side: sideOr(sides[entry], DEFAULT_OUTPUT_SIDE)
				});
			}
			return out;
		}
		/**
		* The input port NAME living on one node edge of an agent record — the first
		* declared port resolving there, the implicit "in" on the default edge of an
		* undeclared node, or null when the edge is open (a drop there mints one).
		* Shared by the canvas's snap ring and the drop resolution, so the preview
		* and the commit can never disagree.
		*/
		function inputPortOnSide(agent, side) {
			if (agent == null || typeof agent !== "object") return null;
			const rec = agent;
			if (!Array.isArray(rec.inputPorts)) return side === DEFAULT_INPUT_SIDE ? "in" : null;
			for (const port of declaredInputSpecs(rec)) if (port.side === side) return port.name;
			return null;
		}
		/**
		* The output port NAME living on one node edge of an agent record — same
		* reading as inputPortOnSide with the output defaults (implicit "out" on the
		* right edge of an undeclared node).
		*/
		function outputPortOnSide(agent, side) {
			if (agent == null || typeof agent !== "object") return null;
			const rec = agent;
			if (!Array.isArray(rec.outputPorts)) return side === DEFAULT_OUTPUT_SIDE ? "out" : null;
			for (const port of declaredOutputNames(rec)) if (port.side === side) return port.name;
			return null;
		}
		/** A minted port name: the base (the edge's own name is the honest default), numbered when taken. */
		function mintPortName(base, taken) {
			if (!taken.has(base)) return base;
			for (let i = 2;; i++) {
				const candidate = base + "-" + i;
				if (!taken.has(candidate)) return candidate;
			}
		}
		/** One control record's declared branch names (the control's output vocabulary). */
		function controlBranchNames(graph, id) {
			for (const entry of Array.isArray(graph.controls) ? graph.controls : []) {
				if (entry == null || typeof entry !== "object") continue;
				if (argStr(entry.id) !== id) continue;
				const branches = entry.branches;
				if (!Array.isArray(branches)) return [];
				return branches.map((b) => b != null && typeof b === "object" ? argStr(b.name) : "").filter((n) => n.length > 0);
			}
			return [];
		}
		/**
		* The wire-drop resolution (the four-point model's whole brain). Given the
		* honest graph WITHOUT the wire and where the wire was grabbed/dropped:
		*
		* - Source side: the grabbed tick pins the port; else the first declared
		*   output on the grabbed edge; else one is MINTED — named after the edge
		*   ("top"/"bottom"/"left"; "out" on the default right edge), numbered when
		*   taken, declared in `outputPorts` (+ `outputPortSides` for non-default
		*   edges) in the same update. Minting onto an undeclared node declares the
		*   default "out" too — a present list REPLACES the default, and the right
		*   point must keep working.
		* - Target side (agent targets): the first declared input on the landed edge,
		*   else a minted `{ name, side }` spec — with the same declare-the-default
		*   rule for `inputPorts`. A control target resolves to nothing (it owns no
		*   input port) and patches nothing.
		* - The cycle-entry flip (cycleClosingFlip) is folded in: it runs on the
		*   graph WITH the minted declarations and the prospective wire, so a
		*   cycle-closing drop that mints its own entry port flips THAT port to
		*   any-of; a control-sourced edge answers through its owner exactly as the
		*   kernel will run it.
		*
		* Total over malformed input: unresolved ids return `{ agentUpdates: {} }`,
		* never throws. The graph argument is always the canvas's buildGraph output —
		* the default in-port is composed as `<id>:in` there, and hand-edited legacy
		* `input` strings never reach canvas state (loadAgent drops them) — so this
		* resolution needs no legacy-wire-id guard of its own; the folded
		* cycleClosingFlip keeps its own guard, being a public helper that also
		* answers over persisted shapes.
		*/
		function resolveWireDrop(graph, draft) {
			const out = { agentUpdates: {} };
			if (graph == null || typeof graph !== "object" || Array.isArray(graph)) return out;
			if (draft == null || typeof draft !== "object") return out;
			const g = graph;
			const d = draft;
			const source = argStr(d.source);
			const target = argStr(d.target);
			if (source.length === 0 || target.length === 0) return out;
			const controlIds = /* @__PURE__ */ new Set();
			collectIds(g.controls, controlIds);
			const sourceRec = agentRecord(g, source);
			const targetRec = agentRecord(g, target);
			const sourceIsControl = sourceRec === void 0 && controlIds.has(source);
			const targetIsControl = targetRec === void 0 && controlIds.has(target);
			if (!sourceIsControl && sourceRec === void 0) return out;
			if (!targetIsControl && targetRec === void 0) return out;
			const updates = out.agentUpdates;
			if (sourceIsControl) {
				const branches = controlBranchNames(g, source);
				const grabbed = argStr(d.grabbedSourcePort);
				const picked = grabbed.length > 0 && branches.includes(grabbed) ? grabbed : branches[0];
				if (picked !== void 0 && picked.length > 0) out.sourcePort = picked;
			} else {
				const rec = sourceRec;
				const grabbed = argStr(d.grabbedSourcePort);
				const declaredNames = new Set(declaredOutputNames(rec).map((p) => p.name));
				const grabsDefault = grabbed === "out" && !Array.isArray(rec.outputPorts);
				if (grabbed.length > 0 && (declaredNames.has(grabbed) || grabsDefault)) out.sourcePort = grabbed;
				else {
					const side = sideOr(d.sourceSide, DEFAULT_OUTPUT_SIDE);
					const onSide = outputPortOnSide(rec, side);
					if (onSide !== null) out.sourcePort = onSide;
					else {
						const name = mintPortName(side === DEFAULT_OUTPUT_SIDE ? "out" : side, declaredNames);
						out.sourcePort = name;
						const patch = updates[source] ?? {};
						if (Array.isArray(rec.outputPorts)) patch.outputPorts = [...rec.outputPorts.filter((n) => typeof n === "string" && n.length > 0), name];
						else patch.outputPorts = ["out", name];
						if (side !== DEFAULT_OUTPUT_SIDE) patch.outputPortSides = {
							...rec.outputPortSides != null && typeof rec.outputPortSides === "object" && !Array.isArray(rec.outputPortSides) ? rec.outputPortSides : {},
							[name]: side
						};
						updates[source] = patch;
					}
				}
			}
			if (!targetIsControl) {
				const rec = targetRec;
				const side = sideOr(d.targetSide, DEFAULT_INPUT_SIDE);
				const onSide = inputPortOnSide(rec, side);
				if (onSide !== null) out.targetPort = onSide;
				else {
					const taken = new Set(declaredInputSpecs(rec).map((p) => p.name));
					const name = mintPortName(side === DEFAULT_INPUT_SIDE ? "in" : side, taken);
					out.targetPort = name;
					const spec = {
						name,
						...side !== DEFAULT_INPUT_SIDE ? { side } : {}
					};
					const patch = updates[target] ?? {};
					if (Array.isArray(rec.inputPorts)) patch.inputPorts = [...rec.inputPorts, spec];
					else patch.inputPorts = [{ name: "in" }, spec];
					updates[target] = patch;
				}
			}
			const afterAgents = (Array.isArray(g.agents) ? g.agents : []).map((a) => {
				const id = a != null && typeof a === "object" ? argStr(a.id) : "";
				const patch = id.length > 0 ? updates[id] : void 0;
				return patch !== void 0 ? {
					...a,
					...patch
				} : a;
			});
			const connection = {
				id: "wire-prospective",
				source,
				target,
				sourcePort: source + ":" + (out.sourcePort ?? "out"),
				...targetIsControl ? {} : { targetPort: target + ":" + (out.targetPort ?? "in") }
			};
			const flip = cycleClosingFlip({
				agents: afterAgents,
				connections: g.connections,
				controls: g.controls
			}, connection);
			if (flip.inputPorts !== void 0 && !targetIsControl) {
				const patch = updates[target] ?? {};
				patch.inputPorts = flip.inputPorts;
				updates[target] = patch;
			}
			return out;
		}
		/**
		* The unwire retraction (the mint's other half): after a connection goes
		* away, each endpoint port it used that now wires nowhere — and carries
		* nothing the author shaped — is retracted, so the honest graph never
		* accumulates invisible declarations behind deleted wires.
		*
		* A port survives when it still wires somewhere; when a binding row names it
		* (an emission target is behavior); or — on the input side — when it declares
		* a `bound` (a loop budget is deliberate numeric authoring; silently
		* deleting numbers is never right). Everything else retracts, including an
		* assist-flipped any-of policy: the flip existed for its wire, and re-drawing
		* the loop re-flips. Retraction canonicalizes back to the historical shape
		* when only a plain default remains (`outputPorts: ["out"]` still rendering
		* right, a bare `[{ name: "in" }]`) — the undeclared form the graph would
		* have had all along. An output port's side-map entry goes with it.
		*
		* Connection records are read tolerantly (wire-id or bare port names — the
		* canvas state and the persisted shape both work). Only the passed
		* connections' endpoints are touched; the graph is the AFTER-REMOVAL state.
		*/
		function retractOrphanPorts(graphAfter, removed) {
			const out = { agentUpdates: {} };
			if (graphAfter == null || typeof graphAfter !== "object" || Array.isArray(graphAfter)) return out;
			const g = graphAfter;
			const controlIds = /* @__PURE__ */ new Set();
			collectIds(g.controls, controlIds);
			const uses = [];
			for (const conn of removed) {
				if (conn == null || typeof conn !== "object") continue;
				const rec = conn;
				const source = argStr(rec.source);
				const target = argStr(rec.target);
				if (source.length === 0 && target.length === 0) continue;
				const sourceRaw = argStr(rec.sourcePort);
				const targetRaw = argStr(rec.targetPort);
				const sourceName = sourceRaw.startsWith(source + ":") ? sourceRaw.slice(source.length + 1) : sourceRaw.length > 0 ? sourceRaw : "out";
				const targetName = targetRaw.startsWith(target + ":") ? targetRaw.slice(target.length + 1) : targetRaw.length > 0 ? targetRaw : "in";
				if (source.length > 0 && !controlIds.has(source)) uses.push({
					agent: source,
					dir: "out",
					name: sourceName
				});
				if (target.length > 0 && !controlIds.has(target)) uses.push({
					agent: target,
					dir: "in",
					name: targetName
				});
			}
			if (uses.length === 0) return out;
			const ports = portGraph(graphAfter);
			const working = /* @__PURE__ */ new Map();
			const stateOf = (agentId) => {
				const rec = agentRecord(g, agentId);
				if (rec === void 0) return null;
				let state = working.get(agentId);
				if (state !== void 0) return state;
				const sidesRaw = rec.outputPortSides;
				state = {
					rec,
					specs: Array.isArray(rec.inputPorts) ? rec.inputPorts : null,
					outs: Array.isArray(rec.outputPorts) ? rec.outputPorts.filter((n) => typeof n === "string" && n.length > 0) : null,
					sides: sidesRaw != null && typeof sidesRaw === "object" && !Array.isArray(sidesRaw) ? Object.entries(sidesRaw).filter((e) => isPortSide(e[1])) : []
				};
				working.set(agentId, state);
				return state;
			};
			for (const use of uses) {
				const node = ports.byId[use.agent];
				if (node === void 0) continue;
				const state = stateOf(use.agent);
				if (state === null) continue;
				const patch = out.agentUpdates[use.agent] ?? {};
				if (use.dir === "out") {
					const port = node.outputs.find((p) => p.name === use.name);
					if (port === void 0 || port.edges.length > 0) continue;
					if ((Array.isArray(state.rec.bindings) ? state.rec.bindings : []).some((b) => b != null && typeof b === "object" && argStr(b.port) === use.name)) continue;
					if (state.outs === null) continue;
					if (!state.outs.includes(use.name)) continue;
					const keptOuts = state.outs.filter((n) => n !== use.name);
					const keptSides = state.sides.filter(([n]) => n !== use.name);
					patch.outputPorts = keptOuts.length === 1 && keptOuts[0] === "out" && !keptSides.some(([n, s]) => n === "out" && s !== DEFAULT_OUTPUT_SIDE) || keptOuts.length === 0 ? void 0 : keptOuts;
					patch.outputPortSides = keptSides.length > 0 ? Object.fromEntries(keptSides) : void 0;
					state.outs = keptOuts;
					state.sides = keptSides;
				} else {
					const port = node.inputs.find((p) => p.name === use.name);
					if (port === void 0 || port.edges.length > 0) continue;
					if (state.specs === null) continue;
					const hit = state.specs.find((s) => s != null && typeof s === "object" && argStr(s.name) === use.name);
					if (hit === void 0) continue;
					if (typeof hit.bound === "number") continue;
					const keptSpecs = state.specs.filter((s) => !(s != null && typeof s === "object" && argStr(s.name) === use.name));
					patch.inputPorts = keptSpecs.length === 1 && keptSpecs[0] != null && typeof keptSpecs[0] === "object" && argStr(keptSpecs[0].name) === "in" && keptSpecs[0].policy === void 0 && keptSpecs[0].bound === void 0 && keptSpecs[0].side === void 0 || keptSpecs.length === 0 ? void 0 : keptSpecs;
					state.specs = keptSpecs;
				}
				out.agentUpdates[use.agent] = patch;
			}
			return out;
		}
		//#endregion
		//#region src/projection.ts
		/**
		* Deterministic FIRING-ID order, numeric on the id suffix ("f-999" < "f-1000"
		* — the P5 scrutiny note: lexicographic order flips past 999, and loops can
		* exceed that). Ids without a numeric tail (or with equal tails) fall back to
		* byte order, so the result stays total and stable over malformed ids.
		*/
		function compareFiringIds(a, b) {
			const ma = /(\d+)$/.exec(a);
			const mb = /(\d+)$/.exec(b);
			if (ma !== null && mb !== null) {
				const delta = parseInt(ma[1], 10) - parseInt(mb[1], 10);
				if (delta !== 0) return delta;
			}
			return a < b ? -1 : a > b ? 1 : 0;
		}
		/**
		* Every firing with `status` that no later firing of the same node supersedes,
		* in firing-id order — the log's unresolved work of that kind. For "paused"
		* these are the settled-but-unresolved breakpoints: the pending-pause queue
		* the UI surfaces and the executor's crash-safe rebuild re-parks (the shared
		* derivation keeps the displayed depth and the rebuilt head from drifting).
		* For "running" these are the firings that were in flight when the process
		* died, which a resumed run must re-fire (executor spec §3). Total over
		* malformed entries (a projection must never be the thing that breaks a
		* render).
		*/
		function unresolvedFirings(firings, status) {
			const all = firings.filter((f) => f !== null && typeof f === "object");
			const superseded = (f) => all.some((later) => later.nodeId === f.nodeId && typeof later.seq === "number" && typeof f.seq === "number" && later.seq > f.seq);
			return all.filter((f) => f.status === status && !superseded(f)).sort((a, b) => compareFiringIds(a.firingId, b.firingId));
		}
		/**
		* Project a run record onto the per-node view the UI and tests consume.
		* Total over both record versions and over malformed entries (a projection
		* must never be the thing that breaks a render).
		*/
		function projectNodes(record) {
			const nodes = {};
			const order = [];
			const firings = Array.isArray(record.firings) ? record.firings : [];
			if (firings.length > 0) for (const firing of firings) {
				if (firing === null || typeof firing !== "object") continue;
				if (typeof firing.nodeId !== "string" || firing.nodeId.length === 0) continue;
				let node = nodes[firing.nodeId];
				if (node === void 0) {
					node = {
						nodeId: firing.nodeId,
						status: "pending",
						firings: []
					};
					nodes[firing.nodeId] = node;
					order.push(firing.nodeId);
				}
				node.firings.push(firing);
				if (firing.status !== void 0) node.status = firing.status;
				if (typeof firing.input === "string" && node.input === void 0) node.input = firing.input;
				if (typeof firing.output === "string") node.output = firing.output;
				if (typeof firing.error === "string") node.error = firing.error;
				if (typeof firing.stopReason === "string") node.stopReason = firing.stopReason;
				if (typeof firing.childSessionId === "string") node.childSessionId = firing.childSessionId;
			}
			else {
				const slots = record.nodes ?? {};
				for (const id of Array.isArray(record.order) ? record.order : []) {
					if (typeof id !== "string" || id.length === 0) continue;
					const slot = slots[id];
					if (slot === void 0) continue;
					nodes[id] = {
						nodeId: id,
						status: slot.status ?? "pending",
						...typeof slot.input === "string" ? { input: slot.input } : {},
						...typeof slot.output === "string" ? { output: slot.output } : {},
						...typeof slot.error === "string" ? { error: slot.error } : {},
						...typeof slot.stopReason === "string" ? { stopReason: slot.stopReason } : {},
						...typeof slot.childSessionId === "string" ? { childSessionId: slot.childSessionId } : {},
						firings: []
					};
					order.push(id);
				}
			}
			const pausedAt = typeof record.pausedAt === "string" ? record.pausedAt : void 0;
			const pausedFiring = pausedAt !== void 0 ? firings.find((f) => f !== null && typeof f === "object" && f.firingId === pausedAt) : void 0;
			let pausedNodeId;
			if (pausedFiring !== void 0) pausedNodeId = pausedFiring.nodeId;
			else if (pausedAt !== void 0 && firings.length === 0 && nodes[pausedAt] !== void 0) pausedNodeId = pausedAt;
			const parked = unresolvedFirings(firings, "paused");
			let pausedQueue = parked;
			if (pausedFiring !== void 0) pausedQueue = [pausedFiring, ...parked.filter((f) => f !== pausedFiring)];
			return {
				nodes,
				order,
				...pausedNodeId !== void 0 ? { pausedNodeId } : {},
				...pausedFiring !== void 0 ? { pausedFiring } : {},
				pausedQueue
			};
		}
		//#endregion
		//#region src/message.ts
		/**
		* Compose the pipeline-level input string from the modal's text and attached
		* file paths. Deterministic: text verbatim, then one "Attached files" block
		* listing one absolute path per line; empty parts are omitted entirely.
		*
		* @param text - the multiline input text (may be empty when files are attached).
		* @param files - attached absolute paths, in attachment order.
		* @returns the composed input string ("" when both are empty).
		*/
		function composePipelineInput(text, files) {
			const parts = [];
			if (typeof text === "string" && text.length > 0) parts.push(text);
			if (Array.isArray(files) && files.length > 0) parts.push("Attached files (absolute paths — read them with your file tools; their contents are not inlined here):\n" + files.map((f) => "- " + String(f)).join("\n"));
			return parts.join("\n\n");
		}
		/**
		* Render the run result's terminal outputs as continue-in-chat text.
		*
		* @param outputs - the contract's `{ [terminalId]: output }` map.
		* @param labelOf - terminal id → display label (agent name).
		* @returns a single output verbatim (values rendered like the prompt framing);
		*   several outputs as one "## <label>" section per terminal; "" when empty.
		*/
		function finalOutputText(outputs, labelOf) {
			const map = outputs ?? {};
			const ids = Object.keys(map);
			if (ids.length === 0) return "";
			if (ids.length === 1) return renderValue(map[ids[0]]);
			return ids.map((id) => "## " + labelOf(id) + "\n" + renderValue(map[id])).join("\n\n");
		}
		//#endregion
		//#region src/ui/shared.ts
		const ENDPOINT = "/dsh-agent-pipeline";
		/** Stable empty selector results (identity matters to the snapshot hooks). */
		const EMPTY_ROWS = {};
		const EMPTY_ITEMS = [];
		/** Numeric tail of an id (`agent-12` → 12), used to restore the id counter. */
		function numericSuffix(value) {
			const m = /(\d+)$/.exec(String(value));
			return m ? parseInt(m[1], 10) : 0;
		}
		/** Resolve a (possibly workspace-relative) path to the absolute form the agent reads. */
		function absolutePath(path, cwd) {
			if (path.startsWith("/")) return path;
			const base = typeof cwd === "string" && cwd.length > 0 ? cwd.replace(/\/+$/, "") : "";
			return base.length > 0 ? base + "/" + path : path;
		}
		/**
		* Serialize the internal graph to the wire/persisted shape (matches the View JSON contract).
		* `controls` is optional so legacy callers keep composing exactly today's
		* graph — with no controls (or an empty list) the `controls` key is omitted
		* and the output is byte-identical to the pre-control shape (additive schema).
		* Control endpoints serialize by their own rules: a control-sourced connection
		* always carries the branch name as `sourcePort`, and a control-targeted one
		* carries NO `targetPort` (the unconditional ":in" composition would fail the
		* control's single-unnamed-input rule).
		*/
		function buildGraph(agents, connections, controls = []) {
			const controlIds = new Set(controls.map((k) => k.id));
			return {
				agents: agents.map((a) => ({
					id: a.id,
					name: a.name,
					description: a.description || "",
					instructions: a.instructions || "",
					...typeof a.systemPrompt === "string" && a.systemPrompt.trim().length > 0 ? { systemPrompt: a.systemPrompt } : {},
					x: Math.round(a.x),
					y: Math.round(a.y),
					input: a.id + ":in",
					output: a.id + ":out",
					...a.inputPorts !== void 0 ? { inputPorts: a.inputPorts } : {},
					...a.outputPorts !== void 0 ? { outputPorts: a.outputPorts } : {},
					...a.outputPortSides !== void 0 && Object.keys(a.outputPortSides).length > 0 ? { outputPortSides: a.outputPortSides } : {},
					...a.bindings !== void 0 ? { bindings: a.bindings } : {},
					...a.settings ? { settings: a.settings } : {},
					...a.breakpoint === true ? { breakpoint: true } : {}
				})),
				connections: connections.map((c) => ({
					id: c.id,
					source: c.source,
					target: c.target,
					sourcePort: c.source + ":" + (c.sourcePort ?? "out"),
					...controlIds.has(c.target) ? {} : { targetPort: c.target + ":" + (c.targetPort ?? "in") }
				})),
				...controls.length > 0 ? { controls: controls.map((k) => ({
					id: k.id,
					kind: k.kind,
					branches: k.branches.map((b) => ({
						name: b.name,
						...typeof b.field === "string" && b.field.length > 0 ? { field: b.field } : {},
						...b.value !== void 0 && b.value !== "" ? { value: b.value } : {},
						...b.op === ">=" ? { op: b.op } : {},
						...b.side !== void 0 && b.side !== "right" ? { side: b.side } : {}
					})),
					x: Math.round(k.x),
					y: Math.round(k.y)
				})) } : {}
			};
		}
		/**
		* Read one persisted agent back into React state: the first-class
		* `systemPrompt`, the settings, the declared port lists, and the output
		* bindings. Legacy on-disk shapes are lifted so older pipeline.json files lose
		* nothing: `settings` was named `overrides`, the system prompt was the
		* top-level `persona` and before that `overrides.persona`. Object-shaped
		* setting values, the port lists, and the bindings round-trip untouched (a
		* hand-edited file must not lose data); the edit form canonicalizes a shape
		* only when that agent is saved again.
		*/
		function loadAgent(raw) {
			const rawAgent = raw ?? {};
			const rawSettings = loadSettingsShape(rawAgent.settings !== void 0 ? rawAgent.settings : rawAgent.overrides);
			const legacySettingsPersona = rawSettings?.persona;
			const settings = legacySettingsPersona === void 0 ? rawSettings : (() => {
				const rest = { ...rawSettings };
				delete rest.persona;
				return Object.keys(rest).length > 0 ? rest : void 0;
			})();
			const systemPrompt = typeof rawAgent.systemPrompt === "string" && rawAgent.systemPrompt.length > 0 ? rawAgent.systemPrompt : typeof rawAgent.persona === "string" && rawAgent.persona.length > 0 ? rawAgent.persona : typeof legacySettingsPersona === "string" ? legacySettingsPersona : "";
			const breakpoint = rawAgent.breakpoint === true;
			const inputPorts = Array.isArray(rawAgent.inputPorts) ? rawAgent.inputPorts : void 0;
			const outputPorts = Array.isArray(rawAgent.outputPorts) ? rawAgent.outputPorts : void 0;
			const outputPortSides = rawAgent.outputPortSides != null && typeof rawAgent.outputPortSides === "object" && !Array.isArray(rawAgent.outputPortSides) ? rawAgent.outputPortSides : void 0;
			const bindings = Array.isArray(rawAgent.bindings) ? rawAgent.bindings : void 0;
			return {
				systemPrompt,
				settings,
				...breakpoint ? { breakpoint: true } : {},
				...inputPorts !== void 0 ? { inputPorts } : {},
				...outputPorts !== void 0 ? { outputPorts } : {},
				...outputPortSides !== void 0 ? { outputPortSides } : {},
				...bindings !== void 0 ? { bindings } : {}
			};
		}
		/**
		* Read the persisted controls back into React state: object entries with a
		* non-empty id survive, branches normalize to the editor's row shape (a
		* missing field becomes "", an unknown side falls back to the default) so the
		* canvas state is always clean. Malformed entries are skipped — validation
		* reports them from the persisted file, and the next save canonicalizes the
		* graph to what the canvas holds.
		*/
		function loadControls(raw) {
			if (!Array.isArray(raw)) return [];
			const out = [];
			for (const entry of raw) {
				if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
				const rec = entry;
				const id = rec.id == null ? "" : String(rec.id);
				if (id.length === 0) continue;
				const branches = Array.isArray(rec.branches) ? rec.branches.map((b) => {
					if (b == null || typeof b !== "object" || Array.isArray(b)) return null;
					const br = b;
					const side = br.side === "left" || br.side === "right" || br.side === "top" || br.side === "bottom" ? br.side : void 0;
					return {
						name: br.name == null ? "" : String(br.name),
						field: typeof br.field === "string" ? br.field : "",
						...br.value === void 0 ? {} : { value: String(br.value) },
						...br.op === ">=" ? { op: ">=" } : {},
						...side !== void 0 ? { side } : {}
					};
				}).filter((b) => b !== null) : [];
				out.push({
					id,
					kind: rec.kind == null ? "if" : String(rec.kind),
					branches,
					x: Number(rec.x) || 0,
					y: Number(rec.y) || 0
				});
			}
			return out;
		}
		function loadSettingsShape(raw) {
			if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
			const r = raw;
			const out = {};
			if (typeof r.persona === "string" && r.persona.length > 0) out.persona = r.persona;
			if (typeof r.maxDepth === "number" && Number.isFinite(r.maxDepth)) out.maxDepth = r.maxDepth;
			if (r.agentOptions != null && typeof r.agentOptions === "object" && !Array.isArray(r.agentOptions)) out.agentOptions = r.agentOptions;
			if (r.toolFilter != null && typeof r.toolFilter === "object" && !Array.isArray(r.toolFilter)) out.toolFilter = r.toolFilter;
			if (r.outputSchema !== void 0 && r.outputSchema !== null) out.outputSchema = r.outputSchema;
			return Object.keys(out).length > 0 ? out : void 0;
		}
		//#endregion
		//#region \0pipeline-css:src\ui\agent-config.css.mjs
		const css$6 = "/* The agent configuration modal: overlay, a wide two-column card — the left\n   column is the agent's behavior (name / description / system prompt /\n   instructions), the right column the always-visible construction overrides. */\n\n.pipeline-config-overlay {\n  position: absolute;\n  inset: 0;\n  z-index: 20;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: rgba(0, 0, 0, 0.45);\n}\n.pipeline-config {\n  width: 720px;\n  max-width: 94%;\n  max-height: 92%;\n  overflow-y: auto;\n  background: var(--dsw-alias-bg-layer-1);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  padding: 16px;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  gap: 14px;\n  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);\n}\n.pipeline-config h3 {\n  margin: 0;\n  font-size: 14px;\n  font-weight: 600;\n}\n.pipeline-config .config-row {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n.pipeline-config label {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n.pipeline-config input,\n.pipeline-config textarea {\n  font-family: inherit;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-base);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 6px;\n  padding: 6px 10px;\n  box-sizing: border-box;\n  width: 100%;\n}\n.pipeline-config select {\n  /* Customizable select: the popup renders in-page, so its rows get the\n     padding below on every side (the macOS native menu ignores option CSS).\n     Unsupported browsers keep the native popup — this is simply ignored. */\n  appearance: base-select;\n  font-family: inherit;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-base);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 6px;\n  padding: 6px 10px;\n  box-sizing: border-box;\n  width: 100%;\n  white-space: nowrap;\n  overflow: hidden;\n}\n.pipeline-config select::picker(select) {\n  background: var(--dsw-alias-bg-layer-1);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  padding: 4px;\n  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);\n}\n.pipeline-config select option {\n  padding: 6px 10px;\n  border-radius: 5px;\n  color: inherit;\n}\n.pipeline-config select option:hover,\n.pipeline-config select option:focus {\n  background: color-mix(\n    in srgb,\n    var(--dsw-alias-brand-primary) 18%,\n    transparent\n  );\n}\n.pipeline-config input:focus,\n.pipeline-config textarea:focus,\n.pipeline-config select:focus {\n  outline: none;\n  border-color: var(--dsw-alias-brand-primary);\n}\n.pipeline-config textarea {\n  min-height: 72px;\n  resize: vertical;\n}\n.pipeline-config .config-actions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n  margin-top: 8px;\n}\n.pipeline-config .config-columns {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 16px;\n  align-items: start;\n}\n.pipeline-config .config-col {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  min-width: 0;\n}\n.pipeline-config .config-col-settings {\n  padding-left: 16px;\n  border-left: 1px solid var(--dsw-alias-border-l2);\n}\n.pipeline-config .config-grid {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 12px 10px;\n}\n.pipeline-config .config-error {\n  font-size: 11px;\n  color: var(--dsw-alias-state-error-primary);\n}\n.pipeline-config .config-warning {\n  font-size: 11px;\n  color: var(--dsw-alias-state-warning-primary, #f59e0b);\n}\n.pipeline-config .config-check {\n  display: flex;\n  flex-direction: row;\n  align-items: center;\n  gap: 6px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n}\n.pipeline-config .config-check input {\n  width: auto;\n  margin: 0;\n  accent-color: var(--dsw-alias-brand-primary);\n}\n/* The ports editor's compact rows (input ports, bindings): several small\n   controls on one line, plus muted hints and the remove/add mini buttons. */\n.pipeline-config .config-mini-row {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n.pipeline-config .config-mini-row input,\n.pipeline-config .config-mini-row select {\n  min-width: 0;\n}\n.pipeline-config .config-mini-op {\n  flex: 0 0 auto;\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n.pipeline-config .config-mini-btn {\n  flex: 0 0 auto;\n  padding: 3px 8px;\n  font-size: 11px;\n  width: auto;\n}\n.pipeline-config .config-hint {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n\n";
		const tagId$6 = "dsh-agent-pipeline-canvas/styles/C:\\Users\\Ivan\\Desktop\\dsh-agent-pipeline-canvas\\src\\ui\\agent-config.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$6) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-agent-pipeline-canvas";
			tag.dataset.pluginCss = tagId$6;
			tag.textContent = css$6;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/ui/agent-config.tsx
		/** The node edges a port may render on; inputs default left, outputs right. */
		const PORT_SIDES$1 = [
			{
				value: "left",
				label: "left"
			},
			{
				value: "right",
				label: "right"
			},
			{
				value: "top",
				label: "top"
			},
			{
				value: "bottom",
				label: "bottom"
			}
		];
		function asSide$1(value) {
			return value === "left" || value === "right" || value === "top" || value === "bottom" ? value : null;
		}
		function AgentConfigPanel({ agent, onSave, onClose }) {
			const [name, setName] = react.useState(agent.name);
			const [description, setDescription] = react.useState(agent.description);
			const [systemPrompt, setSystemPrompt] = react.useState(agent.systemPrompt ?? "");
			const [instructions, setInstructions] = react.useState(agent.instructions);
			const [breakpoint, setBreakpoint] = react.useState(agent.breakpoint === true);
			const settings = agent.settings;
			const [maxDepth, setMaxDepth] = react.useState(settings?.maxDepth != null ? String(settings.maxDepth) : "");
			const [provider, setProvider] = react.useState(settings?.agentOptions?.provider ?? "");
			const [model, setModel] = react.useState(settings?.agentOptions?.model ?? "");
			const [reasoningEffort, setReasoningEffort] = react.useState(settings?.agentOptions?.reasoningEffort ?? "");
			const [maxTokens, setMaxTokens] = react.useState(settings?.agentOptions?.maxTokens != null ? String(settings.agentOptions.maxTokens) : "");
			const [filterMode, setFilterMode] = react.useState(settings?.toolFilter?.deny != null ? "deny" : "allow");
			const [filterNames, setFilterNames] = react.useState((settings?.toolFilter?.allow ?? settings?.toolFilter?.deny ?? []).filter((t) => typeof t === "string").join(", "));
			const [schemaText, setSchemaText] = react.useState(settings?.outputSchema != null ? JSON.stringify(settings.outputSchema, null, 2) : "");
			const [inputPortRows, setInputPortRows] = react.useState(Array.isArray(agent.inputPorts) ? agent.inputPorts.filter((p) => p != null && typeof p.name === "string").map((p) => ({
				name: p.name,
				policy: p.policy === "any-of" ? "any-of" : "all-of",
				bound: p.bound != null ? String(p.bound) : "",
				side: asSide$1(p.side) ?? "left"
			})) : []);
			const [outputPortRows, setOutputPortRows] = react.useState(Array.isArray(agent.outputPorts) ? agent.outputPorts.filter((n) => typeof n === "string" && n.length > 0).map((n) => ({
				name: n,
				side: asSide$1(agent.outputPortSides?.[n]) ?? "right"
			})) : []);
			const [bindingRows, setBindingRows] = react.useState(Array.isArray(agent.bindings) ? agent.bindings.map((b) => ({
				field: typeof b.field === "string" ? b.field : "",
				value: b.value === void 0 ? "" : String(b.value),
				port: typeof b.port === "string" ? b.port : ""
			})) : []);
			const [catalog, setCatalog] = react.useState(null);
			const catalogAbortRef = react.useRef(null);
			function stopKey(e) {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
			}
			const schemaTrimmed = schemaText.trim();
			let schemaError = null;
			if (schemaTrimmed.length > 0) try {
				const parsed = JSON.parse(schemaTrimmed);
				if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) schemaError = "The output schema must be a JSON object.";
			} catch (err) {
				schemaError = "Invalid JSON: " + err.message;
			}
			function loadCatalog(providerId) {
				catalogAbortRef.current?.abort();
				const controller = new AbortController();
				catalogAbortRef.current = controller;
				const suffix = providerId !== null ? "?provider=" + encodeURIComponent(providerId) : "";
				fetch(ENDPOINT + "/options" + suffix, {
					cache: "no-store",
					signal: controller.signal
				}).then((r) => r.json()).then((data) => {
					const rec = data ?? {};
					if (rec.ok !== true) return;
					const providers = Array.isArray(rec.providers) ? rec.providers.filter((p) => p != null && typeof p.id === "string").map((p) => ({
						id: p.id,
						name: typeof p.name === "string" && p.name.length > 0 ? p.name : p.id
					})) : [];
					const models = Array.isArray(rec.models) ? rec.models.filter((m) => m != null && typeof m.id === "string").map((m) => ({
						id: m.id,
						name: typeof m.name === "string" && m.name.length > 0 ? m.name : m.id,
						...typeof m.description === "string" && m.description.length > 0 ? { description: m.description } : {}
					})) : [];
					setCatalog({
						providers,
						models,
						provider: typeof rec.provider === "string" ? rec.provider : ""
					});
				}).catch(() => {});
			}
			react.useEffect(() => {
				loadCatalog(provider.length > 0 ? provider : null);
				return () => {
					catalogAbortRef.current?.abort();
				};
			}, []);
			function onProviderChange(next) {
				setProvider(next);
				setModel("");
				loadCatalog(next.length > 0 ? next : null);
			}
			function field(label, value, set, title) {
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "config-row",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						value,
						title,
						onChange: (e) => {
							set(e.target.value);
						},
						onKeyDown: stopKey
					})]
				});
			}
			function assemble() {
				const text = (s) => {
					const t = s.trim();
					return t.length > 0 ? t : void 0;
				};
				const num = (s) => {
					const t = s.trim();
					return /^\d+$/.test(t) ? parseInt(t, 10) : void 0;
				};
				const trimmedSystemPrompt = text(systemPrompt);
				const out = {};
				const md = num(maxDepth);
				if (md !== void 0) out.maxDepth = md;
				const agentOptions = {};
				const pr = text(provider);
				if (pr !== void 0) agentOptions.provider = pr;
				const mo = text(model);
				if (mo !== void 0) agentOptions.model = mo;
				const re = text(reasoningEffort);
				if (re !== void 0) agentOptions.reasoningEffort = re;
				const mt = num(maxTokens);
				if (mt !== void 0) agentOptions.maxTokens = mt;
				if (Object.keys(agentOptions).length > 0) out.agentOptions = agentOptions;
				const names = filterNames.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
				if (names.length > 0) out.toolFilter = filterMode === "deny" ? { deny: names } : { allow: names };
				if (schemaError === null && schemaTrimmed.length > 0) out.outputSchema = JSON.parse(schemaTrimmed);
				return {
					...trimmedSystemPrompt !== void 0 ? { systemPrompt: trimmedSystemPrompt } : {},
					...Object.keys(out).length > 0 ? { settings: out } : {}
				};
			}
			const providers = catalog?.providers ?? [];
			const models = catalog?.models ?? [];
			function assemblePorts() {
				const ports = inputPortRows.map((row) => {
					const portName = row.name.trim();
					if (portName.length === 0) return null;
					const spec = {
						name: portName,
						...row.policy === "any-of" ? { policy: "any-of" } : {},
						...row.side !== "left" ? { side: row.side } : {}
					};
					const bound = row.bound.trim();
					if (/^\d+$/.test(bound) && parseInt(bound, 10) >= 1) spec.bound = parseInt(bound, 10);
					return spec;
				}).filter((s) => s !== null);
				const outs = outputPortRows.filter((row) => row.name.trim().length > 0);
				const outNames = outs.map((row) => row.name.trim());
				const outSides = outs.filter((row) => row.side !== "right");
				const outputPortSides = outs.length > 0 && outSides.length > 0 ? Object.fromEntries(outSides.map((row) => [row.name.trim(), row.side])) : void 0;
				const rules = bindingRows.map((row) => {
					const fieldName = row.field.trim();
					const port = row.port.trim();
					if (fieldName.length === 0 || port.length === 0) return null;
					const value = row.value.trim();
					return {
						field: fieldName,
						port,
						...value.length > 0 ? { value } : {}
					};
				}).filter((b) => b !== null);
				return {
					...ports.length > 0 ? { inputPorts: ports } : {},
					...outNames.length > 0 ? { outputPorts: outNames } : {},
					...outputPortSides !== void 0 ? { outputPortSides } : {},
					...rules.length > 0 ? { bindings: rules } : {}
				};
			}
			const portShape = assemblePorts();
			const hasBindings = portShape.bindings !== void 0;
			const schemaWillSave = schemaTrimmed.length > 0 && schemaError === null;
			const declaredOutPorts = portShape.outputPorts ?? ["out"];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pipeline-config-overlay",
				onPointerDown: (e) => {
					e.stopPropagation();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-config",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "Configure Agent" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "config-columns",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "config-col",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Name" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											value: name,
											onChange: (e) => {
												setName(e.target.value);
											},
											onKeyDown: stopKey
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Description" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											value: description,
											onChange: (e) => {
												setDescription(e.target.value);
											},
											onKeyDown: stopKey
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "System prompt" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
											value: systemPrompt,
											placeholder: "system prompt for this agent — empty keeps the harness default",
											title: "Replaces the persona slot (order 0) of the agent's system prompt for this agent alone — identity, policies, and tool explanations are inherited untouched",
											onChange: (e) => {
												setSystemPrompt(e.target.value);
											},
											onKeyDown: stopKey
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Instructions" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
											value: instructions,
											onChange: (e) => {
												setInstructions(e.target.value);
											},
											onKeyDown: stopKey
										})]
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "config-col config-col-settings",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Pause on output" }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "config-check",
												title: "Arm a breakpoint: the run pauses after this agent finishes, before any downstream agent starts — inspect the input and output, then Resume, Rerun, or Steer",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: breakpoint,
													onChange: (e) => {
														setBreakpoint(e.target.checked);
													},
													onKeyDown: stopKey
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "Pause the run after this agent finishes" })]
											}),
											breakpoint && schemaTrimmed.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "config-warning",
												children: "A breakpointed agent runs as a continuable child, which cannot produce structured output — the output schema below is ignored for this agent."
											}) : null
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-grid",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "config-row",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Provider" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: provider,
													title: "LLM provider route — Default inherits the parent Agent's provider",
													onChange: (e) => {
														onProviderChange(e.target.value);
													},
													onKeyDown: stopKey,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "",
															children: "Default"
														}),
														providers.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: p.id,
															children: p.name
														}, p.id)),
														provider.length > 0 && !providers.some((p) => p.id === provider) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: provider,
															children: provider
														}) : null
													]
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "config-row",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Model" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: model,
													title: "Model advertised by the selected provider — Default inherits the parent Agent's model",
													onChange: (e) => {
														setModel(e.target.value);
													},
													onKeyDown: stopKey,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "",
															children: "Default"
														}),
														models.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: m.id,
															title: m.description,
															children: m.name
														}, m.id)),
														model.length > 0 && !models.some((m) => m.id === model) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: model,
															children: model
														}) : null
													]
												})]
											}),
											field("Reasoning effort", reasoningEffort, setReasoningEffort, "Adapter-owned reasoning-effort id (provider-specific)"),
											field("Max output tokens", maxTokens, setMaxTokens, "Maximum output tokens per model request")
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Tool filter" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												display: "flex",
												gap: "6px"
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												value: filterMode,
												title: "Whether the named tools are the only ones allowed or the ones removed",
												"aria-label": "Tool filter mode",
												style: {
													width: "auto",
													minWidth: "80px"
												},
												onChange: (e) => {
													setFilterMode(e.target.value);
												},
												onKeyDown: stopKey,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "allow",
													children: "allow"
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "deny",
													children: "deny"
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												value: filterNames,
												placeholder: "tool names, comma-separated",
												title: "Global tool names, comma-separated (scoped to this child's creation window)",
												onChange: (e) => {
													setFilterNames(e.target.value);
												},
												onKeyDown: stopKey
											})]
										})]
									}),
									field("Max delegation depth", maxDepth, setMaxDepth, "Absolute delegation-depth cap for this child"),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Output schema (JSON)" }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
												value: schemaText,
												placeholder: "{ \"type\": \"object\", \"properties\": { … } }",
												title: "Object-rooted JSON Schema — a successful run returns the matching structured value",
												style: { minHeight: "56px" },
												onChange: (e) => {
													setSchemaText(e.target.value);
												},
												onKeyDown: stopKey
											}),
											schemaError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "config-error",
												children: schemaError
											}) : null
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Input ports" }),
											inputPortRows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "config-hint",
												children: "Default: one \"in\" port (all-of, unbounded)."
											}) : inputPortRows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "config-mini-row",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														value: row.name,
														placeholder: "port name",
														title: "Input port name — connections enter \"<agentId>:<name>\"",
														style: { flex: "1 1 40%" },
														onChange: (e) => {
															setInputPortRows((prev) => prev.map((r, i) => i === index ? {
																...r,
																name: e.target.value
															} : r));
														},
														onKeyDown: stopKey
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
														value: row.policy,
														title: "Firing policy — all-of waits for every wired source; any-of fires per arriving message",
														"aria-label": "Input port policy",
														style: {
															flex: "0 0 auto",
															width: "auto"
														},
														onChange: (e) => {
															const policy = e.target.value === "any-of" ? "any-of" : "all-of";
															setInputPortRows((prev) => prev.map((r, i) => i === index ? {
																...r,
																policy
															} : r));
														},
														onKeyDown: stopKey,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "all-of",
															children: "all-of"
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "any-of",
															children: "any-of"
														})]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														value: row.bound,
														placeholder: "bound",
														title: "Delivery bound — max messages the port accepts this run (a loop budget); further arrivals are dropped and recorded. Empty = unbounded.",
														"aria-label": "Input port bound",
														style: { flex: "0 0 64px" },
														onChange: (e) => {
															setInputPortRows((prev) => prev.map((r, i) => i === index ? {
																...r,
																bound: e.target.value
															} : r));
														},
														onKeyDown: stopKey
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
														value: row.side,
														title: "Node edge this port renders on — a loop whose two ports sit on the same vertical edge arcs over or under the band",
														"aria-label": "Input port side",
														style: {
															flex: "0 0 auto",
															width: "auto"
														},
														onChange: (e) => {
															const side = asSide$1(e.target.value) ?? "left";
															setInputPortRows((prev) => prev.map((r, i) => i === index ? {
																...r,
																side
															} : r));
														},
														onKeyDown: stopKey,
														children: PORT_SIDES$1.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: s.value,
															children: s.label
														}, s.value))
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														className: "pipeline-btn config-mini-btn",
														title: "Remove this input port",
														"aria-label": "Remove input port " + (row.name || String(index + 1)),
														onClick: () => {
															setInputPortRows((prev) => prev.filter((_, i) => i !== index));
														},
														children: "×"
													})
												]
											}, index)),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												className: "pipeline-btn config-mini-btn",
												title: "Declare a named input port",
												onClick: () => {
													setInputPortRows((prev) => prev.concat([{
														name: "",
														policy: "all-of",
														bound: "",
														side: "left"
													}]));
												},
												children: "+ Add input port"
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Output ports" }),
											outputPortRows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "config-hint",
												children: "Default: one \"out\" port. A firing emits on some of them and not on others (per the bindings below), or on all of them without bindings."
											}) : outputPortRows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "config-mini-row",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														value: row.name,
														placeholder: "port name",
														title: "Output port name — connections leave \"<agentId>:<name>\"",
														style: { flex: "1 1 55%" },
														onChange: (e) => {
															setOutputPortRows((prev) => prev.map((r, i) => i === index ? {
																...r,
																name: e.target.value
															} : r));
														},
														onKeyDown: stopKey
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
														value: row.side,
														title: "Node edge this port renders on — a loop whose two ports sit on the same vertical edge arcs over or under the band",
														"aria-label": "Output port side",
														style: {
															flex: "0 0 auto",
															width: "auto"
														},
														onChange: (e) => {
															const side = asSide$1(e.target.value) ?? "right";
															setOutputPortRows((prev) => prev.map((r, i) => i === index ? {
																...r,
																side
															} : r));
														},
														onKeyDown: stopKey,
														children: PORT_SIDES$1.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: s.value,
															children: s.label
														}, s.value))
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														className: "pipeline-btn config-mini-btn",
														title: "Remove this output port",
														"aria-label": "Remove output port " + (row.name || String(index + 1)),
														onClick: () => {
															setOutputPortRows((prev) => prev.filter((_, i) => i !== index));
														},
														children: "×"
													})
												]
											}, index)),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												className: "pipeline-btn config-mini-btn",
												title: "Declare a named output port",
												onClick: () => {
													setOutputPortRows((prev) => prev.concat([{
														name: "",
														side: "right"
													}]));
												},
												children: "+ Add output port"
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-row",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Output bindings" }),
											bindingRows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "config-hint",
												children: "Without bindings a firing emits on every output port. Add rules to route the structured output — first match wins; an empty value is the catch-all, keep it last."
											}) : bindingRows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "config-mini-row",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														value: row.field,
														placeholder: "field",
														title: "Structured-output field to compare",
														style: { flex: "1 1 28%" },
														onChange: (e) => {
															setBindingRows((prev) => prev.map((r, i) => i === index ? {
																...r,
																field: e.target.value
															} : r));
														},
														onKeyDown: stopKey
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "config-mini-op",
														children: "=="
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														value: row.value,
														placeholder: "value — empty = catch-all",
														title: "Value the field must equal (compared as text). Empty matches any structured result.",
														style: { flex: "1 1 28%" },
														onChange: (e) => {
															setBindingRows((prev) => prev.map((r, i) => i === index ? {
																...r,
																value: e.target.value
															} : r));
														},
														onKeyDown: stopKey
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "config-mini-op",
														children: "→"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
														value: row.port,
														title: "Output port to emit on when the field matches",
														"aria-label": "Binding output port",
														style: {
															flex: "0 0 auto",
															width: "auto"
														},
														onChange: (e) => {
															setBindingRows((prev) => prev.map((r, i) => i === index ? {
																...r,
																port: e.target.value
															} : r));
														},
														onKeyDown: stopKey,
														children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																value: "",
																children: "port…"
															}),
															declaredOutPorts.map((portName) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																value: portName,
																children: portName
															}, portName)),
															row.port.length > 0 && !declaredOutPorts.includes(row.port) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																value: row.port,
																children: row.port
															}) : null
														]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														className: "pipeline-btn config-mini-btn",
														title: "Remove this binding",
														"aria-label": "Remove binding " + (row.field || String(index + 1)),
														onClick: () => {
															setBindingRows((prev) => prev.filter((_, i) => i !== index));
														},
														children: "×"
													})
												]
											}, index)),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												className: "pipeline-btn config-mini-btn",
												title: "Add a field → port routing rule",
												onClick: () => {
													setBindingRows((prev) => prev.concat([{
														field: "",
														value: "",
														port: ""
													}]));
												},
												children: "+ Add binding"
											}),
											breakpoint && hasBindings ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "config-warning",
												children: "A breakpointed agent runs as a continuable child, which cannot produce structured output — its bindings never match and it emits on no port."
											}) : null,
											hasBindings && !schemaWillSave ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "config-warning",
												children: "Bindings evaluate against the structured output — set an output schema above, or this agent emits on no port."
											}) : null
										]
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "config-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								onClick: onClose,
								children: "Cancel"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								disabled: schemaError !== null,
								title: schemaError ?? void 0,
								onClick: () => {
									const assembled = assemble();
									onSave({
										id: agent.id,
										name,
										description,
										systemPrompt: assembled.systemPrompt,
										instructions,
										settings: assembled.settings,
										...breakpoint ? { breakpoint: true } : {},
										inputPorts: portShape.inputPorts,
										outputPorts: portShape.outputPorts,
										outputPortSides: portShape.outputPortSides,
										bindings: portShape.bindings
									});
								},
								children: "Save"
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/ui/control-config.tsx
		/** The node edges a branch tick may render on; branches default right. */
		const PORT_SIDES = [
			{
				value: "left",
				label: "left"
			},
			{
				value: "right",
				label: "right"
			},
			{
				value: "top",
				label: "top"
			},
			{
				value: "bottom",
				label: "bottom"
			}
		];
		/** The comparison ops a branch row may declare; `==` is the default. */
		const BRANCH_OPS = [{
			value: "==",
			label: "=="
		}, {
			value: ">=",
			label: ">="
		}];
		function asSide(value) {
			return value === "left" || value === "right" || value === "top" || value === "bottom" ? value : null;
		}
		function ControlConfigPanel({ control, warnings, rowWarnings, onSave, onClose }) {
			const [rows, setRows] = react.useState(control.branches.map((b) => ({
				name: b.name,
				field: typeof b.field === "string" ? b.field : "",
				op: b.op === ">=" ? ">=" : "==",
				value: b.value === void 0 ? "" : String(b.value),
				side: asSide(b.side) ?? "right"
			})));
			function stopKey(e) {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
			}
			function setRow(index, patch) {
				setRows((prev) => prev.map((r, i) => i === index ? {
					...r,
					...patch
				} : r));
			}
			function move(index, delta) {
				setRows((prev) => {
					const next = prev.slice();
					const other = index + delta;
					if (other < 0 || other >= next.length) return prev;
					const tmp = next[index];
					next[index] = next[other];
					next[other] = tmp;
					return next;
				});
			}
			let shapeError = null;
			const seenNames = /* @__PURE__ */ new Set();
			rows.forEach((row, index) => {
				if (shapeError !== null) return;
				const name = row.name.trim();
				const field = row.field.trim();
				const value = row.value.trim();
				if (name.length === 0 && field.length === 0 && value.length === 0) return;
				if (name.length === 0) {
					shapeError = `Branch #${index + 1} has no name.`;
					return;
				}
				if (seenNames.has(name)) {
					shapeError = `Branch "${name}" is declared more than once.`;
					return;
				}
				seenNames.add(name);
				if (value.length > 0 && field.length === 0) {
					shapeError = `Branch "${name}" compares a value but names no field.`;
					return;
				}
				if (row.op === ">=" && !(value.length > 0 && Number.isFinite(Number(value)))) {
					shapeError = `Branch "${name}" compares with ">=" but its value is not a finite number.`;
					return;
				}
				if (value.length === 0 && index < rows.length - 1) shapeError = `Branch "${name}" is a catch-all (empty value) — it must stay the last branch.`;
			});
			function assemble() {
				return rows.filter((r) => r.name.trim().length > 0 || r.field.trim().length > 0 || r.value.trim().length > 0).map((r) => {
					const name = r.name.trim();
					const field = r.field.trim();
					const value = r.value.trim();
					return {
						name,
						field,
						...value.length > 0 ? { value } : {},
						...r.op === ">=" ? { op: ">=" } : {},
						...r.side !== "right" ? { side: r.side } : {}
					};
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pipeline-config-overlay",
				onPointerDown: (e) => {
					e.stopPropagation();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-config control-config",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "Configure If" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "config-hint",
							children: [
								"Branches evaluate top to bottom on the feeding agent's structured output — first match wins. The op picker carries the loop vocabulary:",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: " >= " }),
								"compares numerically, and the reserved",
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "$count" }),
								" field tests the iteration count (it matches even without a structured result). The catch-all (empty value) must stay last. Wire each branch tick to the agent that handles it."
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "config-row",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Branches" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("datalist", {
									id: "pipeline-branch-fields",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: COUNT_KEY,
										children: "iteration count"
									})
								}),
								rows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-mini-row",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												value: row.name,
												placeholder: "branch name",
												title: "Branch name — also the output port name connections leave \"<controlId>:<branch>\"",
												style: { flex: "1 1 26%" },
												onChange: (e) => {
													setRow(index, { name: e.target.value });
												},
												onKeyDown: stopKey
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												value: row.field,
												placeholder: "field",
												list: "pipeline-branch-fields",
												title: "Structured-output field to compare — the reserved \"$count\" tests the firing sequence of the feeding agent for this firing (the iteration number at a loop tail)",
												style: { flex: "1 1 22%" },
												onChange: (e) => {
													setRow(index, { field: e.target.value });
												},
												onKeyDown: stopKey
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
												value: row.op,
												title: "Comparison — == matches the value against the field as text; >= compares numerically (Number both sides, finite required)",
												"aria-label": "Branch comparison operator",
												style: {
													flex: "0 0 auto",
													width: "auto"
												},
												onChange: (e) => {
													setRow(index, { op: e.target.value === ">=" ? ">=" : "==" });
												},
												onKeyDown: stopKey,
												children: BRANCH_OPS.map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: o.value,
													children: o.label
												}, o.value))
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												value: row.value,
												placeholder: row.field.trim() === "$count" ? "iterations — e.g. 3" : "value — empty = catch-all",
												title: row.field.trim() === "$count" ? "The iteration threshold — with >= the row matches from this firing number on" : "Value the field must equal (compared as text). Empty matches any structured result — the catch-all, kept last.",
												style: { flex: "1 1 26%" },
												onChange: (e) => {
													setRow(index, { value: e.target.value });
												},
												onKeyDown: stopKey
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
												value: row.side,
												title: "Node edge this branch tick renders on",
												"aria-label": "Branch side",
												style: {
													flex: "0 0 auto",
													width: "auto"
												},
												onChange: (e) => {
													setRow(index, { side: asSide(e.target.value) ?? "right" });
												},
												onKeyDown: stopKey,
												children: PORT_SIDES.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: s.value,
													children: s.label
												}, s.value))
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												className: "pipeline-btn config-mini-btn",
												title: "Move this branch up (earlier in the evaluation order)",
												"aria-label": "Move branch " + (row.name || String(index + 1)) + " up",
												disabled: index === 0,
												onClick: () => {
													move(index, -1);
												},
												children: "↑"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												className: "pipeline-btn config-mini-btn",
												title: "Move this branch down (later in the evaluation order)",
												"aria-label": "Move branch " + (row.name || String(index + 1)) + " down",
												disabled: index === rows.length - 1,
												onClick: () => {
													move(index, 1);
												},
												children: "↓"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												className: "pipeline-btn config-mini-btn",
												title: "Remove this branch",
												"aria-label": "Remove branch " + (row.name || String(index + 1)),
												onClick: () => {
													setRows((prev) => prev.filter((_, i) => i !== index));
												},
												children: "×"
											})
										]
									}),
									row.field.trim() === "$count" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "config-hint",
										children: ["count " + row.op + " " + (row.value.trim().length > 0 ? row.value.trim() : "…") + " → " + (row.name.trim().length > 0 ? row.name.trim() : "…"), " — iteration count: the feeding agent's firing sequence for this firing (1-based); with >= it escapes the loop from the threshold on"]
									}) : null,
									rowWarnings !== void 0 && rowWarnings[row.name.trim()] ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "config-warning",
										children: rowWarnings[row.name.trim()]
									}) : null
								] }, index)),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "pipeline-btn config-mini-btn",
									title: "Add a branch rule",
									onClick: () => {
										setRows((prev) => prev.concat([{
											name: "",
											field: "",
											op: "==",
											value: "",
											side: "right"
										}]));
									},
									children: "+ Add branch"
								}),
								shapeError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "config-error",
									children: shapeError
								}) : null,
								warnings.map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "config-warning",
									children: w.message
								}, w.code + ":" + w.message))
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "config-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								onClick: onClose,
								children: "Cancel"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								disabled: shapeError !== null,
								title: shapeError ?? void 0,
								onClick: () => {
									onSave(assemble());
								},
								children: "Save"
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region \0pipeline-css:src\ui\run-modal.css.mjs
		const css$5 = "/* The Run modal's attachment zone, path chips, and the file-reference picker. */\r\n\r\n.pipeline-attach-zone {\r\n	border: 1px dashed var(--dsw-alias-border-l2);\r\n	border-radius: 8px;\r\n	padding: 8px;\r\n	display: flex;\r\n	flex-direction: column;\r\n	gap: 6px;\r\n}\r\n.pipeline-attach-zone.drag { border-color: var(--dsw-alias-brand-primary); }\r\n.pipeline-chips { display: flex; flex-wrap: wrap; gap: 6px; }\r\n.pipeline-chip {\r\n	display: inline-flex;\r\n	align-items: center;\r\n	gap: 6px;\r\n	font-size: 11px;\r\n	background: var(--dsw-alias-bg-layer-2);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 999px;\r\n	padding: 2px 4px 2px 9px;\r\n	max-width: 100%;\r\n}\r\n.pipeline-chip .chip-path {\r\n	overflow: hidden;\r\n	text-overflow: ellipsis;\r\n	white-space: nowrap;\r\n	max-width: 420px;\r\n}\r\n.pipeline-chip .chip-x {\r\n	cursor: pointer;\r\n	border: none;\r\n	background: transparent;\r\n	color: var(--dsw-alias-label-secondary);\r\n	font-size: 12px;\r\n	line-height: 1;\r\n	padding: 2px 6px;\r\n	border-radius: 999px;\r\n}\r\n.pipeline-chip .chip-x:hover { color: var(--dsw-alias-state-error-primary); }\r\n.pipeline-picker-list {\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 6px;\r\n	background: var(--dsw-alias-bg-base);\r\n	max-height: 150px;\r\n	overflow: auto;\r\n	display: flex;\r\n	flex-direction: column;\r\n}\r\n.pipeline-picker-row {\r\n	display: flex;\r\n	align-items: center;\r\n	gap: 8px;\r\n	padding: 4px 8px;\r\n	font-size: 11px;\r\n	cursor: pointer;\r\n	user-select: none;\r\n}\r\n.pipeline-picker-row:hover { background: var(--dsw-alias-bg-layer-2); }\r\n.pipeline-picker-row .row-kind {\r\n	flex-shrink: 0;\r\n	font-size: 10px;\r\n	color: var(--dsw-alias-label-secondary);\r\n	width: 52px;\r\n}\r\n.pipeline-picker-row .row-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\r\n.pipeline-picker-row .row-add {\r\n	flex-shrink: 0;\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	background: transparent;\r\n	color: var(--dsw-alias-label-secondary);\r\n	border-radius: 4px;\r\n	font-size: 11px;\r\n	line-height: 1;\r\n	padding: 2px 6px;\r\n	cursor: pointer;\r\n}\r\n.pipeline-picker-row .row-add:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }\r\n.pipeline-picker-status { font-size: 11px; color: var(--dsw-alias-label-secondary); }\r\n";
		const tagId$5 = "dsh-agent-pipeline-canvas/styles/C:\\Users\\Ivan\\Desktop\\dsh-agent-pipeline-canvas\\src\\ui\\run-modal.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$5) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-agent-pipeline-canvas";
			tag.dataset.pluginCss = tagId$5;
			tag.textContent = css$5;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/ui/run-modal.tsx
		function RunModal({ cwd, initialText, initialFiles, running, fileList, onRun, onClose }) {
			const [text, setText] = react.useState(initialText);
			const [files, setFiles] = react.useState(initialFiles);
			const [maxInFlight, setMaxInFlight] = react.useState("4");
			const [query, setQuery] = react.useState("");
			const [candidates, setCandidates] = react.useState([]);
			const [pickerState, setPickerState] = react.useState("idle");
			const [manual, setManual] = react.useState("");
			const [notice, setNotice] = react.useState(null);
			const [dragOver, setDragOver] = react.useState(false);
			function stopKey(e) {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
			}
			function attach(path) {
				const abs = absolutePath(path.trim(), cwd);
				if (abs.length === 0) return;
				setFiles((prev) => prev.indexOf(abs) === -1 ? prev.concat([abs]) : prev);
			}
			function onPickRow(candidate, add) {
				const path = typeof candidate.path === "string" ? candidate.path : "";
				if (path.length === 0) return;
				if (add || candidate.kind !== "directory") attach(path);
				else setQuery(path + "/");
			}
			function onDrop(e) {
				e.preventDefault();
				setDragOver(false);
				const text = e.dataTransfer.getData("text/plain");
				if (typeof text === "string" && text.trim().startsWith("/")) {
					text.split("\n").forEach((line) => {
						if (line.trim().startsWith("/")) attach(line);
					});
					return;
				}
				if (e.dataTransfer.files && e.dataTransfer.files.length > 0) setNotice("The browser hides dropped files' paths — use the picker below (or paste a path).");
			}
			react.useEffect(() => {
				if (fileList === null) return;
				const controller = new AbortController();
				const timer = setTimeout(() => {
					setPickerState("loading");
					fileList(query, controller.signal).then((rows) => {
						if (controller.signal.aborted) return;
						setCandidates(rows.filter((c) => c && typeof c.path === "string" && c.path.length > 0));
						setPickerState("ready");
					}).catch(() => {
						if (controller.signal.aborted) return;
						setCandidates([]);
						setPickerState("error");
					});
				}, 150);
				return () => {
					clearTimeout(timer);
					controller.abort();
				};
			}, [query, fileList]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pipeline-modal-overlay",
				onPointerDown: (e) => {
					e.stopPropagation();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-modal",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "Run Pipeline" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "modal-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Input (the first agent receives this)" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								value: text,
								placeholder: "What should the pipeline do?",
								onChange: (e) => {
									setText(e.target.value);
								},
								onKeyDown: stopKey
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pipeline-attach-zone" + (dragOver ? " drag" : ""),
							onDragOver: (e) => {
								e.preventDefault();
								setDragOver(true);
							},
							onDragLeave: () => {
								setDragOver(false);
							},
							onDrop,
							children: [
								files.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "pipeline-chips",
									children: files.map((f) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "pipeline-chip",
										title: f,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "chip-path",
											children: f
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "chip-x",
											title: "Remove",
											onClick: () => {
												setFiles((prev) => prev.filter((p) => p !== f));
											},
											children: "×"
										})]
									}, f))
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "pipeline-picker-status",
									children: "No files attached."
								}),
								fileList !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									value: query,
									placeholder: "Attach workspace files — type a path to search…",
									onChange: (e) => {
										setQuery(e.target.value);
									},
									onKeyDown: stopKey
								}) : null,
								fileList !== null && (pickerState !== "idle" || query.length > 0) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pipeline-picker-list",
									children: [
										pickerState === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "pipeline-picker-row",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "pipeline-picker-status",
												children: "Searching…"
											})
										}) : null,
										pickerState === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "pipeline-picker-row",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "pipeline-picker-status",
												children: "File search unavailable."
											})
										}) : null,
										pickerState === "ready" && candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "pipeline-picker-row",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "pipeline-picker-status",
												children: "No matches."
											})
										}) : null,
										candidates.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "pipeline-picker-row",
											onClick: () => {
												onPickRow(c, false);
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "row-kind",
													children: c.kind === "directory" ? "dir" : "file"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "row-path",
													title: c.path,
													children: c.path
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													className: "row-add",
													title: "Attach",
													onClick: (e) => {
														e.stopPropagation();
														onPickRow(c, true);
													},
													children: "+ attach"
												})
											]
										}, c.path))
									]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pipeline-chips",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										value: manual,
										placeholder: "…or paste an absolute path",
										style: {
											flex: "1 1 200px",
											width: "auto"
										},
										onChange: (e) => {
											setManual(e.target.value);
										},
										onKeyDown: (e) => {
											e.stopPropagation();
											if (e.key === "Enter") {
												attach(manual);
												setManual("");
											}
											if (e.key === "Escape") onClose();
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "pipeline-btn",
										disabled: manual.trim().length === 0,
										onClick: () => {
											attach(manual);
											setManual("");
										},
										children: "Add"
									})]
								}),
								notice ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "pipeline-modal-notice",
									children: notice
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pipeline-picker-status",
							children: "Files attach as absolute paths only — the first agent reads them with its own tools."
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "modal-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Max agents in flight" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								value: maxInFlight,
								inputMode: "numeric",
								placeholder: "4",
								onChange: (e) => {
									setMaxInFlight(e.target.value);
								},
								onKeyDown: stopKey
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pipeline-modal-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								onClick: onClose,
								children: "Cancel"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn pipeline-btn-run",
								disabled: running,
								onClick: () => {
									const parsed = Number.parseInt(maxInFlight, 10);
									onRun(text, files, Number.isInteger(parsed) && parsed >= 1 ? parsed : null);
								},
								children: running ? "Running…" : "Run"
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region \0pipeline-css:src\ui\result-modal.css.mjs
		const css$4 = "/* The Result modal: terminal-output blocks and the per-run status strip with\n   the Transcript route into each agent's child session. */\n\n.pipeline-result {\n	background: var(--dsw-alias-bg-base);\n	border: 1px solid var(--dsw-alias-border-l2);\n	border-radius: 8px;\n	padding: 8px;\n	max-height: 220px;\n	overflow: auto;\n	display: flex;\n	flex-direction: column;\n	gap: 6px;\n}\n.pipeline-result-row { display: flex; flex-direction: column; gap: 2px; }\n.pipeline-result-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }\n.pipeline-result-value {\n	margin: 0;\n	padding: 6px 8px;\n	background: var(--dsw-alias-bg-base);\n	border: 1px solid var(--dsw-alias-border-l2);\n	border-radius: 6px;\n	font-size: 11px;\n	white-space: pre-wrap;\n	word-break: break-word;\n	max-height: 160px;\n	overflow: auto;\n}\n.pipeline-result-warn { font-size: 11px; color: var(--dsw-alias-state-warning-primary, #f59e0b); }\n.pipeline-result-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); }\n.pipeline-runs {\n	display: flex;\n	flex-direction: column;\n	gap: 4px;\n	border-top: 1px dashed var(--dsw-alias-border-l2);\n	padding-top: 6px;\n}\n.pipeline-run-row { display: flex; align-items: center; gap: 8px; font-size: 11px; min-height: 20px; }\n.pipeline-run-row .run-name { font-weight: 600; flex-shrink: 0; }\n.pipeline-run-row .run-status { color: var(--dsw-alias-label-secondary); flex-shrink: 0; }\n.pipeline-run-row .run-status.warn { color: var(--dsw-alias-state-warning-primary, #f59e0b); }\n.pipeline-run-row .run-error {\n	color: var(--dsw-alias-state-error-primary);\n	overflow: hidden;\n	text-overflow: ellipsis;\n	white-space: nowrap;\n	flex: 1;\n}\n";
		const tagId$4 = "dsh-agent-pipeline-canvas/styles/C:\\Users\\Ivan\\Desktop\\dsh-agent-pipeline-canvas\\src\\ui\\result-modal.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-agent-pipeline-canvas";
			tag.dataset.pluginCss = tagId$4;
			tag.textContent = css$4;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/ui/result-modal.tsx
		function ResultModal({ result, names, targets, busy, status, onOpenSession, onContinueChat, onContinueNewSession, onSendTo, onClose }) {
			const [targetId, setTargetId] = react.useState(targets.length > 0 ? targets[0].id : "");
			function stopKey(e) {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
			}
			const termName = { ...names };
			const outputRows = Object.keys(result.outputs || {}).map((id) => {
				const v = result.outputs[id];
				const txt = typeof v === "string" ? v : JSON.stringify(v, null, 2);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-result-row",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "pipeline-result-label",
						children: termName[id] || id
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: "pipeline-result-value",
						children: txt
					})]
				}, "o-" + id);
			});
			const canContinue = result.ok === true;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pipeline-modal-overlay",
				onPointerDown: (e) => {
					e.stopPropagation();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-modal",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: result.ok ? "Pipeline Result" : "Pipeline Failed" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pipeline-result",
							children: [result.ok ? outputRows.length > 0 ? outputRows : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "pipeline-result-row",
								children: "No terminal output."
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "pipeline-result-error",
								children: result.error || "graph is invalid: " + (result.validationErrors || []).map((e) => e.message).join("; ")
							}), Array.isArray(result.runs) && result.runs.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "pipeline-runs",
								children: result.runs.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pipeline-run-row",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "run-name",
											children: termName[r.id] || r.id
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "run-status" + (r.status && r.status !== "completed" && r.status !== "done" ? " warn" : ""),
											children: r.status || "?"
										}),
										r.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "run-error",
											title: r.error,
											children: r.error
										}) : null,
										r.childSessionId ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "pipeline-btn pipeline-btn-mini",
											title: "Open this agent's child session — the full transcript",
											onClick: () => {
												onOpenSession(r.childSessionId);
											},
											children: "Transcript"
										}) : null
									]
								}, "run-" + r.id))
							}) : null]
						}),
						canContinue ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "modal-row",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pipeline-modal-actions",
									style: { marginTop: 0 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "pipeline-btn",
										disabled: busy !== null,
										title: "Prefill this session's composer with the final output (you send it)",
										onClick: onContinueChat,
										children: busy === "chat" ? "Working…" : "Continue in chat"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "pipeline-btn",
										disabled: busy !== null,
										title: "Create a session in this workspace and prefill its composer (you send it)",
										onClick: onContinueNewSession,
										children: busy === "new" ? "Working…" : "Continue in a new session"
									})]
								}),
								targets.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "pipeline-modal-actions",
									style: { marginTop: 0 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: targetId,
										onChange: (e) => {
											setTargetId(e.target.value);
										},
										onKeyDown: stopKey,
										"aria-label": "Target session",
										children: targets.map((t) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: t.id,
											children: t.label
										}, t.id))
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "pipeline-btn",
										disabled: busy !== null || targetId.length === 0,
										title: "Open that session and prefill its composer (you send it)",
										onClick: () => {
											onSendTo(targetId);
										},
										children: busy === "send" ? "Working…" : "Send to session…"
									})]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "pipeline-picker-status",
									children: "Every route only prefills a composer — you review and press send."
								})
							]
						}) : null,
						status ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pipeline-modal-status",
							children: status
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pipeline-modal-actions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								onClick: onClose,
								children: "Close"
							})
						})
					]
				})
			});
		}
		//#endregion
		//#region \0pipeline-css:src\ui\inspect-modal.css.mjs
		const css$3 = "/* The paused-run inspection modal: meta strip, fixed composed input, adopted\r\n   output, the steer feedback box, and the control actions. Reuses the shared\r\n   modal/result vocabulary (.pipeline-modal, .pipeline-btn, .run-status). */\r\n\r\n.pipeline-inspect-meta {\r\n	display: flex;\r\n	align-items: center;\r\n	gap: 8px;\r\n	flex-wrap: wrap;\r\n	font-size: 11px;\r\n	color: var(--dsw-alias-label-secondary);\r\n}\r\n.pipeline-inspect-hint { flex: 1; text-align: right; }\r\n.pipeline-inspect-block {\r\n	margin: 0;\r\n	padding: 6px 8px;\r\n	background: var(--dsw-alias-bg-base);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 6px;\r\n	font-size: 11px;\r\n	white-space: pre-wrap;\r\n	word-break: break-word;\r\n	max-height: 140px;\r\n	overflow: auto;\r\n}\r\n.pipeline-inspect-error {\r\n	font-size: 11px;\r\n	color: var(--dsw-alias-state-error-primary);\r\n}\r\n.pipeline-inspect-spacer { flex: 1; }\r\n.pipeline-btn-danger {\r\n	color: var(--dsw-alias-state-error-primary);\r\n	border-color: var(--dsw-alias-state-error-primary);\r\n}\r\n";
		const tagId$3 = "dsh-agent-pipeline-canvas/styles/C:\\Users\\Ivan\\Desktop\\dsh-agent-pipeline-canvas\\src\\ui\\inspect-modal.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-agent-pipeline-canvas";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/ui/inspect-modal.tsx
		function InspectModal({ agentName, node, queued, busy, status, canSteer, onOpenSession, onResume, onRerun, onSteer, onAbort, onClose }) {
			const [feedback, setFeedback] = react.useState("");
			function stopKey(e) {
				e.stopPropagation();
				if (e.key === "Escape") onClose();
			}
			const stopped = busy !== null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pipeline-modal-overlay",
				onPointerDown: (e) => {
					e.stopPropagation();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-modal",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", { children: ["Paused at ", agentName] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pipeline-inspect-meta",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "run-status" + (node.stopReason && node.stopReason !== "completed" ? " warn" : ""),
									children: node.stopReason || "settled"
								}),
								node.childSessionId ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "pipeline-btn pipeline-btn-mini",
									title: "Open this agent's child session — the full transcript",
									disabled: stopped,
									onClick: () => {
										onOpenSession(node.childSessionId);
									},
									children: "Transcript"
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "pipeline-inspect-hint",
									children: "The pipeline is paused before any downstream agent runs."
								}),
								queued > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "pipeline-inspect-hint",
									children: [
										queued,
										" more breakpoint",
										queued === 1 ? "" : "s",
										" queued — Resume releases this one and surfaces the next."
									]
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "modal-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Composed input (fixed for this run)" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								className: "pipeline-inspect-block",
								children: node.input || "(empty)"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "modal-row",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Output" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
									className: "pipeline-inspect-block",
									children: node.output && node.output.length > 0 ? node.output : "(no output)"
								}),
								node.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "pipeline-inspect-error",
									children: node.error
								}) : null
							]
						}),
						canSteer ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "modal-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Steer — send feedback to this same agent (it keeps its transcript)" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								value: feedback,
								placeholder: "What should the agent do differently?",
								onChange: (e) => {
									setFeedback(e.target.value);
								},
								onKeyDown: stopKey
							})]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pipeline-picker-status",
							children: "Steering is unavailable in this deployment (no continuable subagent runtime); Rerun still works."
						}),
						status ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pipeline-modal-status",
							children: status
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pipeline-modal-actions",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "pipeline-btn pipeline-btn-danger",
									title: "Abort the whole run — completed outputs are preserved",
									disabled: stopped,
									onClick: onAbort,
									children: "Abort"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "pipeline-inspect-spacer" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "pipeline-btn",
									onClick: onClose,
									children: "Close"
								}),
								canSteer ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "pipeline-btn",
									title: "Deliver the feedback to this same child and adopt its new answer (stay paused)",
									disabled: stopped || !canSteer || feedback.trim().length === 0,
									onClick: () => {
										onSteer(feedback);
									},
									children: busy === "steer" ? "Steering…" : "Steer"
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "pipeline-btn",
									title: "Run this agent again from scratch with the SAME input (a fresh transcript; the old one is kept)",
									disabled: stopped,
									onClick: onRerun,
									children: busy === "rerun" ? "Rerunning…" : "Rerun"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "pipeline-btn pipeline-btn-run",
									title: "Continue the pipeline with the current output",
									disabled: stopped,
									onClick: onResume,
									children: busy === "resume" ? "Resuming…" : "Resume"
								})
							]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/ui/node-menu.tsx
		function NodeMenu({ target, entries, onAction, onClose }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open: true,
				anchor: null,
				portal: true,
				items: entries,
				onSelect: (id) => {
					onClose();
					onAction(id);
				},
				onClose,
				getAnchorRect: () => new DOMRect(target.x, target.y, 0, 0)
			});
		}
		//#endregion
		//#region \0pipeline-css:src\ui\canvas.css.mjs
		const css$2 = "/* The canvas: view frame, toolbar, validation strip, palette, nodes/ports,\r\n   edges, and the JSON drawer. Class names are globally prefixed\r\n   (`pipeline-*`) — the per-file style tags are the scoping mechanism. */\r\n\r\n.pipeline-view {\r\n	position: relative;\r\n	display: flex;\r\n	flex-direction: column;\r\n	height: 100%;\r\n	width: 100%;\r\n	box-sizing: border-box;\r\n	font-family: inherit;\r\n	color: var(--dsw-alias-label-primary);\r\n}\r\n.pipeline-view .pipeline-toolbar {\r\n	display: flex;\r\n	align-items: center;\r\n	gap: 8px;\r\n	padding: 8px 10px;\r\n	border-bottom: 1px solid var(--dsw-alias-border-l1);\r\n	flex-wrap: wrap;\r\n	background: var(--dsw-alias-bg-layer-1);\r\n}\r\n.pipeline-view .pipeline-toolbar h3 { margin: 0; font-size: 14px; font-weight: 600; }\r\n.pipeline-view .pipeline-toolbar .spacer { flex: 1; }\r\n.pipeline-view .pipeline-toolbar .stat { font-size: 12px; color: var(--dsw-alias-label-secondary); }\r\n.pipeline-view .pipeline-toolbar .pipeline-validation {\r\n	margin-left: 6px;\r\n	font-size: 12px;\r\n	padding: 3px 9px;\r\n	border-radius: 999px;\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	line-height: 1;\r\n}\r\n.pipeline-view .pipeline-toolbar .pipeline-validation.ok {\r\n	color: var(--dsw-alias-state-success-primary);\r\n	border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);\r\n}\r\n.pipeline-view .pipeline-toolbar .pipeline-validation.err {\r\n	color: var(--dsw-alias-state-error-primary);\r\n	border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);\r\n}\r\n/* Every warning amber carries a literal fallback: the host theme injects the\r\n   alias palette at runtime and currently defines success/error/brand but no\r\n   warning alias, so a bare var() silently inherits the label color (white in\r\n   the dark theme). The fallback defers to the host theme once it defines the\r\n   alias. */\r\n.pipeline-view .pipeline-toolbar .pipeline-validation.warn {\r\n	color: var(--dsw-alias-state-warning-primary, #f59e0b);\r\n	border-color: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 45%, transparent);\r\n}\r\n.pipeline-issues {\r\n	background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-1));\r\n	border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 25%, var(--dsw-alias-border-l1));\r\n	padding: 6px 10px;\r\n	max-height: 120px;\r\n	overflow: auto;\r\n	display: flex;\r\n	flex-direction: column;\r\n	gap: 3px;\r\n}\r\n.pipeline-issues.warnings-only {\r\n	background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 10%, var(--dsw-alias-bg-layer-1));\r\n	border-bottom-color: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 25%, var(--dsw-alias-border-l1));\r\n}\r\n.pipeline-issue { font-size: 12px; color: var(--dsw-alias-state-error-primary); line-height: 1.4; }\r\n.pipeline-issue.warn { color: var(--dsw-alias-state-warning-primary, #f59e0b); }\r\n.pipeline-body { flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--dsw-alias-border-l1); }\r\n.pipeline-palette {\r\n	width: 170px;\r\n	flex-shrink: 0;\r\n	background: var(--dsw-alias-bg-layer-2);\r\n	border-right: 1px solid var(--dsw-alias-border-l1);\r\n	padding: 12px;\r\n	box-sizing: border-box;\r\n	overflow: auto;\r\n}\r\n.pipeline-palette .palette-title {\r\n	font-size: 12px;\r\n	text-transform: uppercase;\r\n	letter-spacing: .04em;\r\n	color: var(--dsw-alias-label-secondary);\r\n	margin-bottom: 10px;\r\n}\r\n.palette-item {\r\n	display: flex;\r\n	align-items: center;\r\n	gap: 8px;\r\n	cursor: grab;\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	background: var(--dsw-alias-bg-base);\r\n	border-radius: 8px;\r\n	padding: 10px;\r\n	font-size: 13px;\r\n	user-select: none;\r\n}\r\n.palette-item:active { cursor: grabbing; }\r\n.palette-icon { width: 12px; height: 12px; border-radius: 3px; background: var(--dsw-alias-brand-primary); }\r\n/* The If brick: the decision diamond outline — the same mark the node wears. */\r\n.palette-icon.if {\r\n	background: transparent;\r\n	border: 2px solid var(--dsw-alias-brand-primary);\r\n	border-radius: 2px;\r\n	transform: rotate(45deg) scale(.82);\r\n	margin: 0 2px;\r\n}\r\n.pipeline-canvas {\r\n	position: relative;\r\n	flex: 1;\r\n	min-height: 0;\r\n	overflow: hidden;\r\n	background-image: radial-gradient(circle, rgba(128, 128, 128, .18) 1px, transparent 1px);\r\n	background-size: 20px 20px;\r\n}\r\n.pipeline-canvas:focus { outline: none; }\r\n.pipeline-hint {\r\n	position: absolute;\r\n	inset: 0;\r\n	display: flex;\r\n	align-items: center;\r\n	justify-content: center;\r\n	color: var(--dsw-alias-label-secondary);\r\n	font-size: 13px;\r\n	pointer-events: none;\r\n	text-align: center;\r\n	padding: 0 20px;\r\n}\r\n.pipeline-edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }\r\n.pipeline-edge { stroke: var(--dsw-alias-label-secondary); stroke-width: 2; fill: none; }\r\n.pipeline-arrowfill { fill: var(--dsw-alias-label-secondary); }\r\n.pipeline-arrowfill-fired { fill: var(--dsw-alias-state-success-primary); }\r\n.pipeline-edge-temp { stroke: var(--dsw-alias-brand-primary); stroke-width: 2; fill: none; stroke-dasharray: 6 4; }\r\n/* The if's branch-edge highlight (the derived run view): once the decision\r\n   has landed, the chosen branch's edge — and its arrowhead (the -fired\r\n   marker above) — light success green, and the branches that stayed\r\n   unchosen dim to dashed gray. Only control-sourced edges ever carry these\r\n   classes. */\r\n.pipeline-edge.pipeline-edge-fired { stroke: var(--dsw-alias-state-success-primary); stroke-width: 2.5; }\r\n.pipeline-edge.pipeline-edge-quiet { opacity: 0.35; stroke-dasharray: 6 4; }\r\n/* Edge interaction: a transparent 12px stroke rides above each wire (a 2px\r\n   line is unclickable) and carries hover plus selection. Selection — the\r\n   transient \"this wire is targeted\" emphasis, brand stroke and arrowhead —\r\n   wins over the run-state styling, including the quiet dim. */\r\n.pipeline-edge-hit {\r\n	fill: none;\r\n	stroke: transparent;\r\n	stroke-width: 12;\r\n	pointer-events: stroke;\r\n	cursor: pointer;\r\n}\r\n.pipeline-edge-group:hover .pipeline-edge { stroke-width: 3; }\r\n.pipeline-edge.pipeline-edge-selected {\r\n	stroke: var(--dsw-alias-brand-primary);\r\n	stroke-width: 2.5;\r\n	opacity: 1;\r\n}\r\n.pipeline-arrowfill-selected { fill: var(--dsw-alias-brand-primary); }\r\n/* Named-port edge labels (\"mail → data\") at the edge midpoint: small, muted,\r\n   and stroked with the canvas background so they read over the edge line. */\r\n.pipeline-edge-label {\r\n	font-size: 9px;\r\n	fill: var(--dsw-alias-label-secondary);\r\n	paint-order: stroke;\r\n	stroke: var(--dsw-alias-bg-base);\r\n	stroke-width: 3px;\r\n	stroke-linejoin: round;\r\n}\r\n/* The connection port picker: a narrow overlay card reusing the config\r\n   overlay's dim backdrop. */\r\n.pipeline-edge-picker {\r\n	width: 320px;\r\n	max-width: 90%;\r\n	background: var(--dsw-alias-bg-layer-1);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 12px;\r\n	padding: 14px;\r\n	box-sizing: border-box;\r\n	display: flex;\r\n	flex-direction: column;\r\n	gap: 12px;\r\n	box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);\r\n}\r\n.pipeline-edge-picker h3 { margin: 0; font-size: 13px; font-weight: 600; }\r\n.pipeline-edge-picker .picker-row { display: flex; flex-direction: column; gap: 4px; }\r\n.pipeline-edge-picker label { font-size: 11px; color: var(--dsw-alias-label-secondary); }\r\n.pipeline-edge-picker select {\r\n	font-family: inherit;\r\n	font-size: 12px;\r\n	color: var(--dsw-alias-label-primary);\r\n	background: var(--dsw-alias-bg-base);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 6px;\r\n	padding: 6px 10px;\r\n	box-sizing: border-box;\r\n	width: 100%;\r\n}\r\n.pipeline-edge-picker select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }\r\n/* The picker's read-only \"to\" line: the drop already resolved the target side\r\n   (or the mint it will make), so it is shown as text, not a choice. */\r\n.pipeline-edge-picker .picker-static {\r\n	font-size: 12px;\r\n	color: var(--dsw-alias-label-primary);\r\n	background: var(--dsw-alias-bg-base);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 6px;\r\n	padding: 6px 10px;\r\n	box-sizing: border-box;\r\n	width: 100%;\r\n}\r\n.pipeline-edge-picker .picker-actions { display: flex; justify-content: flex-end; gap: 8px; }\r\n.pipeline-node {\r\n	position: absolute;\r\n	width: 150px;\r\n	height: 58px;\r\n	box-sizing: border-box;\r\n	background: var(--dsw-alias-bg-layer-2);\r\n	border: 1.5px solid var(--dsw-alias-border-l2);\r\n	border-radius: 10px;\r\n	display: flex;\r\n	flex-direction: column;\r\n	align-items: center;\r\n	justify-content: center;\r\n	cursor: move;\r\n	user-select: none;\r\n}\r\n.pipeline-node.selected { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }\r\n.pipeline-node .node-name { font-size: 13px; font-weight: 600; }\r\n.pipeline-node .node-sub { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 3px; }\r\n.pipeline-node .node-breakpoint {\r\n	position: absolute;\r\n	top: 3px;\r\n	left: 4px;\r\n	width: 18px;\r\n	height: 18px;\r\n	display: flex;\r\n	align-items: center;\r\n	justify-content: center;\r\n	padding: 0;\r\n	border: none;\r\n	border-radius: 5px;\r\n	background: transparent;\r\n	color: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent);\r\n	cursor: pointer;\r\n}\r\n.pipeline-node .node-breakpoint:hover { color: var(--dsw-alias-state-warning-primary, #f59e0b); background: var(--dsw-alias-interactive-bg-hover); }\r\n.pipeline-node .node-breakpoint.armed { color: var(--dsw-alias-state-warning-primary, #f59e0b); }\r\n/* Live per-node run states (from the active run's record): the border, a\r\n   faint state tint over the node, and a corner icon badge. Everything paints\r\n   INSIDE the node box — the old status pill hung off the bottom edge at dead\r\n   center, exactly where a bottom-side port anchors and wires route — so\r\n   ports and connections stay clear. The badge rides the bottom edge's wide\r\n   axis: even three stacked bottom-side ports (frac 1/4..3/4 of 150px) clear\r\n   it. */\r\n.pipeline-node.node-running { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, var(--dsw-alias-bg-layer-2)); }\r\n.pipeline-node.node-paused { border-color: var(--dsw-alias-state-warning-primary, #f59e0b); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 55%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 11%, var(--dsw-alias-bg-layer-2)); }\r\n.pipeline-node.node-done { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 60%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, var(--dsw-alias-bg-layer-2)); }\r\n.pipeline-node.node-aborted { border-color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, var(--dsw-alias-bg-layer-2)); }\r\n.pipeline-node.node-error { border-color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, var(--dsw-alias-bg-layer-2)); }\r\n/* The status badge: shape-coded (check / pause bars / stop square / cross;\r\n   running is the bare pulsing dot — brand reads near-white in the dark\r\n   theme, so motion carries \"in flight\") so the state never rides color\r\n   alone; the tooltip carries the word. Icons are currentColor inline SVGs,\r\n   same idiom as the breakpoint dot's. */\r\n.pipeline-node .node-badge {\r\n	position: absolute;\r\n	right: 3px;\r\n	bottom: 3px;\r\n	width: 16px;\r\n	height: 16px;\r\n	box-sizing: border-box;\r\n	display: flex;\r\n	align-items: center;\r\n	justify-content: center;\r\n	border-radius: 50%;\r\n	background: var(--dsw-alias-bg-overlay);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n}\r\n.pipeline-node .node-badge.status-done { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }\r\n.pipeline-node .node-badge.status-paused { color: var(--dsw-alias-state-warning-primary, #f59e0b); border-color: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 55%, transparent); }\r\n.pipeline-node .node-badge.status-aborted,\r\n.pipeline-node .node-badge.status-error { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }\r\n.pipeline-node .node-badge.status-running {\r\n	background: var(--dsw-alias-brand-primary);\r\n	border-color: var(--dsw-alias-brand-primary);\r\n	animation: node-badge-pulse 1.6s ease-out infinite;\r\n}\r\n@keyframes node-badge-pulse {\r\n	0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }\r\n	70%, 100% { box-shadow: 0 0 0 5px transparent; }\r\n}\r\n@media (prefers-reduced-motion: reduce) {\r\n	.pipeline-node .node-badge.status-running { animation: none; }\r\n}\r\n.pipeline-view .pipeline-toolbar .pipeline-run-live {\r\n	font-size: 12px;\r\n	color: var(--dsw-alias-state-warning-primary, #f59e0b);\r\n	padding: 3px 9px;\r\n	border-radius: 999px;\r\n	border: 1px dashed color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 50%, transparent);\r\n	line-height: 1;\r\n	max-width: 260px;\r\n	overflow: hidden;\r\n	text-overflow: ellipsis;\r\n	white-space: nowrap;\r\n}\r\n/* Fail-fast: the run is failing — a firing errored, in-flight agents draining. */\r\n.pipeline-view .pipeline-toolbar .pipeline-run-live.failed {\r\n	color: var(--dsw-alias-state-error-primary);\r\n	border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent);\r\n	border-style: solid;\r\n}\r\n/* Ports hide at rest — a node's border stays uninterrupted and wires land\r\n   flush on it. A node reveals its ticks (`.reveal-full`: hover or selection,\r\n   or it is the wire drag's source) or its input ticks and open points\r\n   (`.reveal-in`: a wire-drag drop target); hidden points never catch the\r\n   pointer. */\r\n.pipeline-port {\r\n	position: absolute;\r\n	width: 14px;\r\n	height: 14px;\r\n	border-radius: 50%;\r\n	background: var(--dsw-alias-bg-overlay);\r\n	border: 2px solid var(--dsw-alias-brand-primary);\r\n	cursor: crosshair;\r\n	/* left/top carry the anchor point (see portAnchor) — center on it. */\r\n	transform: translate(-50%, -50%);\r\n	opacity: 0;\r\n	pointer-events: none;\r\n	transition: opacity 0.12s ease;\r\n}\r\n.pipeline-node.reveal-full .pipeline-port,\r\n.pipeline-node.reveal-in > .pipeline-port.in,\r\n.pipeline-node.reveal-in > .pipeline-port.ghost { opacity: 1; pointer-events: auto; }\r\n@media (prefers-reduced-motion: reduce) {\r\n	.pipeline-port { transition: none; }\r\n}\r\n.pipeline-port.out { border-color: var(--dsw-alias-state-success-primary); }\r\n.pipeline-port.hover { box-shadow: 0 0 0 4px var(--dsw-alias-brand-primary); }\r\n/* Open points (the four-point model): one per node edge hosting no port of\r\n   either direction. Direction-neutral by design — a wire dragged FROM one\r\n   makes it an output, a wire DROPPED on one makes it an input, and the drop\r\n   authors the missing declaration — so the affordance reads as neither the\r\n   input (brand) nor the output (success) tick: a dashed, muted ring. */\r\n.pipeline-port.ghost {\r\n	border-style: dashed;\r\n	border-color: color-mix(in srgb, var(--dsw-alias-label-secondary, #9aa4b2) 75%, transparent);\r\n}\r\n/* The if control node: the flowchart DECISION shape — a diamond, taller than\r\n   an agent (150×84) — so the fork reads as a decision, not a model call. The\r\n   node box itself is a transparent hit area; the shape is an SVG layer whose\r\n   border follows the diamond (a clip-path on the box would clip the node's\r\n   own buttons away with the corners). Ticks anchor on the four vertices. */\r\n.pipeline-node.control {\r\n	width: 150px;\r\n	height: 84px;\r\n	background: transparent;\r\n	border: none;\r\n}\r\n.control-shape {\r\n	position: absolute;\r\n	inset: 0;\r\n	width: 100%;\r\n	height: 100%;\r\n	pointer-events: none;\r\n}\r\n.control-shape polygon {\r\n	fill: var(--dsw-alias-bg-layer-2);\r\n	stroke: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l2));\r\n	stroke-width: 1.5;\r\n	vector-effect: non-scaling-stroke;\r\n}\r\n.pipeline-node.control.selected {\r\n	/* The base selection ring is rectangular — on the diamond the stroke and\r\n	   glow on the shape layer carry the selection instead. */\r\n	box-shadow: none;\r\n}\r\n.pipeline-node.control.selected .control-shape polygon {\r\n	stroke: var(--dsw-alias-brand-primary);\r\n	stroke-width: 2.5;\r\n}\r\n.pipeline-node.control.selected .control-shape {\r\n	filter: drop-shadow(0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent));\r\n}\r\n/* The derived run state lights the diamond the way an agent's border moves:\r\n   armed = the feeding agent is producing the decision's input (brand), fired =\r\n   the decision landed on a branch (success), quiet = the decision landed on\r\n   nothing — no branch matched (warning). idle leaves the shape at rest. No\r\n   run word is rendered: the border and the branch edges ARE the state, and\r\n   the hover tooltip names it. */\r\n.pipeline-node.control.control-armed .control-shape polygon { stroke: var(--dsw-alias-brand-primary); stroke-width: 2; }\r\n.pipeline-node.control.control-armed .control-shape { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 60%, transparent)); }\r\n.pipeline-node.control.control-fired .control-shape polygon { stroke: var(--dsw-alias-state-success-primary); stroke-width: 2; }\r\n.pipeline-node.control.control-fired .control-shape { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 60%, transparent)); }\r\n.pipeline-node.control.control-quiet .control-shape polygon { stroke: var(--dsw-alias-state-warning-primary, #f59e0b); stroke-width: 2; }\r\n.pipeline-node.control.control-quiet .control-shape { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 60%, transparent)); }\r\n/* The shape layer is absolutely positioned, which paints it over the static\r\n   text — lift the labels into the positioned layer (they come later in the\r\n   DOM, so this alone puts them back on top). */\r\n.pipeline-node.control .node-name,\r\n.pipeline-node.control .node-sub { position: relative; }\r\n/* One labeled tick per branch: the WRAPPER is dot-sized and centered on the\r\n   vertex, so the dot sits exactly on it (straddling the corner, like an\r\n   agent's tick on its node edge); the label hangs on a small base-colored\r\n   chip DIAGONALLY off the vertex — outward AND lateral — because the branch\r\n   wire always leaves along the outward axis, and a label placed straight out\r\n   sits inside its own wire. The wrapper never catches the pointer — only its\r\n   tick does, and only while revealed (the label stays visible at rest: it\r\n   carries the fork's semantics, the dot is just the affordance). */\r\n.control-branch {\r\n	position: absolute;\r\n	width: 18px;\r\n	height: 18px;\r\n	transform: translate(-50%, -50%);\r\n	pointer-events: none;\r\n}\r\n.control-branch .pipeline-port { position: static; transform: none; }\r\n.control-branch .branch-label {\r\n	position: absolute;\r\n	font-size: 9px;\r\n	line-height: 1;\r\n	color: var(--dsw-alias-label-secondary);\r\n	white-space: nowrap;\r\n	background: var(--dsw-alias-bg-base);\r\n	padding: 2px 5px;\r\n	border-radius: 4px;\r\n}\r\n.control-branch.side-right .branch-label { left: calc(100% + 5px); bottom: calc(50% + 5px); }\r\n.control-branch.side-left .branch-label { right: calc(100% + 5px); bottom: calc(50% + 5px); }\r\n.control-branch.side-top .branch-label { bottom: calc(100% + 5px); right: calc(50% + 5px); }\r\n.control-branch.side-bottom .branch-label { top: calc(100% + 5px); right: calc(50% + 5px); }\r\n/* The control's warning chip (never-fire sources, side stacking) hangs below\r\n   the diamond's bottom vertex — a control has no status badge (its run state\r\n   rides the border). A bottom-side branch tick anchors on that same vertex;\r\n   the chip's base overlay keeps both readable when they coexist. The run\r\n   view's iteration chip (.node-iter below) mirrors it on the top vertex, so\r\n   the two slots never collide. */\r\n.pipeline-node .node-warn {\r\n	position: absolute;\r\n	bottom: -8px;\r\n	left: 50%;\r\n	transform: translateX(-50%);\r\n	font-size: 9px;\r\n	line-height: 1;\r\n	padding: 2px 7px;\r\n	border-radius: 999px;\r\n	background: var(--dsw-alias-bg-overlay);\r\n	border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 50%, transparent);\r\n	color: var(--dsw-alias-state-warning-primary, #f59e0b);\r\n}\r\n/* The loop-iteration chip (the run view, loops L4): on a cycle the diamond's\r\n   top vertex carries `iter N`, promoted to `iter N/M` when a `$count >= M`\r\n   row parses off the branches — the count is derived from the record's\r\n   firings, never stored. Neutral colors: it is run information, not a\r\n   warning (the border keeps the fired/quiet vocabulary); a top-side branch\r\n   tick anchors on the same vertex, and the DOM order (chips render before\r\n   the ticks) keeps the tick the live pointer target. */\r\n.pipeline-node .node-iter {\r\n	position: absolute;\r\n	top: -8px;\r\n	left: 50%;\r\n	transform: translateX(-50%);\r\n	font-size: 9px;\r\n	line-height: 1;\r\n	padding: 2px 7px;\r\n	border-radius: 999px;\r\n	background: var(--dsw-alias-bg-overlay);\r\n	border: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent);\r\n	color: var(--dsw-alias-label-primary);\r\n}\r\n/* The owner-handoff dialog's body text. */\r\n.pipeline-edge-picker .handoff-text { font-size: 12px; color: var(--dsw-alias-label-primary); line-height: 1.5; }\r\n.pipeline-json { border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }\r\n.pipeline-json pre {\r\n	margin: 0;\r\n	padding: 10px;\r\n	max-height: 200px;\r\n	overflow: auto;\r\n	font-size: 11px;\r\n	white-space: pre-wrap;\r\n	word-break: break-word;\r\n}\r\n";
		const tagId$2 = "dsh-agent-pipeline-canvas/styles/C:\\Users\\Ivan\\Desktop\\dsh-agent-pipeline-canvas\\src\\ui\\canvas.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-agent-pipeline-canvas";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/ui/pipeline-view.tsx
		let pendingChatView = null;
		/** Stash a request and let it self-expire when no pipeline view mounts for it
		* (the target already shows Chat — nothing to switch). The window only has to
		* cover the open + history replay of the target session. */
		function requestChatView(sessionId) {
			pendingChatView = sessionId;
			window.setTimeout(() => {
				if (pendingChatView === sessionId) pendingChatView = null;
			}, 5e3);
		}
		/** The iteration chip's text: "iter 2", promoted to "iter 2/3" by a parsed threshold. */
		function iterLabel(iter) {
			return "iter " + iter.count + (iter.threshold !== null ? "/" + iter.threshold : "");
		}
		/** The iteration in words for the tooltips: "iteration 2", "iteration 2 of 3". */
		function iterWords(iter) {
			return "iteration " + iter.count + (iter.threshold !== null ? " of " + iter.threshold : "");
		}
		/** The if control's hover tooltip: names the decision and its branches — the
		* words no longer rendered as a node tag — plus the loop iteration when the
		* control sits on a cycle. */
		function controlRunTitle(runState) {
			const iter = runState.iter !== void 0 ? " — " + iterWords(runState.iter) : "";
			return runState.state === "fired" ? "The decision fired — branch " + runState.chosen.join(", ") + iter : runState.state === "quiet" ? "The feeding agent's result matched no branch — nothing downstream of the if ran" + iter : runState.state === "armed" ? "No branch decision recorded — the feeding agent's last firing never reached emission" + iter : "The run has not reached this decision yet" + iter;
		}
		/** The status badge's tooltip: the word the old hanging pill printed. */
		const RUN_STATUS_TITLE = {
			running: "Running",
			paused: "Paused at a breakpoint",
			done: "Finished",
			aborted: "Aborted — the run was stopped before this agent finished",
			error: "Failed — open Result for the error"
		};
		/** The status badge's glyph, shape-coded so the state never rides color
		* alone (the check/pause/stop/cross marks; running is the bare pulsing dot —
		* the badge itself, no glyph). currentColor inline SVGs, the breakpoint
		* dot's idiom. */
		function statusBadgeIcon(status) {
			switch (status) {
				case "done": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					width: 9,
					height: 9,
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M4 13l5 5L20 7",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 3.5,
						strokeLinecap: "round",
						strokeLinejoin: "round"
					})
				});
				case "paused": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width: 8,
					height: 8,
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: 5,
						y: 4,
						width: 5,
						height: 16,
						rx: 1.5,
						fill: "currentColor"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: 14,
						y: 4,
						width: 5,
						height: 16,
						rx: 1.5,
						fill: "currentColor"
					})]
				});
				case "aborted": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					width: 8,
					height: 8,
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: 5,
						y: 5,
						width: 14,
						height: 14,
						rx: 2,
						fill: "currentColor"
					})
				});
				case "error": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					width: 8,
					height: 8,
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M6 6l12 12M18 6L6 18",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 3.5,
						strokeLinecap: "round"
					})
				});
				case "running": return null;
			}
		}
		function PipelineView({ sessionId, useSessions, useWorkspaces, inputActions, openView, services, onDismiss }) {
			const NODE_W = 150;
			const NODE_H = 58;
			const CONTROL_W = 150;
			const CONTROL_H = 84;
			const [agents, setAgents] = react.useState([]);
			const [connections, setConnections] = react.useState([]);
			const [controls, setControls] = react.useState([]);
			const [seq, setSeq] = react.useState(1);
			const [selectedId, setSelectedId] = react.useState(null);
			const [selectedEdgeId, setSelectedEdgeId] = react.useState(null);
			/** Select a node (agent or control) — or clear the selection with null. */
			function selectNode(id) {
				setSelectedId(id);
				setSelectedEdgeId(null);
			}
			/** Select a connection by id — or clear the selection with null. */
			function selectEdge(id) {
				setSelectedEdgeId(id);
				setSelectedId(null);
			}
			const [connectCursor, setConnectCursor] = react.useState(null);
			const [hoverTarget, setHoverTarget] = react.useState(null);
			const [hoverNodeId, setHoverNodeId] = react.useState(null);
			const [showJson, setShowJson] = react.useState(false);
			const [configAgentId, setConfigAgentId] = react.useState(null);
			const [configControlId, setConfigControlId] = react.useState(null);
			const [showRunModal, setShowRunModal] = react.useState(false);
			const [activeRun, setActiveRun] = react.useState(null);
			const [startPending, setStartPending] = react.useState(false);
			const [runResult, setRunResult] = react.useState(null);
			const [resultOpen, setResultOpen] = react.useState(false);
			const [doneRun, setDoneRun] = react.useState(null);
			const [continueBusy, setContinueBusy] = react.useState(null);
			const [continueStatus, setContinueStatus] = react.useState(null);
			const [inspectDismissedFor, setInspectDismissedFor] = react.useState(null);
			const [controlBusy, setControlBusy] = react.useState(null);
			const [controlStatus, setControlStatus] = react.useState(null);
			const [edgeDraft, setEdgeDraft] = react.useState(null);
			const [ownerHandoff, setOwnerHandoff] = react.useState(null);
			const [nodeMenu, setNodeMenu] = react.useState(null);
			const runTextRef = react.useRef("");
			const runFilesRef = react.useRef([]);
			/** The live SSE subscription for the active run's record. */
			const sseRef = react.useRef(null);
			const canvasRef = react.useRef(null);
			const idRef = react.useRef(0);
			const dragRef = react.useRef(null);
			const connectRef = react.useRef(null);
			const cwdRef = react.useRef(void 0);
			const sessionIdRef = react.useRef("");
			const loadedRef = react.useRef(false);
			const skipNextPersistRef = react.useRef(false);
			const saveTimerRef = react.useRef(null);
			const stateRef = react.useRef({
				agents: [],
				connections: [],
				controls: []
			});
			react.useEffect(() => {
				if (pendingChatView !== null && pendingChatView === sessionId && typeof openView === "function") {
					pendingChatView = null;
					openView("chat", "");
				}
			}, [sessionId, openView]);
			const cwd = useSessions((s) => {
				if (!s || !s.byId) return void 0;
				const entry = s.byId[sessionId];
				return entry ? entry.cwd : void 0;
			});
			cwdRef.current = cwd;
			sessionIdRef.current = sessionId;
			const sessionRows = useSessions((s) => s && s.byId || EMPTY_ROWS);
			const workspaceItems = useWorkspaces ? useWorkspaces((s) => s && s.items || EMPTY_ITEMS) : EMPTY_ITEMS;
			react.useEffect(() => () => {
				if (sseRef.current !== null) {
					sseRef.current.close();
					sseRef.current = null;
				}
			}, []);
			react.useEffect(() => {
				if (nodeMenu === null) return;
				if (nodeMenu.kind === "edge") {
					if (!connections.some((c) => c.id === nodeMenu.id)) setNodeMenu(null);
					return;
				}
				if (!agents.some((a) => a.id === nodeMenu.id) && !controls.some((k) => k.id === nodeMenu.id)) setNodeMenu(null);
			}, [
				agents,
				connections,
				controls,
				nodeMenu
			]);
			function newId(prefix) {
				idRef.current += 1;
				return prefix + "-" + idRef.current;
			}
			function canvasPoint(clientX, clientY) {
				const rect = canvasRef.current ? canvasRef.current.getBoundingClientRect() : {
					left: 0,
					top: 0
				};
				return {
					x: clientX - rect.left,
					y: clientY - rect.top
				};
			}
			function addAgent(x, y) {
				const agent = {
					id: newId("agent"),
					name: "Agent " + seq,
					description: "",
					instructions: "",
					x,
					y
				};
				setAgents((prev) => prev.concat([agent]));
				setSeq((s) => s + 1);
				selectNode(agent.id);
				return agent;
			}
			function addControl(x, y) {
				const control = {
					id: newId("if"),
					kind: "if",
					branches: [{
						name: "else",
						field: ""
					}],
					x,
					y
				};
				setControls((prev) => prev.concat([control]));
				selectNode(control.id);
				return control;
			}
			const SIDE_NORMAL = {
				left: {
					x: -1,
					y: 0
				},
				right: {
					x: 1,
					y: 0
				},
				top: {
					x: 0,
					y: -1
				},
				bottom: {
					x: 0,
					y: 1
				}
			};
			function asSide(value) {
				return value === "left" || value === "right" || value === "top" || value === "bottom" ? value : null;
			}
			function inputPortSide(a, port) {
				return asSide((Array.isArray(a.inputPorts) ? a.inputPorts.find((p) => p != null && p.name === port) : void 0)?.side) ?? "left";
			}
			function outputPortSide(a, port) {
				return asSide(a.outputPortSides?.[port]) ?? "right";
			}
			function portAnchor(a, kind, port) {
				const sideOf = (n) => kind === "in" ? inputPortSide(a, n) : outputPortSide(a, n);
				const side = sideOf(port);
				const sameSide = (kind === "in" ? inputPortNamesOf(a.id) : outputPortNamesOf(a.id)).filter((n) => sideOf(n) === side);
				const frac = (Math.max(0, sameSide.indexOf(port)) + 1) / (sameSide.length + 1);
				const t = (kind === "in" ? outputPortNamesOf(a.id) : inputPortNamesOf(a.id)).filter((n) => (kind === "in" ? outputPortSide(a, n) : inputPortSide(a, n)) === side).length > 0 ? kind === "in" ? frac * .5 : .5 + frac * .5 : frac;
				if (side === "left") return {
					x: a.x,
					y: a.y + NODE_H * t,
					side
				};
				if (side === "right") return {
					x: a.x + NODE_W,
					y: a.y + NODE_H * t,
					side
				};
				if (side === "top") return {
					x: a.x + NODE_W * t,
					y: a.y,
					side
				};
				return {
					x: a.x + NODE_W * t,
					y: a.y + NODE_H,
					side
				};
			}
			function sideMidAnchor(node, side) {
				const w = "branches" in node ? CONTROL_W : NODE_W;
				const h = "branches" in node ? CONTROL_H : NODE_H;
				if (side === "left") return {
					x: node.x,
					y: node.y + h / 2,
					side
				};
				if (side === "right") return {
					x: node.x + w,
					y: node.y + h / 2,
					side
				};
				if (side === "top") return {
					x: node.x + w / 2,
					y: node.y,
					side
				};
				return {
					x: node.x + w / 2,
					y: node.y + h,
					side
				};
			}
			function mintAnchorOf(node, side, kind) {
				const frac = ("branches" in node ? false : kind === "in" ? outputPortOnSide(node, side) !== null : inputPortOnSide(node, side) !== null) ? kind === "in" ? .25 : .75 : .5;
				const w = "branches" in node ? CONTROL_W : NODE_W;
				const h = "branches" in node ? CONTROL_H : NODE_H;
				if (side === "left") return {
					x: node.x,
					y: node.y + h * frac,
					side
				};
				if (side === "right") return {
					x: node.x + w,
					y: node.y + h * frac,
					side
				};
				if (side === "top") return {
					x: node.x + w * frac,
					y: node.y,
					side
				};
				return {
					x: node.x + w * frac,
					y: node.y + h,
					side
				};
			}
			function openSidesOf(node) {
				const used = /* @__PURE__ */ new Set();
				if ("branches" in node) {
					used.add("left");
					for (const name of branchNamesOf(node)) used.add(branchSideOf(node, name));
				} else {
					for (const n of inputPortNamesOf(node.id)) used.add(inputPortSide(node, n));
					for (const n of outputPortNamesOf(node.id)) used.add(outputPortSide(node, n));
				}
				return [
					"left",
					"right",
					"top",
					"bottom"
				].filter((s) => !used.has(s));
			}
			function controlInputAnchor(k) {
				return {
					x: k.x,
					y: k.y + CONTROL_H / 2,
					side: "left"
				};
			}
			function branchSideOf(k, branch) {
				return asSide(k.branches.find((b) => String(b.name ?? "") === branch)?.side) ?? "right";
			}
			function branchAnchor(k, branch) {
				const side = branchSideOf(k, branch);
				const sameSide = branchNamesOf(k).filter((n) => branchSideOf(k, n) === side);
				const frac = (Math.max(0, sameSide.indexOf(branch)) + 1) / (sameSide.length + 1);
				if (side === "left") return {
					x: k.x,
					y: k.y + CONTROL_H * frac,
					side
				};
				if (side === "right") return {
					x: k.x + CONTROL_W,
					y: k.y + CONTROL_H * frac,
					side
				};
				if (side === "top") return {
					x: k.x + CONTROL_W * frac,
					y: k.y,
					side
				};
				return {
					x: k.x + CONTROL_W * frac,
					y: k.y + CONTROL_H,
					side
				};
			}
			function onNodePointerDown(e, id, x, y, kind) {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				if (canvasRef.current) canvasRef.current.focus();
				e.currentTarget.setPointerCapture(e.pointerId);
				selectNode(id);
				dragRef.current = {
					id,
					kind,
					startClientX: e.clientX,
					startClientY: e.clientY,
					startX: x,
					startY: y
				};
			}
			function onNodePointerMove(e) {
				const d = dragRef.current;
				if (!d) return;
				const nx = d.startX + (e.clientX - d.startClientX);
				const ny = d.startY + (e.clientY - d.startClientY);
				if (d.kind === "control") setControls((prev) => prev.map((k) => k.id === d.id ? {
					...k,
					x: nx,
					y: ny
				} : k));
				else setAgents((prev) => prev.map((a) => a.id === d.id ? {
					...a,
					x: nx,
					y: ny
				} : a));
			}
			function onNodePointerUp() {
				dragRef.current = null;
			}
			function onPortPointerDown(e, nodeId, grab) {
				if (e.button !== 0) return;
				if (connectRef.current !== null) return;
				e.preventDefault();
				e.stopPropagation();
				if (canvasRef.current) canvasRef.current.focus();
				const p = canvasPoint(e.clientX, e.clientY);
				connectRef.current = {
					from: nodeId,
					cursor: {
						x: p.x,
						y: p.y
					},
					hoverTarget: null,
					..."port" in grab ? { startPort: grab.port } : { startSide: grab.side }
				};
				setConnectCursor({
					x: p.x,
					y: p.y
				});
				selectNode(nodeId);
			}
			function onNodePointerEnter(e, nodeId) {
				setHoverNodeId(nodeId);
				const c = connectRef.current;
				if (c !== null && c.from !== nodeId) {
					c.hoverTarget = nodeId;
					setHoverTarget(nodeId);
				}
			}
			function onNodePointerLeave(e, nodeId) {
				setHoverNodeId((prev) => prev === nodeId ? null : prev);
				const c = connectRef.current;
				if (c !== null && c.hoverTarget === nodeId) {
					c.hoverTarget = null;
					setHoverTarget(null);
				}
			}
			function onContainerPointerMove(e) {
				const c = connectRef.current;
				if (!c) return;
				const p = canvasPoint(e.clientX, e.clientY);
				c.cursor = p;
				setConnectCursor({
					x: p.x,
					y: p.y
				});
			}
			function landConnection(conn, agentUpdates) {
				if (Object.keys(agentUpdates).length > 0) setAgents((prev) => prev.map((a) => agentUpdates[a.id] !== void 0 ? {
					...a,
					...agentUpdates[a.id]
				} : a));
				setConnections((prev) => prev.concat([conn]));
			}
			function connFromVerdict(base, verdict) {
				return {
					...base,
					...verdict.sourcePort !== void 0 && verdict.sourcePort !== "out" ? { sourcePort: verdict.sourcePort } : {},
					...verdict.targetPort !== void 0 && verdict.targetPort !== "in" ? { targetPort: verdict.targetPort } : {}
				};
			}
			function onContainerPointerUp() {
				const c = connectRef.current;
				if (!c) return;
				const target = c.hoverTarget;
				if (target != null && target !== c.from) {
					if (!connections.some((conn) => conn.source === c.from && conn.target === target)) {
						const conn = {
							id: newId("conn"),
							source: c.from,
							target
						};
						const drop = dropSnapFor(target, c.cursor);
						const graph = buildGraph(agents, connections, controls);
						const draft = {
							source: conn.source,
							target,
							sourceSide: c.startSide ?? "right",
							targetSide: drop?.side ?? "left",
							grabbedSourcePort: c.startPort
						};
						const targetControl = controls.find((k) => k.id === target);
						if (controls.some((k) => k.id === c.from)) {
							const branches = branchNamesOf(controls.find((k) => k.id === c.from));
							const picked = c.startPort !== void 0 && branches.includes(c.startPort) ? c.startPort : branches[0] ?? "";
							setEdgeDraft({
								id: conn.id,
								source: conn.source,
								target,
								sourceSide: draft.sourceSide,
								targetSide: draft.targetSide,
								picked
							});
						} else if (targetControl !== void 0 && agents.some((a) => a.id === c.from && (a.outputPorts !== void 0 || a.bindings !== void 0))) setOwnerHandoff({
							conn,
							control: targetControl,
							...c.startPort !== void 0 ? { grabbedSourcePort: c.startPort } : {}
						});
						else {
							const verdict = resolveWireDrop(graph, draft);
							landConnection(connFromVerdict(conn, verdict), verdict.agentUpdates);
						}
					}
				}
				connectRef.current = null;
				setHoverTarget(null);
				setConnectCursor(null);
			}
			function onContainerPointerLeave() {
				if (connectRef.current) {
					connectRef.current = null;
					setHoverTarget(null);
					setConnectCursor(null);
				}
				setHoverNodeId(null);
			}
			function onCanvasPointerDown(e) {
				if (canvasRef.current) canvasRef.current.focus();
				selectNode(null);
				if (connectRef.current) {
					connectRef.current = null;
					setHoverTarget(null);
					setConnectCursor(null);
				}
			}
			function addAgentFromToolbar() {
				const n = agents.length;
				addAgent(60 + n % 4 * 40, 40 + n % 6 * 34);
			}
			function deleteNode(nodeId) {
				const selectedConn = selectedEdgeId !== null ? connections.find((c) => c.id === selectedEdgeId) : void 0;
				if (controls.some((k) => k.id === nodeId)) {
					const kept = connections.filter((c) => c.source !== nodeId && c.target !== nodeId);
					const removed = connections.filter((c) => c.source === nodeId || c.target === nodeId);
					const updates = retractOrphanPorts(buildGraph(agents, kept, controls), removed).agentUpdates;
					setControls((prev) => prev.filter((k) => k.id !== nodeId));
					if (Object.keys(updates).length > 0) setAgents((prev) => prev.map((a) => updates[a.id] !== void 0 ? {
						...a,
						...updates[a.id]
					} : a));
					setConnections(kept);
					if (selectedConn !== void 0 && removed.includes(selectedConn)) setSelectedEdgeId(null);
				} else {
					const dying = new Set(controls.filter((k) => connections.some((c) => c.source === nodeId && c.target === k.id)).map((k) => k.id));
					const keptAgents = agents.filter((a) => a.id !== nodeId);
					const keptControls = controls.filter((k) => !dying.has(k.id));
					const removed = connections.filter((c) => c.source === nodeId || c.target === nodeId || dying.has(c.source) || dying.has(c.target));
					const kept = connections.filter((c) => !removed.includes(c));
					const updates = retractOrphanPorts(buildGraph(keptAgents, kept, keptControls), removed).agentUpdates;
					setAgents(keptAgents.map((a) => updates[a.id] !== void 0 ? {
						...a,
						...updates[a.id]
					} : a));
					setControls((prev) => prev.filter((k) => !dying.has(k.id)));
					setConnections(kept);
					if (selectedConn !== void 0 && removed.includes(selectedConn)) setSelectedEdgeId(null);
				}
				if (selectedId === nodeId) setSelectedId(null);
			}
			function deleteEdge(connId) {
				const conn = connections.find((c) => c.id === connId);
				const kept = conn !== void 0 ? connections.filter((c) => c.id !== connId) : connections;
				setConnections(kept);
				if (conn !== void 0) {
					const retract = retractOrphanPorts(buildGraph(agents, kept, controls), [conn]);
					if (Object.keys(retract.agentUpdates).length > 0) setAgents((prev) => prev.map((a) => retract.agentUpdates[a.id] !== void 0 ? {
						...a,
						...retract.agentUpdates[a.id]
					} : a));
				}
				if (selectedEdgeId === connId) setSelectedEdgeId(null);
			}
			function deleteSelected() {
				if (selectedId) {
					deleteNode(selectedId);
					return;
				}
				if (selectedEdgeId) deleteEdge(selectedEdgeId);
			}
			function clearAll() {
				setAgents([]);
				setConnections([]);
				setControls([]);
				selectNode(null);
				setHoverTarget(null);
				setConnectCursor(null);
				dragRef.current = null;
				connectRef.current = null;
				setSeq(1);
				idRef.current = 0;
				setRunResult(null);
				setResultOpen(false);
				setShowRunModal(false);
				setDoneRun(null);
				setNodeMenu(null);
				runTextRef.current = "";
				runFilesRef.current = [];
			}
			function onNodeContextMenu(e, nodeId) {
				e.preventDefault();
				e.stopPropagation();
				selectNode(nodeId);
				if (connectRef.current) return;
				setNodeMenu({
					kind: "node",
					id: nodeId,
					x: e.clientX,
					y: e.clientY
				});
			}
			function onEdgeContextMenu(e, connId) {
				e.preventDefault();
				e.stopPropagation();
				selectEdge(connId);
				if (connectRef.current) return;
				setNodeMenu({
					kind: "edge",
					id: connId,
					x: e.clientX,
					y: e.clientY
				});
			}
			function nodeMenuEntries(node) {
				if ("branches" in node) return [
					{
						id: "edit",
						label: "Edit branches"
					},
					{
						type: "separator",
						id: "menu-sep-delete"
					},
					{
						id: "delete",
						label: "Delete control",
						danger: true
					}
				];
				const childSessionId = runProjection?.nodes[node.id]?.childSessionId;
				return [
					{
						id: "transcript",
						label: "Go to transcript",
						disabled: typeof childSessionId !== "string" || childSessionId.length === 0
					},
					{
						type: "separator",
						id: "menu-sep-edit"
					},
					{
						id: "edit",
						label: "Edit agent"
					},
					{
						id: "breakpoint",
						label: node.breakpoint ? "Disarm breakpoint" : "Arm breakpoint"
					},
					{
						type: "separator",
						id: "menu-sep-delete"
					},
					{
						id: "delete",
						label: "Delete agent",
						danger: true
					}
				];
			}
			function runNodeMenuAction(id) {
				if (nodeMenu === null) return;
				if (nodeMenu.kind === "edge") {
					if (id === "delete") deleteEdge(nodeMenu.id);
					return;
				}
				const nodeId = nodeMenu.id;
				const menuIsControl = controls.some((k) => k.id === nodeId);
				if (id === "edit") {
					if (menuIsControl) setConfigControlId(nodeId);
					else setConfigAgentId(nodeId);
				} else if (id === "breakpoint") setAgents((prev) => prev.map((a) => a.id === nodeId ? {
					...a,
					breakpoint: !a.breakpoint
				} : a));
				else if (id === "delete") deleteNode(nodeId);
				else if (id === "transcript") {
					const childSessionId = runProjection?.nodes[nodeId]?.childSessionId;
					if (typeof childSessionId === "string" && childSessionId.length > 0) openTranscript(childSessionId);
				}
			}
			const runActive = activeRun !== null && (activeRun.state === "running" || activeRun.state === "paused");
			const runProjection = runActive && activeRun !== null ? projectNodes(activeRun) : doneRun !== null ? projectNodes(doneRun) : null;
			const pausedNodeId = runActive && activeRun?.state === "paused" ? runProjection?.pausedNodeId ?? null : null;
			const failedNodeId = runActive && runProjection !== null ? runProjection.order.find((id) => runProjection.nodes[id]?.status === "error") ?? null : null;
			const queuedCount = pausedNodeId !== null && runProjection ? runProjection.pausedQueue.length - 1 : 0;
			const inspectOpen = pausedNodeId !== null && activeRun !== null && typeof activeRun.runId === "string" && inspectDismissedFor !== activeRun.runId + ":" + (activeRun.pausedAt ?? pausedNodeId);
			const loopControls = react.useMemo(() => loopControlIds(buildGraph(agents, connections, controls)), [
				agents,
				connections,
				controls
			]);
			function controlRunState(control) {
				if (runProjection === null) return null;
				const sourceId = connections.find((c) => c.target === control.id)?.source;
				const node = sourceId !== void 0 ? runProjection.nodes[sourceId] : void 0;
				if (node === void 0 || node.firings.length === 0) return {
					state: "idle",
					chosen: []
				};
				const firing = node.firings[node.firings.length - 1];
				const iter = loopControls.has(control.id) ? {
					count: node.firings.length,
					threshold: countThreshold(control.branches)
				} : void 0;
				const withIter = iter !== void 0 ? { iter } : {};
				if (!Array.isArray(firing.emittedTo)) return {
					state: "armed",
					chosen: [],
					...withIter
				};
				const chosen = firedBranches(control.branches, firing.emittedTo);
				return chosen.length > 0 ? {
					state: "fired",
					chosen,
					...withIter
				} : {
					state: "quiet",
					chosen: [],
					...withIter
				};
			}
			function disconnectRunEvents() {
				if (sseRef.current !== null) {
					sseRef.current.close();
					sseRef.current = null;
				}
			}
			function connectRunEvents(runId) {
				disconnectRunEvents();
				if (typeof cwdRef.current !== "string" || cwdRef.current.length === 0) return;
				const source = new EventSource(ENDPOINT + "/run/events?id=" + encodeURIComponent(runId) + "&cwd=" + encodeURIComponent(cwdRef.current));
				sseRef.current = source;
				const onRecord = (event) => {
					let rec = null;
					try {
						rec = JSON.parse(event.data);
					} catch {
						rec = null;
					}
					if (rec === null || typeof rec !== "object") return;
					adoptRecord(rec);
				};
				source.addEventListener("snapshot", onRecord);
				source.addEventListener("update", onRecord);
			}
			function adoptRecord(rec) {
				const state = rec.state;
				if (state === "running" || state === "paused") {
					setActiveRun(rec);
					return;
				}
				disconnectRunEvents();
				setActiveRun(null);
				setDoneRun(rec);
				setRunResult(recordToResult(rec));
				setResultOpen(true);
				setNodeMenu(null);
			}
			function recordToResult(rec, list) {
				const nameIn = (id) => {
					for (const a of list ?? agents) if (a.id === id) return a.name;
					return id;
				};
				const projection = projectNodes(rec);
				const lowered = lowerControls(rec.graph);
				const runs = topoOrder(lowered).map((id) => {
					const node = projection.nodes[id];
					return {
						id,
						label: nameIn(id),
						status: node?.status ?? "pending",
						...node?.error ? { error: node.error } : {},
						...node?.childSessionId ? { childSessionId: node.childSessionId } : {}
					};
				});
				if (rec.state === "error") return {
					ok: false,
					error: "The run failed — see the per-agent statuses below.",
					runs
				};
				const terminals = classifyGraph(lowered).terminals;
				const outputs = {};
				for (const id of terminals) {
					const output = projection.nodes[id]?.output;
					if (typeof output === "string") outputs[id] = output;
				}
				return {
					ok: true,
					outputs,
					runs,
					...rec.state === "aborted" ? { aborted: true } : {}
				};
			}
			function run(text, files, maxInFlight) {
				if (runActive || startPending) return;
				runTextRef.current = text;
				runFilesRef.current = files;
				const workspace = cwdRef.current;
				if (typeof workspace !== "string" || workspace.length === 0) {
					setRunResult({
						ok: false,
						error: "the pipeline's workspace root is not known yet — reopen this view and try again"
					});
					setResultOpen(true);
					return;
				}
				const g = buildGraph(agents, connections, controls);
				setStartPending(true);
				setRunResult(null);
				setDoneRun(null);
				setShowRunModal(false);
				setInspectDismissedFor(null);
				setControlStatus(null);
				fetch(ENDPOINT + "/run", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						sessionId,
						cwd: workspace,
						graph: g,
						input: composePipelineInput(text, files),
						...maxInFlight !== null ? { maxInFlight } : {}
					})
				}).then(async (r) => {
					let data = null;
					try {
						data = await r.json();
					} catch {
						data = null;
					}
					if (!r.ok || data === null || data.ok !== true || typeof data.runId !== "string") {
						const detail = typeof data?.error === "string" ? data.error : "HTTP " + r.status;
						const other = typeof data?.activeRunId === "string" ? ` (run ${data.activeRunId.slice(0, 8)}…)` : "";
						throw new Error(detail + other);
					}
					return data.runId;
				}).then((runId) => {
					if (sessionIdRef.current !== sessionId) return;
					connectRunEvents(runId);
				}).catch((err) => {
					if (sessionIdRef.current !== sessionId) return;
					setRunResult({
						ok: false,
						error: err instanceof Error ? err.message : String(err)
					});
					setResultOpen(true);
				}).finally(() => {
					setStartPending(false);
				});
			}
			async function controlRun(action, feedback) {
				const rec = activeRun;
				const workspace = cwdRef.current;
				if (!rec || typeof rec.runId !== "string" || typeof workspace !== "string") return;
				setControlBusy(action);
				setControlStatus(null);
				try {
					const r = await fetch(ENDPOINT + "/control", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							runId: rec.runId,
							cwd: workspace,
							action,
							...feedback !== void 0 ? { feedback } : {}
						})
					});
					let data = null;
					try {
						data = await r.json();
					} catch {
						data = null;
					}
					if (!r.ok || data === null || data.ok !== true) throw new Error(typeof data?.error === "string" ? data.error : "HTTP " + r.status);
				} catch (err) {
					setControlStatus(err instanceof Error ? err.message : String(err));
				} finally {
					setControlBusy(null);
				}
			}
			function openTranscript(childSessionId) {
				if (childSessionId === sessionId) {
					if (typeof openView === "function") openView("chat", "");
					else if (onDismiss) onDismiss();
					return;
				}
				const sessions = services && services.sessions;
				if (sessions && typeof sessions.open === "function") {
					requestChatView(childSessionId);
					sessions.open(childSessionId);
				}
				if (onDismiss) onDismiss();
			}
			function queryFiles(query, signal) {
				const remote = services && services.remote;
				if (!remote || !remote.fileReferences || typeof remote.fileReferences.list !== "function") return Promise.reject(/* @__PURE__ */ new Error("file references unavailable"));
				return remote.fileReferences.list(sessionId, query, signal).then((r) => r && r.ok === true && Array.isArray(r.value) ? r.value : []);
			}
			function nameOf(id) {
				for (const a of agents) if (a.id === id) return a.name;
				return id;
			}
			/** The node's output port names — an agent's declared outputs, a control's branch names. */
			function outputPortNamesOf(id) {
				const control = controls.find((k) => k.id === id);
				if (control !== void 0) return branchNamesOf(control);
				const a = agents.find((x) => x.id === id);
				return a && Array.isArray(a.outputPorts) && a.outputPorts.length > 0 ? a.outputPorts : ["out"];
			}
			/** The control's declared branch names, in evaluation order. */
			function branchNamesOf(control) {
				return control.branches.map((b) => String(b.name ?? "")).filter((n) => n.length > 0);
			}
			/** The node's input port names (declared, else the single "in"; a control takes one unnamed input). */
			function inputPortNamesOf(id) {
				const a = agents.find((x) => x.id === id);
				return a && Array.isArray(a.inputPorts) && a.inputPorts.length > 0 ? a.inputPorts.map((p) => p.name) : ["in"];
			}
			/** The port NAME a persisted wire id carries ("<agentId>:<name>" → name). */
			function portNameOf(wire, agentId, fallback) {
				const s = String(wire ?? "");
				return s.startsWith(agentId + ":") ? s.slice(agentId.length + 1) : fallback;
			}
			/** Complete a control-sourced draft: the picked branch pins the source; the
			* target side resolves/mints exactly like a direct drop (one resolver, one
			* commit — the same patches any other landing applies). */
			function confirmEdgeDraft() {
				const d = edgeDraft;
				if (!d) return;
				setEdgeDraft(null);
				const verdict = resolveWireDrop(buildGraph(agents, connections, controls), {
					source: d.source,
					target: d.target,
					sourceSide: d.sourceSide,
					targetSide: d.targetSide,
					grabbedSourcePort: d.picked
				});
				landConnection(connFromVerdict({
					id: d.id,
					source: d.source,
					target: d.target
				}, verdict), verdict.agentUpdates);
			}
			/** The picker's "to" line: what the landed side will receive. */
			function edgeDraftTargetText() {
				const d = edgeDraft;
				if (!d) return "";
				if (controls.some((k) => k.id === d.target)) return "the control's single unnamed input";
				const agent = agents.find((a) => a.id === d.target);
				const port = agent !== void 0 ? inputPortOnSide(agent, d.targetSide) : null;
				return port !== null ? "input port " + port : "a new input port on the " + d.targetSide + " edge";
			}
			function moveEmissionInto(source) {
				const branches = [];
				const seen = /* @__PURE__ */ new Set();
				const sideFor = (port) => source.outputPortSides?.[port];
				for (const b of Array.isArray(source.bindings) ? source.bindings : []) {
					const port = typeof b?.port === "string" ? b.port : "";
					if (port.length === 0 || seen.has(port)) continue;
					seen.add(port);
					const side = sideFor(port);
					branches.push({
						name: port,
						field: typeof b?.field === "string" ? b.field : "",
						...b?.value !== void 0 && b.value !== "" ? { value: String(b.value) } : {},
						...b?.op === ">=" ? { op: ">=" } : {},
						...side !== void 0 && side !== "right" ? { side } : {}
					});
				}
				for (const port of Array.isArray(source.outputPorts) ? source.outputPorts : []) {
					if (typeof port !== "string" || port.length === 0 || seen.has(port)) continue;
					seen.add(port);
					const side = sideFor(port);
					branches.push({
						name: port,
						field: "",
						...side !== void 0 && side !== "right" ? { side } : {}
					});
				}
				return branches;
			}
			function appendBranches(control, moved) {
				const names = new Set(control.branches.map((b) => String(b.name ?? "")));
				const fresh = moved.filter((b) => !names.has(b.name));
				if (fresh.length === 0) return control.branches;
				const last = control.branches[control.branches.length - 1];
				const cut = control.branches.length - (last !== void 0 && (last.value === void 0 || last.value === "") ? 1 : 0);
				return control.branches.slice(0, cut).concat(fresh, control.branches.slice(cut));
			}
			function resolveOwnerHandoff(mode) {
				const handoff = ownerHandoff;
				if (handoff === null) return;
				setOwnerHandoff(null);
				if (mode !== "dismiss") {
					const strip = (a) => a.id === handoff.conn.source ? {
						...a,
						outputPorts: void 0,
						outputPortSides: void 0,
						bindings: void 0
					} : a;
					if (mode === "move") {
						const source = agents.find((a) => a.id === handoff.conn.source);
						if (source !== void 0) {
							const moved = moveEmissionInto(source);
							setControls((prev) => prev.map((k) => k.id === handoff.control.id ? {
								...k,
								branches: appendBranches(k, moved)
							} : k));
						}
					}
					setAgents((prev) => prev.map(strip));
					landConnection(handoff.conn, {});
					return;
				}
				const source = agents.find((a) => a.id === handoff.conn.source);
				const declared = source !== void 0 && Array.isArray(source.outputPorts) ? source.outputPorts.filter((n) => typeof n === "string" && n.length > 0) : [];
				const grabbed = handoff.grabbedSourcePort;
				const sourcePort = grabbed !== void 0 && declared.includes(grabbed) ? grabbed : "out";
				landConnection({
					...handoff.conn,
					...sourcePort !== "out" ? { sourcePort } : {}
				}, {});
			}
			const continueText = runResult && runResult.ok ? finalOutputText(runResult.outputs || {}, nameOf) : "";
			function stageDraft(targetSessionId, text) {
				if (text.length === 0) return false;
				if (targetSessionId === sessionId && inputActions && typeof inputActions.setDraft === "function") {
					inputActions.setDraft(text);
					return true;
				}
				const conversation = services && services.conversation;
				if (conversation && conversation.input && typeof conversation.input.shell === "function") try {
					conversation.input.shell(targetSessionId).setDraft(text);
					return true;
				} catch {}
				return false;
			}
			function continueInChat() {
				if (!stageDraft(sessionId, continueText)) {
					setContinueStatus("Composer access is unavailable in this view.");
					return;
				}
				if (typeof openView === "function") openView("chat", "");
				else if (onDismiss) onDismiss();
				setResultOpen(false);
			}
			async function continueInNewSession() {
				setContinueBusy("new");
				setContinueStatus(null);
				try {
					const uiWorkspace = services && services.uiWorkspace;
					const ws = (cwd ? workspaceItems.find((w) => w.path === cwd) : void 0) || workspaceItems.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sessionId) !== -1);
					if (!ws || typeof ws.workspaceId !== "string" || !uiWorkspace || typeof uiWorkspace.connectWorkspace !== "function") throw new Error("this pipeline's folder is not a connected workspace — connect the folder in the sidebar first");
					const newId = await uiWorkspace.connectWorkspace(ws.workspaceId);
					if (typeof newId !== "string" || newId.length === 0) throw new Error("no session could be created for this workspace");
					const sessions = services && services.sessions;
					if (sessions && typeof sessions.open === "function") {
						requestChatView(newId);
						sessions.open(newId);
					}
					if (!stageDraft(newId, continueText)) throw new Error("composer access unavailable");
					setResultOpen(false);
					if (onDismiss) onDismiss();
				} catch (err) {
					setContinueStatus("Could not start a new session: " + String(err));
				} finally {
					setContinueBusy(null);
				}
			}
			async function sendToSession(targetId) {
				setContinueBusy("send");
				setContinueStatus(null);
				try {
					const sessions = services && services.sessions;
					if (sessions && typeof sessions.open === "function") {
						requestChatView(targetId);
						sessions.open(targetId);
					}
					if (!stageDraft(targetId, continueText)) throw new Error("composer access unavailable");
					setResultOpen(false);
					if (onDismiss) onDismiss();
				} catch (err) {
					setContinueStatus("Could not stage the output: " + String(err));
				} finally {
					setContinueBusy(null);
				}
			}
			const targets = Object.values(sessionRows).filter((r) => r && typeof r.id === "string" && r.id !== sessionId && r.cwd === cwd && !r.parentId && !r.blank && r.origin !== "subagent").sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((r) => {
				const label = r.displayTitle || r.title || r.id;
				return {
					id: r.id,
					label: label + " · " + r.id.slice(-6)
				};
			});
			function onKeyDown(e) {
				if (e.key === "Delete" || e.key === "Backspace") {
					e.preventDefault();
					deleteSelected();
				}
				if (e.key === "Escape") {
					if (connectRef.current) {
						connectRef.current = null;
						setHoverTarget(null);
						setConnectCursor(null);
					}
				}
			}
			function handleDragOver(e) {
				e.preventDefault();
			}
			function handleCanvasDrop(e) {
				e.preventDefault();
				if (e.dataTransfer.getData("application/x-pipeline-agent") === "agent") {
					const p = canvasPoint(e.clientX, e.clientY);
					addAgent(p.x - NODE_W / 2, p.y - NODE_H / 2);
				} else if (e.dataTransfer.getData("application/x-pipeline-control") === "if") {
					const p = canvasPoint(e.clientX, e.clientY);
					addControl(p.x - CONTROL_W / 2, p.y - CONTROL_H / 2);
				}
			}
			react.useEffect(() => {
				disconnectRunEvents();
				setActiveRun(null);
				setDoneRun(null);
				setRunResult(null);
				setResultOpen(false);
				setNodeMenu(null);
				selectNode(null);
				if (saveTimerRef.current) {
					clearTimeout(saveTimerRef.current);
					saveTimerRef.current = null;
				}
				if (typeof cwd !== "string" || cwd.length === 0) return;
				let cancelled = false;
				fetch(ENDPOINT + "?cwd=" + encodeURIComponent(cwd) + (sessionId.length > 0 ? "&sessionId=" + encodeURIComponent(sessionId) : ""), { cache: "no-store" }).then((r) => r.json()).then((data) => {
					if (cancelled) return;
					const p = data && data.ok === true ? data.pipeline : null;
					const as = p && Array.isArray(p.agents) ? p.agents : [];
					const cs = p && Array.isArray(p.connections) ? p.connections : [];
					const ks = loadControls(p == null ? void 0 : p.controls);
					skipNextPersistRef.current = true;
					loadedRef.current = true;
					const loaded = as.map((a) => {
						const load = loadAgent(a);
						const r = a ?? {};
						return {
							id: String(r.id),
							name: String(r.name),
							description: String(r.description || ""),
							...load.systemPrompt.length > 0 ? { systemPrompt: load.systemPrompt } : {},
							instructions: String(r.instructions || ""),
							x: Number(r.x) || 0,
							y: Number(r.y) || 0,
							...load.inputPorts !== void 0 ? { inputPorts: load.inputPorts } : {},
							...load.outputPorts !== void 0 ? { outputPorts: load.outputPorts } : {},
							...load.outputPortSides !== void 0 ? { outputPortSides: load.outputPortSides } : {},
							...load.bindings !== void 0 ? { bindings: load.bindings } : {},
							settings: load.settings,
							...r.breakpoint === true ? { breakpoint: true } : {}
						};
					});
					setAgents(loaded);
					setControls(ks);
					setConnections(cs.map((c) => {
						const source = String(c.source);
						const target = String(c.target);
						return {
							id: String(c.id),
							source,
							target,
							sourcePort: portNameOf(c.sourcePort, source, "out"),
							targetPort: portNameOf(c.targetPort, target, "in")
						};
					}));
					let maxId = 0;
					as.forEach((a) => {
						const n = numericSuffix(a.id);
						if (n > maxId) maxId = n;
					});
					cs.forEach((c) => {
						const n = numericSuffix(c.id);
						if (n > maxId) maxId = n;
					});
					ks.forEach((k) => {
						const n = numericSuffix(k.id);
						if (n > maxId) maxId = n;
					});
					idRef.current = maxId;
					let maxSeq = 0;
					as.forEach((a) => {
						const m = /^Agent\s+(\d+)$/.exec(String(a.name));
						const v = m ? parseInt(m[1], 10) : 0;
						if (v > maxSeq) maxSeq = v;
					});
					setSeq(maxSeq + 1);
					const active = data && data.ok === true && data.run !== null && typeof data.run === "object" ? data.run : null;
					if (active !== null && (active.state === "running" || active.state === "paused") && typeof active.runId === "string") {
						setActiveRun(active);
						connectRunEvents(active.runId);
					} else {
						const last = data && data.ok === true && data.lastRun !== null && typeof data.lastRun === "object" ? data.lastRun : null;
						if (last !== null && last.state !== "running" && last.state !== "paused") {
							setDoneRun(last);
							setRunResult(recordToResult(last, loaded));
						}
					}
				}).catch(() => {
					loadedRef.current = true;
				});
				return () => {
					cancelled = true;
				};
			}, [cwd, sessionId]);
			react.useEffect(() => {
				stateRef.current = {
					agents,
					connections,
					controls
				};
				if (!loadedRef.current) return;
				if (skipNextPersistRef.current) {
					skipNextPersistRef.current = false;
					return;
				}
				if (!(typeof cwdRef.current === "string" && cwdRef.current.length > 0)) return;
				if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
				saveTimerRef.current = setTimeout(() => {
					saveTimerRef.current = null;
					const g = buildGraph(stateRef.current.agents, stateRef.current.connections, stateRef.current.controls);
					fetch(ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							cwd: cwdRef.current,
							...sessionIdRef.current.length > 0 ? { sessionId: sessionIdRef.current } : {},
							graph: g
						})
					}).catch(() => {});
				}, 250);
			}, [
				agents,
				connections,
				controls
			]);
			const gesture = connectRef.current;
			const aim = gesture !== null && hoverTarget !== null ? dropSnapFor(hoverTarget, gesture.cursor) : null;
			const EDGE_OFF = 60;
			const BRACKET_CLEAR = 30;
			const BRACKET_R = 8;
			function edgeGeometry(s, t) {
				if (s.side === t.side && (s.side === "top" || s.side === "bottom")) {
					const down = s.side === "bottom";
					const vdir = down ? 1 : -1;
					const lane = down ? Math.max(s.y, t.y) + BRACKET_CLEAR : Math.min(s.y, t.y) - BRACKET_CLEAR;
					const sx = Math.sign(t.x - s.x);
					const r = Math.min(BRACKET_R, Math.abs(t.x - s.x) / 2, Math.abs(lane - s.y), Math.abs(lane - t.y));
					let d;
					if (!Number.isFinite(r) || r < 1 || sx === 0) d = "M" + s.x + " " + s.y + " L" + s.x + " " + lane + " L" + t.x + " " + lane + " L" + t.x + " " + t.y;
					else d = "M" + s.x + " " + s.y + " L" + s.x + " " + (lane - vdir * r) + " Q" + s.x + " " + lane + " " + (s.x + sx * r) + " " + lane + " L" + (t.x - sx * r) + " " + lane + " Q" + t.x + " " + lane + " " + t.x + " " + (lane - vdir * r) + " L" + t.x + " " + t.y;
					return {
						d,
						mx: (s.x + t.x) / 2,
						my: down ? lane - 8 : lane + 14
					};
				}
				const n1 = SIDE_NORMAL[s.side], n2 = SIDE_NORMAL[t.side];
				let c1, c2;
				if (n1.y === 0 && n2.y === 0 && t.x < s.x - 1) {
					const lane = Math.max(s.y, t.y) + NODE_H / 2 + 46;
					c1 = {
						x: s.x + EDGE_OFF,
						y: lane
					};
					c2 = {
						x: t.x - EDGE_OFF,
						y: lane
					};
				} else {
					c1 = {
						x: s.x + n1.x * EDGE_OFF,
						y: s.y + n1.y * EDGE_OFF
					};
					c2 = {
						x: t.x + n2.x * EDGE_OFF,
						y: t.y + n2.y * EDGE_OFF
					};
				}
				const d = "M" + s.x + " " + s.y + " C" + c1.x + " " + c1.y + " " + c2.x + " " + c2.y + " " + t.x + " " + t.y;
				const mx = (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8;
				const my = (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8;
				const tgx = t.x + c2.x - c1.x - s.x;
				const tgy = t.y + c2.y - c1.y - s.y;
				const tgLen = Math.hypot(tgx, tgy);
				let nx = tgLen > 0 ? -tgy / tgLen : 0;
				let ny = tgLen > 0 ? tgx / tgLen : -1;
				if (ny > 0 || ny === 0 && nx > 0) {
					nx = -nx;
					ny = -ny;
				}
				return {
					d,
					mx: mx + nx * 11,
					my: my + ny * 11
				};
			}
			function findNode(id) {
				for (const a of agents) if (a.id === id) return a;
				for (const k of controls) if (k.id === id) return k;
				return null;
			}
			function outputAnchorOf(node, port) {
				return "branches" in node ? branchAnchor(node, port) : portAnchor(node, "out", port);
			}
			function inputAnchorOf(node, port) {
				return "branches" in node ? controlInputAnchor(node) : portAnchor(node, "in", port);
			}
			function dropSnapFor(nodeId, pt) {
				const node = findNode(nodeId);
				if (node === null || pt === null) return null;
				if ("branches" in node) return {
					side: "left",
					port: "in"
				};
				const dx = pt.x - (node.x + NODE_W / 2);
				const dy = pt.y - (node.y + NODE_H / 2);
				const side = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "bottom" : "top";
				return {
					side,
					port: inputPortOnSide(node, side)
				};
			}
			const edges = connections.map((c) => {
				const src = findNode(c.source);
				const tgt = findNode(c.target);
				if (!src || !tgt) return null;
				const sourceName = c.sourcePort ?? "out";
				const targetName = c.targetPort ?? "in";
				const s = outputAnchorOf(src, sourceName);
				const t = inputAnchorOf(tgt, targetName);
				const labeled = !("branches" in src) && (sourceName !== "out" || targetName !== "in");
				const controlState = "branches" in src ? controlRunState(src) : null;
				const edgeState = controlState !== null && (controlState.state === "fired" || controlState.state === "quiet") ? controlState.chosen.indexOf(sourceName) !== -1 ? "fired" : "quiet" : "";
				const geo = edgeGeometry(s, t);
				const selected = selectedEdgeId === c.id;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
					className: "pipeline-edge-group",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: geo.d,
							className: "pipeline-edge" + (edgeState !== "" ? " pipeline-edge-" + edgeState : "") + (selected ? " pipeline-edge-selected" : ""),
							markerEnd: selected ? "url(#pipeline-arrow-selected)" : edgeState === "fired" ? "url(#pipeline-arrow-fired)" : "url(#pipeline-arrow)"
						}),
						labeled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
							x: geo.mx,
							y: geo.my,
							className: "pipeline-edge-label",
							textAnchor: "middle",
							children: sourceName + " → " + targetName
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: geo.d,
							className: "pipeline-edge-hit",
							onPointerDown: (e) => {
								if (e.button !== 0) return;
								e.preventDefault();
								e.stopPropagation();
								if (canvasRef.current) canvasRef.current.focus();
								if (!connectRef.current) selectEdge(c.id);
							},
							onContextMenu: (e) => {
								onEdgeContextMenu(e, c.id);
							}
						})
					]
				}, c.id);
			});
			let tempEdge = null;
			if (gesture) {
				const src0 = findNode(gesture.from);
				if (src0) {
					const s0 = gesture.startPort !== void 0 ? outputAnchorOf(src0, gesture.startPort) : "branches" in src0 ? sideMidAnchor(src0, gesture.startSide ?? "right") : mintAnchorOf(src0, gesture.startSide ?? "right", "out");
					let end0 = {
						x: gesture.cursor.x,
						y: gesture.cursor.y,
						side: "left"
					};
					if (aim !== null && hoverTarget !== null) {
						const tgt0 = findNode(hoverTarget);
						if (tgt0 !== null) end0 = aim.port !== null ? inputAnchorOf(tgt0, aim.port) : mintAnchorOf(tgt0, aim.side, "in");
					}
					tempEdge = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: edgeGeometry(s0, end0).d,
						className: "pipeline-edge-temp"
					});
				}
			}
			const nodes = agents.map((agent) => {
				const selected = agent.id === selectedId;
				const hoveredIn = hoverTarget === agent.id && gesture;
				const status = (runProjection !== null ? runProjection.nodes[agent.id] : void 0)?.status;
				const liveStatus = status !== void 0 && status !== "pending" ? status : null;
				const reveal = gesture !== null ? gesture.from === agent.id ? " reveal-full" : " reveal-in" : hoverNodeId === agent.id || selected ? " reveal-full" : "";
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-node" + (selected ? " selected" : "") + (liveStatus !== null ? " node-" + liveStatus : "") + reveal,
					style: {
						left: agent.x + "px",
						top: agent.y + "px"
					},
					"data-agent-id": agent.id,
					"data-node-status": status ?? "",
					onPointerDown: (e) => {
						onNodePointerDown(e, agent.id, agent.x, agent.y, "agent");
					},
					onPointerEnter: (e) => {
						onNodePointerEnter(e, agent.id);
					},
					onPointerLeave: (e) => {
						onNodePointerLeave(e, agent.id);
					},
					onPointerMove: onNodePointerMove,
					onPointerUp: onNodePointerUp,
					onContextMenu: (e) => {
						onNodeContextMenu(e, agent.id);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "node-breakpoint" + (agent.breakpoint ? " armed" : ""),
							title: agent.breakpoint ? "Breakpoint armed — the run pauses after this agent finishes (click to disarm)" : "Arm a breakpoint — pause the run after this agent finishes",
							"aria-label": (agent.breakpoint ? "Disarm breakpoint on " : "Arm breakpoint on ") + agent.name,
							onPointerDown: (e) => {
								e.stopPropagation();
							},
							onClick: (e) => {
								e.stopPropagation();
								setAgents((prev) => prev.map((a) => a.id === agent.id ? {
									...a,
									breakpoint: !a.breakpoint
								} : a));
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
								width: 10,
								height: 10,
								viewBox: "0 0 24 24",
								"aria-hidden": "true",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: 12,
									cy: 12,
									r: 8,
									fill: "currentColor"
								})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "node-name",
							children: agent.name
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "node-sub",
							children: agent.id
						}),
						liveStatus !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "node-badge status-" + liveStatus,
							title: RUN_STATUS_TITLE[liveStatus],
							"aria-label": agent.name + ": " + RUN_STATUS_TITLE[liveStatus],
							children: statusBadgeIcon(liveStatus)
						}) : null,
						inputPortNamesOf(agent.id).map((portName) => {
							const anchor = portAnchor(agent, "in", portName);
							const multiple = inputPortNamesOf(agent.id).length > 1 || anchor.side !== "left";
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "pipeline-port in" + (hoveredIn && aim !== null && aim.port === portName ? " hover" : ""),
								style: {
									left: anchor.x - agent.x + "px",
									top: anchor.y - agent.y + "px"
								},
								onPointerDown: (e) => {
									onPortPointerDown(e, agent.id, { side: anchor.side });
								},
								title: multiple ? portName + " — drag from this edge to make it an output" : "Input — drag from this edge to make it an output"
							}, portName);
						}),
						outputPortNamesOf(agent.id).map((portName) => {
							const anchor = portAnchor(agent, "out", portName);
							const multiple = outputPortNamesOf(agent.id).length > 1 || anchor.side !== "right";
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "pipeline-port out",
								style: {
									left: anchor.x - agent.x + "px",
									top: anchor.y - agent.y + "px"
								},
								onPointerDown: (e) => {
									onPortPointerDown(e, agent.id, { port: portName });
								},
								title: multiple ? portName : "Output"
							}, portName);
						}),
						openSidesOf(agent).map((side) => {
							const anchor = sideMidAnchor(agent, side);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "pipeline-port ghost" + (hoveredIn && aim !== null && aim.port === null && aim.side === side ? " hover" : ""),
								style: {
									left: anchor.x - agent.x + "px",
									top: anchor.y - agent.y + "px"
								},
								onPointerDown: (e) => {
									onPortPointerDown(e, agent.id, { side });
								},
								title: "Open " + side + " point — drag from it to make it an output, drop a wire on it to make it an input"
							}, "open-" + side);
						})
					]
				}, agent.id);
			});
			const graphData = buildGraph(agents, connections, controls);
			const validation = validateGraph(graphData);
			const warnCount = validation.warnings?.length ?? 0;
			const jsonText = JSON.stringify(graphData, null, 2);
			function controlWarnings(control) {
				return (validation.warnings ?? []).filter((w) => w.message.indexOf("\"" + control.id + "\"") !== -1);
			}
			function branchShadowWarnings(control) {
				const onCycle = cycleNodeIds(graphData);
				const out = {};
				control.branches.forEach((row, index) => {
					if (row.field !== "$count") return;
					if (row.value === void 0 || row.value === "") return;
					const rowName = String(row.name ?? "");
					for (let above = 0; above < index; above++) {
						const name = String(control.branches[above].name ?? "");
						if (name.length === 0) continue;
						if (connections.some((c) => c.source === control.id && c.sourcePort === name && onCycle.has(c.target))) {
							out[rowName] = `the $count row "${rowName}" sits below row "${name}", which wires back into the loop and shadows it`;
							break;
						}
					}
				});
				return out;
			}
			const controlNodes = controls.map((control) => {
				const selected = control.id === selectedId;
				const hoveredIn = hoverTarget === control.id && gesture;
				const isIf = control.kind === "if";
				const warnings = controlWarnings(control);
				const runState = controlRunState(control);
				const lit = runState !== null && runState.state !== "idle" ? " control-" + runState.state : "";
				const reveal = gesture !== null ? gesture.from === control.id ? " reveal-full" : " reveal-in" : hoverNodeId === control.id || selected ? " reveal-full" : "";
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-node control" + (selected ? " selected" : "") + lit + reveal,
					style: {
						left: control.x + "px",
						top: control.y + "px"
					},
					"data-control-id": control.id,
					"data-control-run-state": runState?.state ?? "",
					title: runState !== null ? controlRunTitle(runState) : void 0,
					onPointerDown: (e) => {
						onNodePointerDown(e, control.id, control.x, control.y, "control");
					},
					onPointerEnter: (e) => {
						onNodePointerEnter(e, control.id);
					},
					onPointerLeave: (e) => {
						onNodePointerLeave(e, control.id);
					},
					onPointerMove: onNodePointerMove,
					onPointerUp: onNodePointerUp,
					onContextMenu: (e) => {
						onNodeContextMenu(e, control.id);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
							className: "control-shape",
							viewBox: "0 0 150 84",
							preserveAspectRatio: "none",
							"aria-hidden": "true",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("polygon", { points: "75,0 150,42 75,84 0,42" })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "node-name",
							children: isIf ? "if" : control.kind
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "node-sub",
							children: control.id
						}),
						warnings.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "node-warn",
							title: warnings.map((w) => w.message).join("\n"),
							children: "⚠ " + warnings.length
						}) : null,
						runState?.iter !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "node-iter",
							title: iterWords(runState.iter) + " — the feeding agent's firing count on this loop",
							children: iterLabel(runState.iter)
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pipeline-port in" + (hoveredIn && aim !== null && aim.port === "in" ? " hover" : ""),
							style: {
								left: "0px",
								top: "42px"
							},
							onPointerDown: (e) => {
								onPortPointerDown(e, control.id, { side: "left" });
							},
							title: "Input — drag from this control to branch from it"
						}),
						isIf ? branchNamesOf(control).map((branchName, index) => {
							const anchor = branchAnchor(control, branchName);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "control-branch side-" + anchor.side,
								style: {
									left: anchor.x - control.x + "px",
									top: anchor.y - control.y + "px"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "pipeline-port out",
									onPointerDown: (e) => {
										onPortPointerDown(e, control.id, { port: branchName });
									},
									title: "Branch " + branchName + " — drag to the agent that handles it"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "branch-label",
									children: branchName
								})]
							}, branchName + ":" + index);
						}) : null,
						openSidesOf(control).map((side) => {
							const anchor = sideMidAnchor(control, side);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "pipeline-port ghost" + (hoveredIn && aim !== null && aim.port === null && aim.side === side ? " hover" : ""),
								style: {
									left: anchor.x - control.x + "px",
									top: anchor.y - control.y + "px"
								},
								onPointerDown: (e) => {
									onPortPointerDown(e, control.id, { side });
								},
								title: "Open " + side + " point — drag from it to branch from this control"
							}, "open-" + side);
						})
					]
				}, control.id);
			});
			let configAgent = null;
			for (let k = 0; k < agents.length; k++) if (agents[k].id === configAgentId) configAgent = agents[k];
			let configControl = null;
			for (let k = 0; k < controls.length; k++) if (controls[k].id === configControlId) configControl = controls[k];
			const menuNode = nodeMenu !== null && nodeMenu.kind === "node" ? findNode(nodeMenu.id) : null;
			const menuEntries = nodeMenu !== null && nodeMenu.kind === "edge" ? [{
				id: "delete",
				label: "Delete connection",
				danger: true
			}] : menuNode !== null ? nodeMenuEntries(menuNode) : [];
			const inspectNode = pausedNodeId !== null && runProjection ? runProjection.nodes[pausedNodeId] : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "pipeline-view",
				onPointerMove: onContainerPointerMove,
				onPointerUp: onContainerPointerUp,
				onPointerLeave: onContainerPointerLeave,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "pipeline-toolbar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "Agent Pipeline" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "stat",
								children: agents.length + " agents" + (controls.length > 0 ? " · " + controls.length + (controls.length === 1 ? " control" : " controls") : "") + " · " + connections.length + " connections"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pipeline-validation" + (validation.ok ? warnCount > 0 ? " warn" : " ok" : " err"),
								title: validation.ok ? warnCount > 0 ? "Graph is valid — " + warnCount + " warning" + (warnCount === 1 ? "" : "s") + " (see below)" : "Graph is valid" : "Graph has validation issues (see the issue list below)",
								role: "status",
								children: validation.ok ? warnCount > 0 ? "Valid · " + warnCount + " warning" + (warnCount === 1 ? "" : "s") : "Valid" : validation.errors.length + " issue" + (validation.errors.length === 1 ? "" : "s")
							}),
							runActive ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pipeline-run-live" + (failedNodeId !== null ? " failed" : ""),
								title: failedNodeId !== null ? "A firing failed — the run ends after the in-flight agents finish; completed outputs are preserved" : "A run is active in this session — canvas edits affect the NEXT run only",
								children: failedNodeId !== null ? "Failed at " + nameOf(failedNodeId) + " — finishing in-flight agents…" : activeRun?.state === "paused" ? "Paused at " + nameOf(pausedNodeId) + (queuedCount > 0 ? " +" + queuedCount + " queued" : "") : "Running…"
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								onClick: addAgentFromToolbar,
								children: "+ Add Agent"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								onClick: deleteSelected,
								disabled: !selectedId && !selectedEdgeId,
								title: selectedEdgeId && !selectedId ? "Delete the selected connection" : "Delete the selected node",
								children: "Delete"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								onClick: () => {
									setShowJson(!showJson);
								},
								children: showJson ? "Hide JSON" : "View JSON"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								onClick: clearAll,
								children: "Clear"
							}),
							runResult && !resultOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								title: "Reopen the last run's result",
								onClick: () => {
									setResultOpen(true);
								},
								children: "Result"
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn pipeline-btn-run",
								disabled: runActive || startPending || !validation.ok,
								title: runActive ? "A run is already active in this session" : startPending ? "Starting the run…" : "Open the run dialog",
								onClick: () => {
									setShowRunModal(true);
								},
								children: runActive ? "Running…" : startPending ? "Starting…" : "Run"
							}),
							runActive || startPending ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn pipeline-btn-stop",
								title: "Abort the run — completed outputs are preserved, downstream agents never start",
								disabled: startPending || controlBusy !== null,
								onClick: () => {
									controlRun("abort");
								},
								children: "Abort"
							}) : null
						]
					}),
					validation.ok && warnCount === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "pipeline-issues" + (validation.ok ? " warnings-only" : ""),
						children: [validation.errors.map((err) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pipeline-issue",
							children: err.message
						}, err.code + ":" + err.message)), (validation.warnings ?? []).map((warn) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pipeline-issue warn",
							children: warn.message
						}, warn.code + ":" + warn.message))]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "pipeline-body",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pipeline-palette",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "palette-title",
									children: "Palette"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "palette-item",
									draggable: true,
									onDragStart: (e) => {
										e.dataTransfer.setData("application/x-pipeline-agent", "agent");
										e.dataTransfer.effectAllowed = "copy";
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "palette-icon" }), "Agent"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "palette-item",
									draggable: true,
									onDragStart: (e) => {
										e.dataTransfer.setData("application/x-pipeline-control", "if");
										e.dataTransfer.effectAllowed = "copy";
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "palette-icon if" }), "If"]
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pipeline-canvas",
							ref: canvasRef,
							tabIndex: 0,
							onDragOver: handleDragOver,
							onDrop: handleCanvasDrop,
							onPointerDown: onCanvasPointerDown,
							onKeyDown,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
									className: "pipeline-edges",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("defs", { children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("marker", {
												id: "pipeline-arrow",
												markerWidth: 8,
												markerHeight: 8,
												refX: 6,
												refY: 3,
												orient: "auto",
												markerUnits: "strokeWidth",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
													d: "M0,0 L6,3 L0,6 Z",
													className: "pipeline-arrowfill"
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("marker", {
												id: "pipeline-arrow-fired",
												markerWidth: 8,
												markerHeight: 8,
												refX: 6,
												refY: 3,
												orient: "auto",
												markerUnits: "strokeWidth",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
													d: "M0,0 L6,3 L0,6 Z",
													className: "pipeline-arrowfill-fired"
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("marker", {
												id: "pipeline-arrow-selected",
												markerWidth: 8,
												markerHeight: 8,
												refX: 6,
												refY: 3,
												orient: "auto",
												markerUnits: "strokeWidth",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
													d: "M0,0 L6,3 L0,6 Z",
													className: "pipeline-arrowfill-selected"
												})
											})
										] }),
										edges,
										tempEdge
									]
								}),
								nodes,
								controlNodes,
								agents.length === 0 && controls.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "pipeline-hint",
									children: "Drag an Agent or an If from the palette onto the canvas"
								}) : null
							]
						})]
					}),
					showJson ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "pipeline-json",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { children: jsonText })
					}) : null,
					configAgent ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AgentConfigPanel, {
						agent: configAgent,
						onSave: (updated) => {
							setAgents((prev) => prev.map((a) => a.id === updated.id ? {
								...a,
								name: updated.name,
								description: updated.description,
								systemPrompt: updated.systemPrompt,
								instructions: updated.instructions,
								settings: updated.settings,
								inputPorts: updated.inputPorts,
								outputPorts: updated.outputPorts,
								outputPortSides: updated.outputPortSides,
								bindings: updated.bindings,
								...updated.breakpoint === true ? { breakpoint: true } : { breakpoint: void 0 }
							} : a));
							setConfigAgentId(null);
						},
						onClose: () => {
							setConfigAgentId(null);
						}
					}, configAgent.id) : null,
					configControl ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ControlConfigPanel, {
						control: configControl,
						warnings: controlWarnings(configControl),
						rowWarnings: branchShadowWarnings(configControl),
						onSave: (branches) => {
							setControls((prev) => prev.map((k) => k.id === configControl.id ? {
								...k,
								branches
							} : k));
							setConfigControlId(null);
						},
						onClose: () => {
							setConfigControlId(null);
						}
					}, configControl.id) : null,
					edgeDraft ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "pipeline-config-overlay",
						onPointerDown: (e) => {
							e.stopPropagation();
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pipeline-edge-picker",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "Connect branch" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "picker-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "From " + nameOf(edgeDraft.source) + " (branch)" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: edgeDraft.picked,
										onChange: (e) => {
											setEdgeDraft((d) => d ? {
												...d,
												picked: e.target.value
											} : d);
										},
										children: outputPortNamesOf(edgeDraft.source).map((branchName) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: branchName,
											children: branchName
										}, branchName))
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "picker-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "To " + nameOf(edgeDraft.target) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "picker-static",
										children: edgeDraftTargetText()
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "picker-actions",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "pipeline-btn",
										onClick: () => {
											setEdgeDraft(null);
										},
										children: "Cancel"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "pipeline-btn",
										onClick: confirmEdgeDraft,
										children: "Connect"
									})]
								})
							]
						})
					}) : null,
					ownerHandoff !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "pipeline-config-overlay",
						onPointerDown: (e) => {
							e.stopPropagation();
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "pipeline-edge-picker",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "Hand off emission to the if" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "handoff-text",
									children: nameOf(ownerHandoff.conn.source) + " declares its own output ports or bindings, but it now feeds " + ownerHandoff.control.id + " — an if owns its source's whole emission surface. Move the configuration into the branches, or clear it on the agent."
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "picker-actions",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "pipeline-btn",
											title: "Leave the agent's config in place — the validation strip reports the conflict",
											onClick: () => {
												resolveOwnerHandoff("dismiss");
											},
											children: "Not now"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "pipeline-btn",
											title: "Drop the agent's output ports and bindings — it emits only through the if",
											onClick: () => {
												resolveOwnerHandoff("clear");
											},
											children: "Clear on the agent"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: "pipeline-btn",
											title: "Turn the agent's ports and bindings into this if's branches",
											onClick: () => {
												resolveOwnerHandoff("move");
											},
											children: "Move into the if"
										})
									]
								})
							]
						})
					}) : null,
					showRunModal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RunModal, {
						cwd,
						initialText: runTextRef.current,
						initialFiles: runFilesRef.current,
						running: runActive || startPending,
						fileList: services && services.remote && services.remote.fileReferences ? queryFiles : null,
						onRun: run,
						onClose: () => {
							setShowRunModal(false);
						}
					}) : null,
					inspectOpen && pausedNodeId !== null && inspectNode !== void 0 && activeRun !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InspectModal, {
						agentName: nameOf(pausedNodeId),
						node: inspectNode,
						queued: queuedCount,
						busy: controlBusy,
						status: controlStatus,
						canSteer: typeof inspectNode.childSessionId === "string" && inspectNode.childSessionId.length > 0,
						onOpenSession: openTranscript,
						onResume: () => {
							controlRun("resume");
						},
						onRerun: () => {
							controlRun("rerun");
						},
						onSteer: (feedback) => {
							controlRun("steer", feedback);
						},
						onAbort: () => {
							controlRun("abort");
						},
						onClose: () => {
							setInspectDismissedFor((activeRun.runId ?? "") + ":" + (activeRun.pausedAt ?? pausedNodeId));
						}
					}) : null,
					runResult && resultOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ResultModal, {
						result: runResult,
						names: agents.reduce((acc, a) => {
							acc[a.id] = a.name;
							return acc;
						}, {}),
						targets,
						busy: continueBusy,
						status: continueStatus,
						onOpenSession: openTranscript,
						onContinueChat: continueInChat,
						onContinueNewSession: continueInNewSession,
						onSendTo: sendToSession,
						onClose: () => {
							setResultOpen(false);
							setContinueStatus(null);
						}
					}) : null,
					nodeMenu !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						onContextMenu: (e) => {
							e.preventDefault();
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NodeMenu, {
							target: nodeMenu,
							entries: menuEntries,
							onAction: runNodeMenuAction,
							onClose: () => {
								setNodeMenu(null);
							}
						})
					}) : null
				]
			});
		}
		//#endregion
		//#region \0pipeline-css:src\ui\shell.css.mjs
		const css$1 = "/* The frame-wide shell panel (opened by the composer tool-row trigger) and the\r\n   compact trigger button itself. */\r\n\r\n.pipeline-input-btn {\r\n	display: inline-flex;\r\n	align-items: center;\r\n	justify-content: center;\r\n	flex: none;\r\n	width: 24px;\r\n	height: 24px;\r\n	padding: 0;\r\n	border: none;\r\n	border-radius: 6px;\r\n	background: transparent;\r\n	color: var(--dsw-alias-label-secondary);\r\n	cursor: pointer;\r\n}\r\n.pipeline-input-btn:hover {\r\n	color: var(--dsw-alias-brand-primary);\r\n	background: var(--dsw-alias-interactive-bg-hover);\r\n}\r\n.pipeline-shell-backdrop {\r\n	position: fixed;\r\n	inset: 0;\r\n	z-index: 40;\r\n	background: rgba(0, 0, 0, .5);\r\n}\r\n.pipeline-shell {\r\n	position: fixed;\r\n	left: 50%;\r\n	top: 50%;\r\n	transform: translate(-50%, -50%);\r\n	z-index: 41;\r\n	width: min(1200px, 94vw);\r\n	height: min(860px, 90vh);\r\n	display: flex;\r\n	flex-direction: column;\r\n	background: var(--dsw-alias-bg-layer-1);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 12px;\r\n	box-shadow: 0 8px 30px rgba(0, 0, 0, .35);\r\n	overflow: hidden;\r\n}\r\n.pipeline-shell-head {\r\n	display: flex;\r\n	align-items: center;\r\n	gap: 10px;\r\n	padding: 8px 12px;\r\n	border-bottom: 1px solid var(--dsw-alias-border-l1);\r\n	background: var(--dsw-alias-bg-layer-2);\r\n	flex: none;\r\n}\r\n.pipeline-shell-head h4 { margin: 0; font-size: 13px; font-weight: 600; }\r\n.pipeline-shell-cwd {\r\n	font-size: 11px;\r\n	color: var(--dsw-alias-label-secondary);\r\n	overflow: hidden;\r\n	text-overflow: ellipsis;\r\n	white-space: nowrap;\r\n	max-width: 46%;\r\n}\r\n.pipeline-shell-head .spacer { flex: 1; }\r\n.pipeline-shell .pipeline-view { flex: 1; min-height: 0; height: auto; }\r\n.pipeline-shell-empty {\r\n	flex: 1;\r\n	display: flex;\r\n	align-items: center;\r\n	justify-content: center;\r\n	color: var(--dsw-alias-label-secondary);\r\n	font-size: 13px;\r\n	padding: 0 24px;\r\n	text-align: center;\r\n}\r\n";
		const tagId$1 = "dsh-agent-pipeline-canvas/styles/C:\\Users\\Ivan\\Desktop\\dsh-agent-pipeline-canvas\\src\\ui\\shell.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-agent-pipeline-canvas";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/ui/shell-panel.tsx
		/** Shared open state between the sidebar trigger and the shell-overlay panel. */
		function createPanelGate() {
			let open = false;
			const listeners = /* @__PURE__ */ new Set();
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				get() {
					return open;
				},
				set(next) {
					if (open === next) return;
					open = next;
					listeners.forEach((fn) => fn());
				}
			};
		}
		const panelGate = createPanelGate();
		/** A small two-node flow glyph for the trigger (no icon package in the bundle). */
		function PipelineGlyph({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: 3.5,
						cy: 8,
						r: 2.1,
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 1.5
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M5.6 8h4.8",
						stroke: "currentColor",
						strokeWidth: 1.5
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: 12.5,
						cy: 8,
						r: 2.1,
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 1.5
					})
				]
			});
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
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "pipeline-input-btn",
				"aria-label": "Pipelines",
				title: "Pipelines",
				onMouseDown: (e) => {
					e.preventDefault();
				},
				onClick: () => {
					panelGate.set(true);
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PipelineGlyph, { size: 14 })
			});
		}
		/**
		* The shell-overlay entry: a one-hook gate so the hook count never changes
		* between closed and open renders; the panel body mounts fresh when opened.
		*/
		function PipelinePanelEntry({ useSessions, useWorkspaces, services }) {
			if (!react.useSyncExternalStore(panelGate.subscribe, panelGate.get)) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PipelinePanel, {
				useSessions,
				useWorkspaces,
				services
			});
		}
		/** The frame-wide panel hosting the canvas for the CURRENT session. */
		function PipelinePanel({ useSessions, useWorkspaces, services }) {
			const hasSessions = typeof useSessions === "function";
			const current = hasSessions ? useSessions((s) => s && s.current) : void 0;
			const cwd = hasSessions ? useSessions((s) => {
				const id = s && s.current;
				if (!id || !s.byId) return void 0;
				const row = s.byId[id];
				return row ? row.cwd : void 0;
			}) : void 0;
			const close = () => {
				panelGate.set(false);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "pipeline-shell-backdrop",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-shell",
					"data-pipeline-shell": "true",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "pipeline-shell-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "Pipelines" }),
							cwd ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "pipeline-shell-cwd",
								title: cwd,
								children: cwd
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "pipeline-btn",
								title: "Close the pipelines panel",
								onClick: close,
								children: "Close"
							})
						]
					}), hasSessions && typeof current === "string" && current.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PipelineView, {
						sessionId: current,
						useSessions,
						useWorkspaces,
						services,
						onDismiss: close
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "pipeline-shell-empty",
						children: hasSessions ? "Open a session to compose and run pipelines — the graph is stored per session." : "The session feed is unavailable here; open the Pipelines tab inside a session instead."
					})]
				})
			});
		}
		//#endregion
		//#region \0pipeline-css:src\ui\shared.css.mjs
		const css = "/* Shared primitives for every pipeline surface: buttons and the modal frame\n   (run + result modals). Injected once via the build's pipeline-css-inline\n   loader as <style data-plugin-css=\"dsh-agent-pipeline-canvas/styles/shared.css\">. */\n\n.pipeline-btn {\n	cursor: pointer;\n	border: 1px solid var(--dsw-alias-border-l2);\n	background: var(--dsw-alias-bg-layer-2);\n	color: var(--dsw-alias-label-primary);\n	border-radius: 6px;\n	padding: 4px 10px;\n	font-size: 12px;\n}\n.pipeline-btn:hover { border-color: var(--dsw-alias-brand-primary); }\n.pipeline-btn:disabled { opacity: .5; cursor: default; }\n.pipeline-btn-run { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }\n.pipeline-btn-run:disabled { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }\n.pipeline-btn-stop { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }\n.pipeline-btn-mini { padding: 1px 8px; font-size: 11px; flex-shrink: 0; }\n\n.pipeline-modal-overlay {\n	position: fixed;\n	inset: 0;\n	z-index: 60;\n	display: flex;\n	align-items: center;\n	justify-content: center;\n	background: rgba(0, 0, 0, .45);\n}\n.pipeline-modal {\n	width: 560px;\n	max-width: 94%;\n	max-height: 88%;\n	background: var(--dsw-alias-bg-layer-1);\n	border: 1px solid var(--dsw-alias-border-l2);\n	border-radius: 12px;\n	padding: 16px;\n	box-sizing: border-box;\n	display: flex;\n	flex-direction: column;\n	gap: 14px;\n	box-shadow: 0 8px 30px rgba(0, 0, 0, .35);\n	overflow: auto;\n}\n.pipeline-modal h3 { margin: 0; font-size: 14px; font-weight: 600; }\n.pipeline-modal .modal-row { display: flex; flex-direction: column; gap: 6px; }\n.pipeline-modal label { font-size: 11px; color: var(--dsw-alias-label-secondary); }\n.pipeline-modal textarea {\n	font-family: inherit;\n	font-size: 12px;\n	color: var(--dsw-alias-label-primary);\n	background: var(--dsw-alias-bg-base);\n	border: 1px solid var(--dsw-alias-border-l2);\n	border-radius: 6px;\n	padding: 6px 8px;\n	box-sizing: border-box;\n	width: 100%;\n	min-height: 96px;\n	resize: vertical;\n}\n.pipeline-modal input {\n	font-family: inherit;\n	font-size: 12px;\n	color: var(--dsw-alias-label-primary);\n	background: var(--dsw-alias-bg-base);\n	border: 1px solid var(--dsw-alias-border-l2);\n	border-radius: 6px;\n	padding: 6px 8px;\n	box-sizing: border-box;\n	width: 100%;\n}\n.pipeline-modal textarea:focus, .pipeline-modal input:focus, .pipeline-modal select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }\n.pipeline-modal select {\n	font-family: inherit;\n	font-size: 12px;\n	color: var(--dsw-alias-label-primary);\n	background: var(--dsw-alias-bg-base);\n	border: 1px solid var(--dsw-alias-border-l2);\n	border-radius: 6px;\n	padding: 5px 8px;\n	box-sizing: border-box;\n	width: 100%;\n}\n.pipeline-modal-notice { font-size: 11px; color: var(--dsw-alias-state-warning-primary, #f59e0b); }\n.pipeline-modal-status { font-size: 11px; color: var(--dsw-alias-state-error-primary); }\n.pipeline-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; align-items: center; }\n.pipeline-modal-actions .spacer { flex: 1; }\n";
		const tagId = "dsh-agent-pipeline-canvas/styles/C:\\Users\\Ivan\\Desktop\\dsh-agent-pipeline-canvas\\src\\ui\\shared.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-agent-pipeline-canvas";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client.tsx
		const inject = [
			"slots",
			"sessions",
			"uiWorkspace",
			"conversation",
			"remote",
			"remote.fileReferences"
		];
		function apply(ctx) {
			const services = {
				sessions: ctx.sessions,
				uiWorkspace: ctx.uiWorkspace,
				conversation: ctx.conversation,
				remote: ctx.remote
			};
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "pipeline",
				order: 30,
				label: "Pipelines"
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PipelineView, {
				sessionId: props.sessionId,
				useSessions: props.useSessions,
				useWorkspaces: props.useWorkspaces,
				inputActions: props.inputActions,
				openView: props.openView,
				services
			})));
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "pipeline-trigger",
				order: 40
			}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PipelineComposerTrigger, {})));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "pipeline-panel",
				order: 20
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PipelinePanelEntry, {
				useSessions: props.useSessions,
				useWorkspaces: props.useWorkspaces,
				services
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
