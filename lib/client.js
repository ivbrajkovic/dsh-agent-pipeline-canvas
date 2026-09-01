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
		function argStr$1(value) {
			return value == null ? "" : String(value);
		}
		/** True for a branch that tests a value (everything but the catch-all). */
		function isValued(branch) {
			return branch.value !== void 0 && branch.value !== "";
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
					warnUnreachable(id, source, owner, warnings);
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
		* only as the last branch; a known side. Returns the declared branch names —
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
				if (isValued(branch) && (typeof branch.field !== "string" || branch.field.length === 0)) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" branch ${label} compares a value but names no field`
				});
				if (!isValued(branch) && index < branches.length - 1) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" branch ${label} is a catch-all but not last — the catch-all must be the final branch`
				});
				if (branch.side !== void 0 && !PORT_SIDES$3.includes(branch.side)) errors.push({
					code: "if-branch-invalid",
					message: `control "${controlId}" branch ${label} has an unknown side "${argStr$1(branch.side)}" (expected "left", "right", "top" or "bottom")`
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
		* `settings.outputSchema` (bindings evaluate only against a structured
		* result) or is breakpointed (a continuable child produces none).
		*/
		function warnUnreachable(controlId, sourceId, owner, warnings) {
			if (owner.breakpoint === true) warnings.push({
				code: "if-source-breakpointed",
				message: `control "${controlId}" feeds from breakpointed agent "${sourceId}" — a continuable child cannot produce structured output, so its branches can never fire`
			});
			const settings = owner.settings;
			const schema = settings != null && typeof settings === "object" ? settings.outputSchema : void 0;
			if (schema === void 0 || schema === null) warnings.push({
				code: "if-source-no-schema",
				message: `control "${controlId}" feeds from agent "${sourceId}" which has no settings.outputSchema — its branches compare a structured result, so they can never fire`
			});
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
					const valued = branchValue !== void 0 && branchValue !== "";
					const field = typeof spec.field === "string" && spec.field.length > 0 ? spec.field : null;
					const binding = field !== null ? valued ? {
						field,
						port: name,
						value: branchValue
					} : {
						field,
						port: name
					} : valued ? {
						port: name,
						value: branchValue
					} : { port: name };
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
		//#endregion
		//#region src/graph.ts
		/** Input-port delivery policies a spec may declare. */
		const PORT_POLICIES = ["all-of", "any-of"];
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
					if (!declared.includes(port)) errors.push({
						code: "agent-binding-port-mismatch",
						message: `agent "${id}" binding "${field}" targets port "${port}" but "${id}" declares output ports: ${declared.length > 0 ? declared.join(", ") : "none"}`
					});
				});
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
			const cycle = findCycle(agentIds, connections, analysis.sourceByControl);
			if (cycle.length > 0) warnings.push({
				code: "cycle-present",
				message: `pipeline contains a cycle: ${cycle.join(" -> ")} — legal wiring for the stream executor, but the sequential runner only runs its acyclic prefix`
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
		* declared output ports. Malformed side data is an error. The side cap
		* (edge-routing iteration 2 — at most one port of a node per resolved side)
		* is a WARNING, `cycle-present`-style: default sides stack multi-port nodes
		* that predate explicit sides, the canvas renders the stack, and the warning
		* tells the author how to spread the ports.
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
			const bySide = /* @__PURE__ */ new Map();
			const take = (side, port) => {
				bySide.set(side, (bySide.get(side) ?? []).concat([port]));
			};
			if (Array.isArray(rec.inputPorts)) for (const spec of rec.inputPorts) {
				const s = spec;
				if (s != null && typeof s === "object" && typeof s.name === "string" && s.name.length > 0) take(s.side === void 0 ? DEFAULT_INPUT_SIDE : String(s.side), "in:" + s.name);
			}
			else take(DEFAULT_INPUT_SIDE, "in");
			if (Array.isArray(rec.outputPorts)) {
				const sides = rec.outputPortSides != null && typeof rec.outputPortSides === "object" && !Array.isArray(rec.outputPortSides) ? rec.outputPortSides : {};
				for (const name of rec.outputPorts) {
					if (typeof name !== "string" || name.length === 0) continue;
					take(sides[name] === void 0 ? DEFAULT_OUTPUT_SIDE : String(sides[name]), "out:" + name);
				}
			} else take(DEFAULT_OUTPUT_SIDE, "out");
			for (const [side, ports] of bySide) if (ports.length > 1) warnings.push({
				code: "agent-port-side-conflict",
				message: `agent "${id}" puts more than one port on the ${side} edge: ${ports.join(", ")} — they render stacked; assign distinct sides to spread them`
			});
		}
		/**
		* Detect a directed cycle among the given agents/edges and, when found, return
		* the cycle as a closed path `[a, b, c, a]` (last == first). Self-connections
		* are excluded here because they are reported as `connection-self` separately;
		* they are still cycles, but reporting them once with a targeted message is
		* clearer than folding them into a generic warning. The result feeds the
		* non-fatal `cycle-present` warning — a cycle is legal wiring (the stream
		* executor loops), it is only a hazard for the legacy sequential runner.
		*
		* @param agentIds - the set of known agent ids (the graph's node universe).
		* @param connections - the raw connections array.
		* @param sourceByControl - control id -> its feeding agent's id (a control-
		*   sourced edge walks from the producer; an edge INTO a control closes at it,
		*   a self-loop the walk excludes — exactly the lowered graph's shape, since
		*   lowering drops the control and its feeding edge).
		* @returns an empty array when the graph is acyclic, else the cycle path.
		*/
		function findCycle(agentIds, connections, sourceByControl) {
			const adj = /* @__PURE__ */ new Map();
			for (const id of agentIds) adj.set(id, []);
			for (const conn of connections) {
				if (conn == null || typeof conn !== "object") continue;
				const rec = conn;
				let source = rec.source == null ? "" : String(rec.source);
				const target = rec.target == null ? "" : String(rec.target);
				if (source.length === 0 || target.length === 0) continue;
				if (!agentIds.has(source)) source = sourceByControl.get(source) ?? "";
				if (!agentIds.has(source) || !agentIds.has(target)) continue;
				if (source === target) continue;
				adj.get(source)?.push(target);
			}
			const WHITE = 0, GRAY = 1, BLACK = 2;
			const color = /* @__PURE__ */ new Map();
			for (const id of agentIds) color.set(id, WHITE);
			const stackPath = [];
			function visit(node) {
				color.set(node, GRAY);
				stackPath.push(node);
				for (const next of adj.get(node) ?? []) {
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
		const css$6 = "/* The agent configuration modal: overlay, a wide two-column card — the left\r\n   column is the agent's behavior (name / description / system prompt /\r\n   instructions), the right column the always-visible construction overrides. */\r\n\r\n.pipeline-config-overlay {\r\n  position: absolute;\r\n  inset: 0;\r\n  z-index: 20;\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  background: rgba(0, 0, 0, 0.45);\r\n}\r\n.pipeline-config {\r\n  width: 720px;\r\n  max-width: 94%;\r\n  max-height: 92%;\r\n  overflow-y: auto;\r\n  background: var(--dsw-alias-bg-layer-1);\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 12px;\r\n  padding: 16px;\r\n  box-sizing: border-box;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 14px;\r\n  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);\r\n}\r\n.pipeline-config h3 {\r\n  margin: 0;\r\n  font-size: 14px;\r\n  font-weight: 600;\r\n}\r\n.pipeline-config .config-row {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 6px;\r\n}\r\n.pipeline-config label {\r\n  font-size: 11px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n.pipeline-config input,\r\n.pipeline-config textarea {\r\n  font-family: inherit;\r\n  font-size: 12px;\r\n  color: var(--dsw-alias-label-primary);\r\n  background: var(--dsw-alias-bg-base);\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 6px;\r\n  padding: 6px 10px;\r\n  box-sizing: border-box;\r\n  width: 100%;\r\n}\r\n.pipeline-config select {\r\n  /* Customizable select: the popup renders in-page, so its rows get the\r\n     padding below on every side (the macOS native menu ignores option CSS).\r\n     Unsupported browsers keep the native popup — this is simply ignored. */\r\n  appearance: base-select;\r\n  font-family: inherit;\r\n  font-size: 12px;\r\n  color: var(--dsw-alias-label-primary);\r\n  background: var(--dsw-alias-bg-base);\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 6px;\r\n  padding: 6px 10px;\r\n  box-sizing: border-box;\r\n  width: 100%;\r\n  white-space: nowrap;\r\n  overflow: hidden;\r\n}\r\n.pipeline-config select::picker(select) {\r\n  background: var(--dsw-alias-bg-layer-1);\r\n  border: 1px solid var(--dsw-alias-border-l2);\r\n  border-radius: 8px;\r\n  padding: 4px;\r\n  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);\r\n}\r\n.pipeline-config select option {\r\n  padding: 6px 10px;\r\n  border-radius: 5px;\r\n  color: inherit;\r\n}\r\n.pipeline-config select option:hover,\r\n.pipeline-config select option:focus {\r\n  background: color-mix(\r\n    in srgb,\r\n    var(--dsw-alias-brand-primary) 18%,\r\n    transparent\r\n  );\r\n}\r\n.pipeline-config input:focus,\r\n.pipeline-config textarea:focus,\r\n.pipeline-config select:focus {\r\n  outline: none;\r\n  border-color: var(--dsw-alias-brand-primary);\r\n}\r\n.pipeline-config textarea {\r\n  min-height: 72px;\r\n  resize: vertical;\r\n}\r\n.pipeline-config .config-actions {\r\n  display: flex;\r\n  justify-content: flex-end;\r\n  gap: 8px;\r\n  margin-top: 8px;\r\n}\r\n.pipeline-config .config-columns {\r\n  display: grid;\r\n  grid-template-columns: 1fr 1fr;\r\n  gap: 16px;\r\n  align-items: start;\r\n}\r\n.pipeline-config .config-col {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 12px;\r\n  min-width: 0;\r\n}\r\n.pipeline-config .config-col-settings {\r\n  padding-left: 16px;\r\n  border-left: 1px solid var(--dsw-alias-border-l2);\r\n}\r\n.pipeline-config .config-grid {\r\n  display: grid;\r\n  grid-template-columns: 1fr 1fr;\r\n  gap: 12px 10px;\r\n}\r\n.pipeline-config .config-error {\r\n  font-size: 11px;\r\n  color: var(--dsw-alias-state-error-primary);\r\n}\r\n.pipeline-config .config-warning {\r\n  font-size: 11px;\r\n  color: var(--dsw-alias-state-warning-primary, #b8860b);\r\n}\r\n.pipeline-config .config-check {\r\n  display: flex;\r\n  flex-direction: row;\r\n  align-items: center;\r\n  gap: 6px;\r\n  font-size: 12px;\r\n  color: var(--dsw-alias-label-primary);\r\n  cursor: pointer;\r\n}\r\n.pipeline-config .config-check input {\r\n  width: auto;\r\n  margin: 0;\r\n  accent-color: var(--dsw-alias-brand-primary);\r\n}\r\n/* The ports editor's compact rows (input ports, bindings): several small\r\n   controls on one line, plus muted hints and the remove/add mini buttons. */\r\n.pipeline-config .config-mini-row {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 6px;\r\n}\r\n.pipeline-config .config-mini-row input,\r\n.pipeline-config .config-mini-row select {\r\n  min-width: 0;\r\n}\r\n.pipeline-config .config-mini-op {\r\n  flex: 0 0 auto;\r\n  font-size: 11px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n.pipeline-config .config-mini-btn {\r\n  flex: 0 0 auto;\r\n  padding: 3px 8px;\r\n  font-size: 11px;\r\n  width: auto;\r\n}\r\n.pipeline-config .config-hint {\r\n  font-size: 11px;\r\n  color: var(--dsw-alias-label-secondary);\r\n}\r\n\r\n\r\n";
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
		function asSide(value) {
			return value === "left" || value === "right" || value === "top" || value === "bottom" ? value : null;
		}
		function ControlConfigPanel({ control, warnings, onSave, onClose }) {
			const [rows, setRows] = react.useState(control.branches.map((b) => ({
				name: b.name,
				field: typeof b.field === "string" ? b.field : "",
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
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "config-hint",
							children: "Branches evaluate top to bottom on the feeding agent's structured output — first match wins. The catch-all (empty value) must stay last. Wire each branch tick to the agent that handles it."
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "config-row",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "Branches" }),
								rows.map((row, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
											title: "Structured-output field to compare",
											style: { flex: "1 1 22%" },
											onChange: (e) => {
												setRow(index, { field: e.target.value });
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
											title: "Value the field must equal (compared as text). Empty matches any structured result — the catch-all, kept last.",
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
								}, index)),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "pipeline-btn config-mini-btn",
									title: "Add a branch rule",
									onClick: () => {
										setRows((prev) => prev.concat([{
											name: "",
											field: "",
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
		const css$4 = "/* The Result modal: terminal-output blocks and the per-run status strip with\r\n   the Transcript route into each agent's child session. */\r\n\r\n.pipeline-result {\r\n	background: var(--dsw-alias-bg-base);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 8px;\r\n	padding: 8px;\r\n	max-height: 220px;\r\n	overflow: auto;\r\n	display: flex;\r\n	flex-direction: column;\r\n	gap: 6px;\r\n}\r\n.pipeline-result-row { display: flex; flex-direction: column; gap: 2px; }\r\n.pipeline-result-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }\r\n.pipeline-result-value {\r\n	margin: 0;\r\n	padding: 6px 8px;\r\n	background: var(--dsw-alias-bg-base);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 6px;\r\n	font-size: 11px;\r\n	white-space: pre-wrap;\r\n	word-break: break-word;\r\n	max-height: 160px;\r\n	overflow: auto;\r\n}\r\n.pipeline-result-warn { font-size: 11px; color: var(--dsw-alias-state-warning-primary); }\r\n.pipeline-result-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); }\r\n.pipeline-runs {\r\n	display: flex;\r\n	flex-direction: column;\r\n	gap: 4px;\r\n	border-top: 1px dashed var(--dsw-alias-border-l2);\r\n	padding-top: 6px;\r\n}\r\n.pipeline-run-row { display: flex; align-items: center; gap: 8px; font-size: 11px; min-height: 20px; }\r\n.pipeline-run-row .run-name { font-weight: 600; flex-shrink: 0; }\r\n.pipeline-run-row .run-status { color: var(--dsw-alias-label-secondary); flex-shrink: 0; }\r\n.pipeline-run-row .run-status.warn { color: var(--dsw-alias-state-warning-primary); }\r\n.pipeline-run-row .run-error {\r\n	color: var(--dsw-alias-state-error-primary);\r\n	overflow: hidden;\r\n	text-overflow: ellipsis;\r\n	white-space: nowrap;\r\n	flex: 1;\r\n}\r\n";
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
		const css$2 = "/* The canvas: view frame, toolbar, validation strip, palette, nodes/ports,\r\n   edges, and the JSON drawer. Class names are globally prefixed\r\n   (`pipeline-*`) — the per-file style tags are the scoping mechanism. */\r\n\r\n.pipeline-view {\r\n	position: relative;\r\n	display: flex;\r\n	flex-direction: column;\r\n	height: 100%;\r\n	width: 100%;\r\n	box-sizing: border-box;\r\n	font-family: inherit;\r\n	color: var(--dsw-alias-label-primary);\r\n}\r\n.pipeline-view .pipeline-toolbar {\r\n	display: flex;\r\n	align-items: center;\r\n	gap: 8px;\r\n	padding: 8px 10px;\r\n	border-bottom: 1px solid var(--dsw-alias-border-l1);\r\n	flex-wrap: wrap;\r\n	background: var(--dsw-alias-bg-layer-1);\r\n}\r\n.pipeline-view .pipeline-toolbar h3 { margin: 0; font-size: 14px; font-weight: 600; }\r\n.pipeline-view .pipeline-toolbar .spacer { flex: 1; }\r\n.pipeline-view .pipeline-toolbar .stat { font-size: 12px; color: var(--dsw-alias-label-secondary); }\r\n.pipeline-view .pipeline-toolbar .pipeline-validation {\r\n	margin-left: 6px;\r\n	font-size: 12px;\r\n	padding: 3px 9px;\r\n	border-radius: 999px;\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	line-height: 1;\r\n}\r\n.pipeline-view .pipeline-toolbar .pipeline-validation.ok {\r\n	color: var(--dsw-alias-state-success-primary);\r\n	border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);\r\n}\r\n.pipeline-view .pipeline-toolbar .pipeline-validation.err {\r\n	color: var(--dsw-alias-state-error-primary);\r\n	border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);\r\n}\r\n.pipeline-view .pipeline-toolbar .pipeline-validation.warn {\r\n	color: var(--dsw-alias-state-warning-primary);\r\n	border-color: color-mix(in srgb, var(--dsw-alias-state-warning-primary) 45%, transparent);\r\n}\r\n.pipeline-issues {\r\n	background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-1));\r\n	border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 25%, var(--dsw-alias-border-l1));\r\n	padding: 6px 10px;\r\n	max-height: 120px;\r\n	overflow: auto;\r\n	display: flex;\r\n	flex-direction: column;\r\n	gap: 3px;\r\n}\r\n.pipeline-issues.warnings-only {\r\n	background: color-mix(in srgb, var(--dsw-alias-state-warning-primary) 10%, var(--dsw-alias-bg-layer-1));\r\n	border-bottom-color: color-mix(in srgb, var(--dsw-alias-state-warning-primary) 25%, var(--dsw-alias-border-l1));\r\n}\r\n.pipeline-issue { font-size: 12px; color: var(--dsw-alias-state-error-primary); line-height: 1.4; }\r\n.pipeline-issue.warn { color: var(--dsw-alias-state-warning-primary); }\r\n.pipeline-body { flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--dsw-alias-border-l1); }\r\n.pipeline-palette {\r\n	width: 170px;\r\n	flex-shrink: 0;\r\n	background: var(--dsw-alias-bg-layer-2);\r\n	border-right: 1px solid var(--dsw-alias-border-l1);\r\n	padding: 12px;\r\n	box-sizing: border-box;\r\n	overflow: auto;\r\n}\r\n.pipeline-palette .palette-title {\r\n	font-size: 12px;\r\n	text-transform: uppercase;\r\n	letter-spacing: .04em;\r\n	color: var(--dsw-alias-label-secondary);\r\n	margin-bottom: 10px;\r\n}\r\n.palette-item {\r\n	display: flex;\r\n	align-items: center;\r\n	gap: 8px;\r\n	cursor: grab;\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	background: var(--dsw-alias-bg-base);\r\n	border-radius: 8px;\r\n	padding: 10px;\r\n	font-size: 13px;\r\n	user-select: none;\r\n}\r\n.palette-item:active { cursor: grabbing; }\r\n.palette-icon { width: 12px; height: 12px; border-radius: 3px; background: var(--dsw-alias-brand-primary); }\r\n/* The If brick: the decision diamond outline — the same mark the node wears. */\r\n.palette-icon.if {\r\n	background: transparent;\r\n	border: 2px solid var(--dsw-alias-brand-primary);\r\n	border-radius: 2px;\r\n	transform: rotate(45deg) scale(.82);\r\n	margin: 0 2px;\r\n}\r\n.pipeline-canvas {\r\n	position: relative;\r\n	flex: 1;\r\n	min-height: 0;\r\n	overflow: hidden;\r\n	background-image: radial-gradient(circle, rgba(128, 128, 128, .18) 1px, transparent 1px);\r\n	background-size: 20px 20px;\r\n}\r\n.pipeline-canvas:focus { outline: none; }\r\n.pipeline-hint {\r\n	position: absolute;\r\n	inset: 0;\r\n	display: flex;\r\n	align-items: center;\r\n	justify-content: center;\r\n	color: var(--dsw-alias-label-secondary);\r\n	font-size: 13px;\r\n	pointer-events: none;\r\n	text-align: center;\r\n	padding: 0 20px;\r\n}\r\n.pipeline-edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }\r\n.pipeline-edge { stroke: var(--dsw-alias-label-secondary); stroke-width: 2; fill: none; }\r\n.pipeline-arrowfill { fill: var(--dsw-alias-label-secondary); }\r\n.pipeline-edge-temp { stroke: var(--dsw-alias-brand-primary); stroke-width: 2; fill: none; stroke-dasharray: 6 4; }\r\n/* Named-port edge labels (\"mail → data\") at the edge midpoint: small, muted,\r\n   and stroked with the canvas background so they read over the edge line. */\r\n.pipeline-edge-label {\r\n	font-size: 9px;\r\n	fill: var(--dsw-alias-label-secondary);\r\n	paint-order: stroke;\r\n	stroke: var(--dsw-alias-bg-base);\r\n	stroke-width: 3px;\r\n	stroke-linejoin: round;\r\n}\r\n/* The connection port picker: a narrow overlay card reusing the config\r\n   overlay's dim backdrop. */\r\n.pipeline-edge-picker {\r\n	width: 320px;\r\n	max-width: 90%;\r\n	background: var(--dsw-alias-bg-layer-1);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 12px;\r\n	padding: 14px;\r\n	box-sizing: border-box;\r\n	display: flex;\r\n	flex-direction: column;\r\n	gap: 12px;\r\n	box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);\r\n}\r\n.pipeline-edge-picker h3 { margin: 0; font-size: 13px; font-weight: 600; }\r\n.pipeline-edge-picker .picker-row { display: flex; flex-direction: column; gap: 4px; }\r\n.pipeline-edge-picker label { font-size: 11px; color: var(--dsw-alias-label-secondary); }\r\n.pipeline-edge-picker select {\r\n	font-family: inherit;\r\n	font-size: 12px;\r\n	color: var(--dsw-alias-label-primary);\r\n	background: var(--dsw-alias-bg-base);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 6px;\r\n	padding: 6px 10px;\r\n	box-sizing: border-box;\r\n	width: 100%;\r\n}\r\n.pipeline-edge-picker select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }\r\n.pipeline-edge-picker .picker-actions { display: flex; justify-content: flex-end; gap: 8px; }\r\n.pipeline-node {\r\n	position: absolute;\r\n	width: 150px;\r\n	height: 58px;\r\n	box-sizing: border-box;\r\n	background: var(--dsw-alias-bg-layer-2);\r\n	border: 1.5px solid var(--dsw-alias-border-l2);\r\n	border-radius: 10px;\r\n	display: flex;\r\n	flex-direction: column;\r\n	align-items: center;\r\n	justify-content: center;\r\n	cursor: move;\r\n	user-select: none;\r\n}\r\n.pipeline-node.selected { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }\r\n.pipeline-node .node-name { font-size: 13px; font-weight: 600; }\r\n.pipeline-node .node-sub { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 3px; }\r\n.pipeline-node .node-edit {\r\n	position: absolute;\r\n	top: 3px;\r\n	right: 4px;\r\n	width: 18px;\r\n	height: 18px;\r\n	display: flex;\r\n	align-items: center;\r\n	justify-content: center;\r\n	padding: 0;\r\n	border: none;\r\n	border-radius: 5px;\r\n	background: transparent;\r\n	color: var(--dsw-alias-label-secondary);\r\n	cursor: pointer;\r\n}\r\n.pipeline-node .node-edit:hover { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }\r\n.pipeline-node .node-breakpoint {\r\n	position: absolute;\r\n	top: 3px;\r\n	left: 4px;\r\n	width: 18px;\r\n	height: 18px;\r\n	display: flex;\r\n	align-items: center;\r\n	justify-content: center;\r\n	padding: 0;\r\n	border: none;\r\n	border-radius: 5px;\r\n	background: transparent;\r\n	color: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent);\r\n	cursor: pointer;\r\n}\r\n.pipeline-node .node-breakpoint:hover { color: var(--dsw-alias-state-warning-primary); background: var(--dsw-alias-interactive-bg-hover); }\r\n.pipeline-node .node-breakpoint.armed { color: var(--dsw-alias-state-warning-primary); }\r\n/* Live per-node run states (from the active run's record). */\r\n.pipeline-node.node-running { border-color: var(--dsw-alias-brand-primary); }\r\n.pipeline-node.node-paused { border-color: var(--dsw-alias-state-warning-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-warning-primary) 55%, transparent); }\r\n.pipeline-node.node-done { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 60%, var(--dsw-alias-border-l2)); }\r\n.pipeline-node.node-aborted { border-color: var(--dsw-alias-state-error-primary); }\r\n.pipeline-node.node-error { border-color: var(--dsw-alias-state-error-primary); }\r\n.pipeline-node .node-status {\r\n	position: absolute;\r\n	bottom: -8px;\r\n	left: 50%;\r\n	transform: translateX(-50%);\r\n	font-size: 9px;\r\n	line-height: 1;\r\n	padding: 2px 7px;\r\n	border-radius: 999px;\r\n	background: var(--dsw-alias-bg-overlay);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	text-transform: uppercase;\r\n	letter-spacing: .05em;\r\n}\r\n.pipeline-node .node-status.status-running { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 50%, transparent); }\r\n.pipeline-node .node-status.status-paused { color: var(--dsw-alias-state-warning-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warning-primary) 50%, transparent); }\r\n.pipeline-node .node-status.status-done { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 50%, transparent); }\r\n.pipeline-node .node-status.status-aborted,\r\n.pipeline-node .node-status.status-error { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent); }\r\n.pipeline-view .pipeline-toolbar .pipeline-run-live {\r\n	font-size: 12px;\r\n	color: var(--dsw-alias-state-warning-primary);\r\n	padding: 3px 9px;\r\n	border-radius: 999px;\r\n	border: 1px dashed color-mix(in srgb, var(--dsw-alias-state-warning-primary) 50%, transparent);\r\n	line-height: 1;\r\n	max-width: 260px;\r\n	overflow: hidden;\r\n	text-overflow: ellipsis;\r\n	white-space: nowrap;\r\n}\r\n/* Fail-fast: the run is failing — a firing errored, in-flight agents draining. */\r\n.pipeline-view .pipeline-toolbar .pipeline-run-live.failed {\r\n	color: var(--dsw-alias-state-error-primary);\r\n	border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent);\r\n	border-style: solid;\r\n}\r\n.pipeline-port {\r\n	position: absolute;\r\n	width: 14px;\r\n	height: 14px;\r\n	border-radius: 50%;\r\n	background: var(--dsw-alias-bg-overlay);\r\n	border: 2px solid var(--dsw-alias-brand-primary);\r\n	cursor: crosshair;\r\n	/* left/top carry the anchor point (see portAnchor) — center on it. */\r\n	transform: translate(-50%, -50%);\r\n}\r\n.pipeline-port.out { border-color: var(--dsw-alias-state-success-primary); }\r\n.pipeline-port.hover { box-shadow: 0 0 0 4px var(--dsw-alias-brand-primary); }\r\n/* The if control node: the flowchart DECISION shape — a diamond, taller than\r\n   an agent (150×84) — so the fork reads as a decision, not a model call. The\r\n   node box itself is a transparent hit area; the shape is an SVG layer whose\r\n   border follows the diamond (a clip-path on the box would clip the node's\r\n   own buttons away with the corners). Ticks anchor on the four vertices. */\r\n.pipeline-node.control {\r\n	width: 150px;\r\n	height: 84px;\r\n	background: transparent;\r\n	border: none;\r\n}\r\n.control-shape {\r\n	position: absolute;\r\n	inset: 0;\r\n	width: 100%;\r\n	height: 100%;\r\n	pointer-events: none;\r\n}\r\n.control-shape polygon {\r\n	fill: var(--dsw-alias-bg-layer-2);\r\n	stroke: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l2));\r\n	stroke-width: 1.5;\r\n	vector-effect: non-scaling-stroke;\r\n}\r\n.pipeline-node.control.selected {\r\n	/* The base selection ring is rectangular — on the diamond the stroke and\r\n	   glow on the shape layer carry the selection instead. */\r\n	box-shadow: none;\r\n}\r\n.pipeline-node.control.selected .control-shape polygon {\r\n	stroke: var(--dsw-alias-brand-primary);\r\n	stroke-width: 2.5;\r\n}\r\n.pipeline-node.control.selected .control-shape {\r\n	filter: drop-shadow(0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent));\r\n}\r\n/* The shape layer is absolutely positioned, which paints it over the static\r\n   text — lift the labels into the positioned layer (they come later in the\r\n   DOM, so this alone puts them back on top). */\r\n.pipeline-node.control .node-name,\r\n.pipeline-node.control .node-sub { position: relative; }\r\n/* One labeled tick per branch: a wrapper centered on the anchor carrying the\r\n   dot plus the visible branch name, oriented away from the node edge. The\r\n   wrapper never catches the pointer — only its tick does. */\r\n.control-branch {\r\n	position: absolute;\r\n	display: flex;\r\n	align-items: center;\r\n	gap: 4px;\r\n	transform: translate(-50%, -50%);\r\n	pointer-events: none;\r\n}\r\n.control-branch.side-left { flex-direction: row-reverse; }\r\n.control-branch.side-top { flex-direction: column-reverse; }\r\n.control-branch.side-bottom { flex-direction: column; }\r\n.control-branch .pipeline-port { position: static; transform: none; pointer-events: auto; flex: 0 0 auto; }\r\n.control-branch .branch-label {\r\n	font-size: 9px;\r\n	line-height: 1;\r\n	color: var(--dsw-alias-label-secondary);\r\n	white-space: nowrap;\r\n}\r\n/* The control's warning chip (never-fire sources, side stacking) rides the\r\n   same bottom slot an agent's status chip uses — a control has none. */\r\n.pipeline-node .node-warn {\r\n	position: absolute;\r\n	bottom: -8px;\r\n	left: 50%;\r\n	transform: translateX(-50%);\r\n	font-size: 9px;\r\n	line-height: 1;\r\n	padding: 2px 7px;\r\n	border-radius: 999px;\r\n	background: var(--dsw-alias-bg-overlay);\r\n	border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary) 50%, transparent);\r\n	color: var(--dsw-alias-state-warning-primary);\r\n}\r\n/* The owner-handoff dialog's body text. */\r\n.pipeline-edge-picker .handoff-text { font-size: 12px; color: var(--dsw-alias-label-primary); line-height: 1.5; }\r\n.pipeline-json { border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }\r\n.pipeline-json pre {\r\n	margin: 0;\r\n	padding: 10px;\r\n	max-height: 200px;\r\n	overflow: auto;\r\n	font-size: 11px;\r\n	white-space: pre-wrap;\r\n	word-break: break-word;\r\n}\r\n";
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
			const [connectCursor, setConnectCursor] = react.useState(null);
			const [hoverTarget, setHoverTarget] = react.useState(null);
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
				if (nodeMenu !== null && !agents.some((a) => a.id === nodeMenu.nodeId) && !controls.some((k) => k.id === nodeMenu.nodeId)) setNodeMenu(null);
			}, [
				agents,
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
				setSelectedId(agent.id);
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
				setSelectedId(control.id);
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
				if (side === "left") return {
					x: a.x,
					y: a.y + NODE_H * frac,
					side
				};
				if (side === "right") return {
					x: a.x + NODE_W,
					y: a.y + NODE_H * frac,
					side
				};
				if (side === "top") return {
					x: a.x + NODE_W * frac,
					y: a.y,
					side
				};
				return {
					x: a.x + NODE_W * frac,
					y: a.y + NODE_H,
					side
				};
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
				setSelectedId(id);
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
			function onOutputPointerDown(e, nodeId, port) {
				if (e.button !== 0) return;
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
					startPort: port
				};
				setConnectCursor({
					x: p.x,
					y: p.y
				});
				setSelectedId(nodeId);
			}
			function onInputPointerEnter(e, nodeId) {
				e.stopPropagation();
				if (!connectRef.current) return;
				connectRef.current.hoverTarget = nodeId;
				setHoverTarget(nodeId);
			}
			function onInputPointerLeave(e, nodeId) {
				if (connectRef.current && connectRef.current.hoverTarget === nodeId) {
					connectRef.current.hoverTarget = null;
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
						const fromControl = controls.find((k) => k.id === c.from);
						const targetControl = controls.find((k) => k.id === target);
						if (fromControl !== void 0) {
							const branches = branchNamesOf(fromControl);
							setEdgeDraft({
								...conn,
								sourcePort: c.startPort !== void 0 && branches.includes(c.startPort) ? c.startPort : branches[0] ?? "",
								targetPort: inputPortNamesOf(target)[0]
							});
						} else if (targetControl !== void 0) {
							const source = agents.find((a) => a.id === c.from);
							if (source !== void 0 && (source.outputPorts !== void 0 || source.bindings !== void 0)) setOwnerHandoff({
								conn,
								control: targetControl
							});
							else setConnections((prev) => prev.concat([conn]));
						} else {
							const srcPorts = outputPortNamesOf(c.from);
							const sourcePort = c.startPort && srcPorts.includes(c.startPort) ? c.startPort : srcPorts[0];
							const tgtPorts = inputPortNamesOf(target);
							if (srcPorts.length > 1 || tgtPorts.length > 1) setEdgeDraft({
								...conn,
								sourcePort,
								targetPort: tgtPorts[0]
							});
							else setConnections((prev) => prev.concat([{
								...conn,
								...sourcePort !== "out" ? { sourcePort } : {},
								...tgtPorts[0] !== "in" ? { targetPort: tgtPorts[0] } : {}
							}]));
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
			}
			function onCanvasPointerDown(e) {
				if (canvasRef.current) canvasRef.current.focus();
				setSelectedId(null);
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
				if (controls.some((k) => k.id === nodeId)) {
					setControls((prev) => prev.filter((k) => k.id !== nodeId));
					setConnections((prev) => prev.filter((c) => c.source !== nodeId && c.target !== nodeId));
				} else {
					const dying = new Set(controls.filter((k) => connections.some((c) => c.source === nodeId && c.target === k.id)).map((k) => k.id));
					setAgents((prev) => prev.filter((a) => a.id !== nodeId));
					setControls((prev) => prev.filter((k) => !dying.has(k.id)));
					setConnections((prev) => prev.filter((c) => c.source !== nodeId && c.target !== nodeId && !dying.has(c.source) && !dying.has(c.target)));
				}
				if (selectedId === nodeId) setSelectedId(null);
			}
			function deleteSelected() {
				if (!selectedId) return;
				deleteNode(selectedId);
			}
			function clearAll() {
				setAgents([]);
				setConnections([]);
				setControls([]);
				setSelectedId(null);
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
				setSelectedId(nodeId);
				if (connectRef.current) return;
				setNodeMenu({
					nodeId,
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
				const nodeId = nodeMenu.nodeId;
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
			/** Complete a drafted connection with the picked port names. */
			function confirmEdgeDraft() {
				const d = edgeDraft;
				if (!d) return;
				setEdgeDraft(null);
				setConnections((prev) => prev.concat([{
					id: d.id,
					source: d.source,
					target: d.target,
					...d.sourcePort !== "out" ? { sourcePort: d.sourcePort } : {},
					...d.targetPort !== "in" ? { targetPort: d.targetPort } : {}
				}]));
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
				}
				setConnections((prev) => prev.concat([handoff.conn]));
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
			const EDGE_OFF = 60;
			const BRACKET_CLEAR = 30;
			const BRACKET_R = 8;
			function edgeGeometry(s, t) {
				if (s.side === t.side && (s.side === "top" || s.side === "bottom")) {
					const down = s.side === "bottom";
					const vdir = down ? 1 : -1;
					const lane = down ? Math.max(s.y, t.y) + BRACKET_CLEAR : Math.min(s.y, t.y) - BRACKET_CLEAR;
					const endY = t.y + vdir * 11;
					const sx = Math.sign(t.x - s.x);
					const r = Math.min(BRACKET_R, Math.abs(t.x - s.x) / 2, Math.abs(lane - s.y), Math.abs(lane - endY));
					let d;
					if (!Number.isFinite(r) || r < 1 || sx === 0) d = "M" + s.x + " " + s.y + " L" + s.x + " " + lane + " L" + t.x + " " + lane + " L" + t.x + " " + endY;
					else d = "M" + s.x + " " + s.y + " L" + s.x + " " + (lane - vdir * r) + " Q" + s.x + " " + lane + " " + (s.x + sx * r) + " " + lane + " L" + (t.x - sx * r) + " " + lane + " Q" + t.x + " " + lane + " " + t.x + " " + (lane - vdir * r) + " L" + t.x + " " + endY;
					return {
						d,
						mx: (s.x + t.x) / 2,
						my: down ? lane - 5 : lane + 14
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
				const arrX = t.x - c2.x, arrY = t.y - c2.y;
				const arrLen = Math.hypot(arrX, arrY);
				const head = 11;
				const ex = arrLen > head ? t.x - arrX / arrLen * head : t.x;
				const ey = arrLen > head ? t.y - arrY / arrLen * head : t.y;
				return {
					d: "M" + s.x + " " + s.y + " C" + c1.x + " " + c1.y + " " + c2.x + " " + c2.y + " " + ex + " " + ey,
					mx: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8,
					my: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 - 6
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
			const edges = connections.map((c) => {
				const src = findNode(c.source);
				const tgt = findNode(c.target);
				if (!src || !tgt) return null;
				const sourceName = c.sourcePort ?? "out";
				const targetName = c.targetPort ?? "in";
				const srcIsControl = "branches" in src;
				const s = outputAnchorOf(src, sourceName);
				const t = inputAnchorOf(tgt, targetName);
				const labeled = sourceName !== "out" || targetName !== "in";
				const geo = edgeGeometry(s, t);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: geo.d,
					className: "pipeline-edge",
					markerEnd: "url(#pipeline-arrow)"
				}), labeled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
					x: geo.mx,
					y: geo.my,
					className: "pipeline-edge-label",
					textAnchor: "middle",
					children: srcIsControl ? sourceName : sourceName + " → " + targetName
				}) : null] }, c.id);
			});
			let tempEdge = null;
			if (gesture) {
				const src0 = findNode(gesture.from);
				if (src0) {
					const s0 = outputAnchorOf(src0, gesture.startPort ?? ("branches" in src0 ? branchNamesOf(src0)[0] ?? "" : "out"));
					const cx = gesture.cursor ? gesture.cursor.x : s0.x;
					const cy = gesture.cursor ? gesture.cursor.y : s0.y;
					tempEdge = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: edgeGeometry(s0, {
							x: cx,
							y: cy,
							side: "left"
						}).d,
						className: "pipeline-edge-temp"
					});
				}
			}
			const nodes = agents.map((agent) => {
				const selected = agent.id === selectedId;
				const hoveredIn = hoverTarget === agent.id && gesture;
				const status = (runProjection !== null ? runProjection.nodes[agent.id] : void 0)?.status;
				const showStatus = status !== void 0 && status !== "pending";
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-node" + (selected ? " selected" : "") + (showStatus && status ? " node-" + status : ""),
					style: {
						left: agent.x + "px",
						top: agent.y + "px"
					},
					"data-agent-id": agent.id,
					"data-node-status": status ?? "",
					onPointerDown: (e) => {
						onNodePointerDown(e, agent.id, agent.x, agent.y, "agent");
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
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "node-edit",
							title: "Edit agent",
							"aria-label": "Edit agent " + agent.name,
							onPointerDown: (e) => {
								e.stopPropagation();
							},
							onClick: (e) => {
								e.stopPropagation();
								setConfigAgentId(agent.id);
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
								width: 10,
								height: 10,
								viewBox: "0 0 24 24",
								"aria-hidden": "true",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
									d: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: 2.4,
									strokeLinecap: "round",
									strokeLinejoin: "round"
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
						showStatus ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "node-status status-" + status,
							children: status
						}) : null,
						inputPortNamesOf(agent.id).map((portName) => {
							const anchor = portAnchor(agent, "in", portName);
							const multiple = inputPortNamesOf(agent.id).length > 1 || anchor.side !== "left";
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "pipeline-port in" + (hoveredIn ? " hover" : ""),
								style: {
									left: anchor.x - agent.x + "px",
									top: anchor.y - agent.y + "px"
								},
								onPointerEnter: (e) => {
									onInputPointerEnter(e, agent.id);
								},
								onPointerLeave: (e) => {
									onInputPointerLeave(e, agent.id);
								},
								onPointerDown: (e) => {
									if (e.button !== 0) return;
									e.preventDefault();
									e.stopPropagation();
								},
								title: multiple ? portName : "Input"
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
									onOutputPointerDown(e, agent.id, portName);
								},
								title: multiple ? portName : "Output"
							}, portName);
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
			const controlNodes = controls.map((control) => {
				const selected = control.id === selectedId;
				const hoveredIn = hoverTarget === control.id && gesture;
				const isIf = control.kind === "if";
				const warnings = controlWarnings(control);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "pipeline-node control" + (selected ? " selected" : ""),
					style: {
						left: control.x + "px",
						top: control.y + "px"
					},
					"data-control-id": control.id,
					onPointerDown: (e) => {
						onNodePointerDown(e, control.id, control.x, control.y, "control");
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
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "node-edit",
							title: "Edit branches",
							"aria-label": "Edit branches of " + control.id,
							onPointerDown: (e) => {
								e.stopPropagation();
							},
							onClick: (e) => {
								e.stopPropagation();
								setConfigControlId(control.id);
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
								width: 10,
								height: 10,
								viewBox: "0 0 24 24",
								"aria-hidden": "true",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
									d: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: 2.4,
									strokeLinecap: "round",
									strokeLinejoin: "round"
								})
							})
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
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "pipeline-port in" + (hoveredIn ? " hover" : ""),
							style: {
								left: "0px",
								top: "42px"
							},
							onPointerEnter: (e) => {
								onInputPointerEnter(e, control.id);
							},
							onPointerLeave: (e) => {
								onInputPointerLeave(e, control.id);
							},
							onPointerDown: (e) => {
								if (e.button !== 0) return;
								e.preventDefault();
								e.stopPropagation();
							},
							title: "Input"
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
										onOutputPointerDown(e, control.id, branchName);
									},
									title: "Branch " + branchName + " — drag to the agent that handles it"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "branch-label",
									children: branchName
								})]
							}, branchName + ":" + index);
						}) : null
					]
				}, control.id);
			});
			let configAgent = null;
			for (let k = 0; k < agents.length; k++) if (agents[k].id === configAgentId) configAgent = agents[k];
			let configControl = null;
			for (let k = 0; k < controls.length; k++) if (controls[k].id === configControlId) configControl = controls[k];
			const menuNode = nodeMenu !== null ? findNode(nodeMenu.nodeId) : null;
			const menuEntries = menuNode !== null ? nodeMenuEntries(menuNode) : [];
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
								disabled: !selectedId,
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
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("defs", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("marker", {
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
										}) }),
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
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "Connect ports" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "picker-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "From " + nameOf(edgeDraft.source) + (controls.some((k) => k.id === edgeDraft.source) ? " (branch)" : " (output port)") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: edgeDraft.sourcePort,
										onChange: (e) => {
											setEdgeDraft((d) => d ? {
												...d,
												sourcePort: e.target.value
											} : d);
										},
										children: outputPortNamesOf(edgeDraft.source).map((portName) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: portName,
											children: portName
										}, portName))
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "picker-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "To " + nameOf(edgeDraft.target) + " (input port)" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: edgeDraft.targetPort,
										onChange: (e) => {
											setEdgeDraft((d) => d ? {
												...d,
												targetPort: e.target.value
											} : d);
										},
										children: inputPortNamesOf(edgeDraft.target).map((portName) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: portName,
											children: portName
										}, portName))
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
		const css = "/* Shared primitives for every pipeline surface: buttons and the modal frame\r\n   (run + result modals). Injected once via the build's pipeline-css-inline\r\n   loader as <style data-plugin-css=\"dsh-agent-pipeline-canvas/styles/shared.css\">. */\r\n\r\n.pipeline-btn {\r\n	cursor: pointer;\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	background: var(--dsw-alias-bg-layer-2);\r\n	color: var(--dsw-alias-label-primary);\r\n	border-radius: 6px;\r\n	padding: 4px 10px;\r\n	font-size: 12px;\r\n}\r\n.pipeline-btn:hover { border-color: var(--dsw-alias-brand-primary); }\r\n.pipeline-btn:disabled { opacity: .5; cursor: default; }\r\n.pipeline-btn-run { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }\r\n.pipeline-btn-run:disabled { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }\r\n.pipeline-btn-stop { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }\r\n.pipeline-btn-mini { padding: 1px 8px; font-size: 11px; flex-shrink: 0; }\r\n\r\n.pipeline-modal-overlay {\r\n	position: fixed;\r\n	inset: 0;\r\n	z-index: 60;\r\n	display: flex;\r\n	align-items: center;\r\n	justify-content: center;\r\n	background: rgba(0, 0, 0, .45);\r\n}\r\n.pipeline-modal {\r\n	width: 560px;\r\n	max-width: 94%;\r\n	max-height: 88%;\r\n	background: var(--dsw-alias-bg-layer-1);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 12px;\r\n	padding: 16px;\r\n	box-sizing: border-box;\r\n	display: flex;\r\n	flex-direction: column;\r\n	gap: 14px;\r\n	box-shadow: 0 8px 30px rgba(0, 0, 0, .35);\r\n	overflow: auto;\r\n}\r\n.pipeline-modal h3 { margin: 0; font-size: 14px; font-weight: 600; }\r\n.pipeline-modal .modal-row { display: flex; flex-direction: column; gap: 6px; }\r\n.pipeline-modal label { font-size: 11px; color: var(--dsw-alias-label-secondary); }\r\n.pipeline-modal textarea {\r\n	font-family: inherit;\r\n	font-size: 12px;\r\n	color: var(--dsw-alias-label-primary);\r\n	background: var(--dsw-alias-bg-base);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 6px;\r\n	padding: 6px 8px;\r\n	box-sizing: border-box;\r\n	width: 100%;\r\n	min-height: 96px;\r\n	resize: vertical;\r\n}\r\n.pipeline-modal input {\r\n	font-family: inherit;\r\n	font-size: 12px;\r\n	color: var(--dsw-alias-label-primary);\r\n	background: var(--dsw-alias-bg-base);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 6px;\r\n	padding: 6px 8px;\r\n	box-sizing: border-box;\r\n	width: 100%;\r\n}\r\n.pipeline-modal textarea:focus, .pipeline-modal input:focus, .pipeline-modal select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }\r\n.pipeline-modal select {\r\n	font-family: inherit;\r\n	font-size: 12px;\r\n	color: var(--dsw-alias-label-primary);\r\n	background: var(--dsw-alias-bg-base);\r\n	border: 1px solid var(--dsw-alias-border-l2);\r\n	border-radius: 6px;\r\n	padding: 5px 8px;\r\n	box-sizing: border-box;\r\n	width: 100%;\r\n}\r\n.pipeline-modal-notice { font-size: 11px; color: var(--dsw-alias-state-warning-primary); }\r\n.pipeline-modal-status { font-size: 11px; color: var(--dsw-alias-state-error-primary); }\r\n.pipeline-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; align-items: center; }\r\n.pipeline-modal-actions .spacer { flex: 1; }\r\n";
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
