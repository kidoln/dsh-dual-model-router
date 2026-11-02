// dsh-dual-model-router — dual-model auto routing for DeepSeek Harness.
//
// Flow (per conversation, while its switch is ON):
//   1. prompt time  — the browser half holds a send and asks
//      POST /api/dual-model-router/route to decide and record the route before
//      the prompt is admitted, so even the FIRST step of the turn runs on it.
//      The host classifies the prompt against the recent conversation with one
//      cheap auxiliary-model call (keyword hit short-circuits it) and applies
//      the route through `agent.model.select()`.
//   2. agent/pre-step fallback — every human prompt is still classified here,
//      which covers sends that outran their classification, non-browser
//      clients, and subagents (always pinned to the fast auxiliary model,
//      since they are the executors).
//   3. the route — the root agent runs on the auxiliary model for simple tasks
//      and on the strong primary model for complex ones. While the router is on
//      it owns the route outright: a model chosen by hand (the /model command)
//      is overridden at the next step boundary, so switching the router off is
//      the only way to drive the session with a model of your own.
//      The route is written with `agent.model.select()` — the harness's own
//      durable selection — NOT by rewriting the `agent/request` waterfall:
//      the loop fixes a step's provider/model while preparing it and rejects a
//      waterfall result that diverges, so a route change takes effect at the
//      next step boundary.
//   4. system prompt   — while a root agent works on a complex task, agent-scoped
//      prompt sections tell the primary model to plan first and delegate every
//      execution step to subagents, followed by the user's own additional
//      instructions (`extraPrompt`, the settings page's free-text box).
//
// The switch is PER CONVERSATION. The row's `enabled` is only the default a
// session follows until the user flips that conversation's own switch from the
// composer pill; from then on the session's choice lives in this package's
// durable state (see `sessionSwitches`) and the row no longer decides for it.
// A subagent follows the switch of the session it was dispatched from, since
// the pill belongs to the root conversation.
//
// The settings save path goes through ctx.configEditor, which hot-applies the
// change; this package deliberately declares no Loader Config schema so it
// stays dependency-free (the profile links it from outside its node_modules,
// where @deepseek-ai/* imports would not resolve). resolveConfig below
// validates the untrusted row config by hand instead, and the per-session
// switches are read and written with node:fs rather than through a storage
// service for the same reason.
//
// The six /api routes are exact paths, which shadow the /api auth prefix, so
// each one authenticates itself through the `connection` service. The four that
// mutate state or spend a model call (save, toggle, route, debug-classify) also
// require an OWNER Peer: authentication alone would otherwise let a shared or
// remote caller rewrite the profile config or pin another session's model,
// because these handlers run outside any Remote invocation and therefore
// bypass `remoteAccess`'s policy.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { classifyTaskText, resetClassifierCaches } from './lib/classifier.js';
import { isHumanPrompt, keywordHit, pickTarget, sameRoute, userTextOf } from './lib/routing.js';

export const name = 'dsh-dual-model-router';

export const inject = ['llm', 'systemPrompt'];

/** Row id this bundle inserts; the settings save path targets it. */
const ROW_ID = 'dual-model-router';
/** Late placement for the planner-guidance prompt section. */
const SECTION_ORDER = 800;
/**
 * Placement of the user-authored extra-instructions section: immediately after
 * the planner guidance, so both plugin sections stay adjacent and read in the
 * order they were configured.
 */
const EXTRA_SECTION_ORDER = SECTION_ORDER + 1;
/** Longest user-authored instruction block the settings page may inject. */
const EXTRA_PROMPT_LIMIT = 8000;
/** On-disk shape of the per-session switch file; an unknown version is ignored. */
const SESSION_STATE_VERSION = 1;
/**
 * Per-session switches kept on disk. Beyond this the oldest are dropped: the
 * bound exists so an abandoned session id cannot grow the file forever, not as
 * an eviction policy any live session is expected to hit.
 */
const SESSION_STATE_LIMIT = 500;
/**
 * Recent human/assistant entries read from a session for classification. The
 * classifier itself keeps a smaller, character-bounded subset; collecting a
 * few extra here means its own budget decides where the context starts, not
 * this scan.
 */
const HISTORY_ENTRY_LIMIT = 24;
/** Session messages scanned backwards while filling that history window. */
const HISTORY_SCAN_LIMIT = 500;

/** Normalize untrusted plugin configuration into immutable policy. */
function resolveConfig(input) {
	const value = (input !== null && typeof input === 'object') ? input : {};
	const primary = (value.primary !== null && typeof value.primary === 'object') ? value.primary : {};
	const aux = (value.aux !== null && typeof value.aux === 'object') ? value.aux : {};
	const keywords = Array.isArray(value.complexKeywords)
		? value.complexKeywords
		: ['hard'];
	const route = (raw) => ({
		provider: String(raw.provider ?? ''),
		model: String(raw.model ?? ''),
		reasoningEffort: String(raw.reasoningEffort ?? '').trim(),
	});
	return {
		enabled: value.enabled === true,
		primary: route(primary),
		aux: route(aux),
		complexKeywords: keywords.map((word) => String(word ?? '').trim()).filter((word) => word.length > 0),
		classifierTimeoutMs: Number.isFinite(value.classifierTimeoutMs)
			? Math.min(120000, Math.max(1000, Math.trunc(value.classifierTimeoutMs)))
			: 15000,
		plannerGuidance: value.plannerGuidance !== false,
		extraPrompt: typeof value.extraPrompt === 'string'
			? value.extraPrompt.trim().slice(0, EXTRA_PROMPT_LIMIT)
			: '',
	};
}

const isConfigured = (route) => route.provider.length > 0 && route.model.length > 0;

const isSubagent = (agent) => agent?.session?.header?.origin === 'subagent';

/**
 * Prompt variable carrying the user's extra instructions.
 *
 * The text is never inlined into a section: sections are interpolated for
 * `{{variable}}` references and an unknown or MALFORMED reference throws, which
 * would break every request in the scope — and `interpolate: false` is not
 * honoured by every harness version. The settings box holds arbitrary user text
 * (a pasted Handlebars/Jinja template is an easy accident), so the text travels
 * through a variable: a substituted value is not rescanned, so it reaches the
 * model exactly as typed, braces and all.
 */
const EXTRA_VARIABLE = 'dual_model_router_extra';

/**
 * The user's own extra instructions: a one-line lead-in that names their source
 * (the model must be able to tell configured guidance from the task it was
 * given) followed by the `{{variable}}` reference above.
 */
function extraPromptText() {
	return [
		'Additional instructions from the user (dsh-dual-model-router):',
		`{{${EXTRA_VARIABLE}}}`,
	].join('\n');
}

/** Planner guidance shown to the primary model during a complex task. */
function guidanceText(aux) {
	return [
		'Task mode: COMPLEX (auto-selected by the dsh-dual-model-router plugin).',
		'You are the planning model for this task. Work as follows:',
		'1. First produce a short, concrete execution plan for the user\'s request.',
		`2. Delegate every execution step — file edits, searches, test runs, data gathering — to subagents (the subagent / workflow tools). Subagents run on the fast auxiliary model (${aux.provider}/${aux.model}), where execution is cheap; do not implement those steps yourself unless a step is a trivial one-liner.`,
		'3. Collect the subagents\' results, verify them, and resolve conflicts.',
		'4. Compose the final answer yourself. Planning, verification, and final synthesis stay with you; execution belongs to subagents.',
	].join('\n');
}

/**
 * Per-session routing state: the last classified message, the current mode and
 * the route this router last wrote.
 *
 * Deliberately module-scoped rather than per-apply: a Settings save re-applies
 * this plugin against sessions that are still live, and the session's current
 * mode, the prompt it was classified from and the route this router last wrote
 * must survive that reload — a per-apply map would forget which task the
 * conversation is in the middle of. Entries are dropped on `agent/disposed`;
 * the module itself survives a config-only reload.
 */
const sessionStates = new Map();

/**
 * The per-session ON/OFF switch: which sessions were switched by hand, and to
 * what. A session absent from this map follows the profile row's `enabled`
 * (the default for every session the user never touched).
 *
 * Module-scoped for the same reason `sessionStates` is — a Settings save
 * re-applies this plugin against sessions that are still live, and each
 * session's own switch must survive that reload — and mirrored to
 * `<DSH_HOME>/dual-model-router/sessions.json` so it also survives a host
 * restart. Entries are never dropped when an agent is disposed: the switch
 * belongs to the session id, and a session can be reopened after its agent is
 * gone. Only the size bound in `saveSwitches` prunes records.
 */
const sessionSwitches = {
	loaded: false,
	file: '',
	/** sessionId -> { enabled: boolean, at: number } */
	entries: new Map(),
};

/**
 * Where the switches live. `DSH_DUAL_MODEL_ROUTER_STATE` is an explicit escape
 * hatch (tests, throwaway hosts); otherwise the harness home decides, and a
 * missing `DSH_HOME` falls back to the same `~/.dsh` the harness itself uses.
 */
function switchesFile() {
	const override = String(process.env.DSH_DUAL_MODEL_ROUTER_STATE ?? '').trim();
	if (override.length > 0) return override;
	const home = String(process.env.DSH_HOME ?? '').trim();
	const root = home.length > 0 ? home : join(homedir(), '.dsh');
	return join(root, 'dual-model-router', 'sessions.json');
}

/** Read the switch file once per process; an unreadable file means "no overrides". */
function loadSwitches() {
	if (sessionSwitches.loaded) return sessionSwitches.entries;
	sessionSwitches.loaded = true;
	sessionSwitches.file = switchesFile();
	try {
		const raw = JSON.parse(readFileSync(sessionSwitches.file, 'utf8'));
		if (raw?.version !== SESSION_STATE_VERSION) return sessionSwitches.entries;
		for (const [sessionId, record] of Object.entries(raw.sessions ?? {})) {
			if (typeof record?.enabled !== 'boolean') continue;
			sessionSwitches.entries.set(sessionId, {
				enabled: record.enabled,
				at: Number.isFinite(record.at) ? Math.trunc(record.at) : 0,
			});
		}
	} catch {
		// absent, unreadable or written by another version: every session simply
		// follows the profile default until the user flips one
	}
	return sessionSwitches.entries;
}

/**
 * One switch's value, or undefined when this session follows the default.
 * @param sessionId - a session id; an absent id has no switch of its own.
 */
function switchOf(sessionId) {
	if (sessionId === undefined || sessionId === null || String(sessionId).length === 0) return undefined;
	return loadSwitches().get(String(sessionId))?.enabled;
}

/** Mirror the in-memory switches to disk; a failed write never breaks a toggle. */
function saveSwitches() {
	const entries = loadSwitches();
	if (entries.size > SESSION_STATE_LIMIT) {
		const oldest = [...entries.entries()]
			.sort((left, right) => left[1].at - right[1].at)
			.slice(0, entries.size - SESSION_STATE_LIMIT);
		for (const [sessionId] of oldest) entries.delete(sessionId);
	}
	const body = JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: Object.fromEntries(entries),
	}, null, '\t');
	try {
		mkdirSync(dirname(sessionSwitches.file), { recursive: true });
		// write-then-rename: a crash mid-write must not leave a half file that the
		// next start would read as "no overrides"
		const temporary = `${sessionSwitches.file}.tmp`;
		writeFileSync(temporary, body, 'utf8');
		renameSync(temporary, sessionSwitches.file);
	} catch {
		// a read-only or missing home directory costs durability, not the toggle
	}
}

/** Record one session's switch and persist it. */
function setSwitch(sessionId, enabled) {
	loadSwitches().set(String(sessionId), { enabled, at: Date.now() });
	saveSwitches();
}

/**
 * Walk a subagent up to the session the user actually drives.
 *
 * Subagents are the executors, so they follow the switch of the session they
 * were dispatched from rather than one of their own — the pill the user sees
 * belongs to the root conversation. A parent that is no longer live still
 * answers through its own recorded switch, which is why the walk can stop at
 * an id instead of a header.
 * @param agents - the live agent registry, when the service is available.
 * @param agent - the agent whose effective switch is wanted.
 * @returns the session id whose switch decides this agent's routing.
 */
function switchOwnerId(agents, agent) {
	let id = agent?.id;
	let session = agent?.session;
	for (let hops = 0; hops < 16; hops += 1) {
		if (session?.header?.origin !== 'subagent') break;
		const parentId = session.header.parentSession;
		if (parentId === undefined || parentId === null || String(parentId) === String(id)) break;
		const parent = agents?.get?.(parentId);
		if (parent === undefined) {
			id = String(parentId);
			break;
		}
		id = parent.id ?? String(parentId);
		session = parent.session;
	}
	return id;
}

function apply(ctx, input) {
	const config = resolveConfig(input);
	const appliedAt = new Date().toISOString();
	// The effort cache is module-scoped: a config edit or a swapped adapter must
	// not leave a stale reasoning effort behind, or every later classification
	// fails and routing silently sticks to 'simple'.
	resetClassifierCaches();

	const states = sessionStates;
	// A re-apply means new rules: a text classified under the previous keyword
	// list (or timeout) must be judged again, or an edited keyword list would
	// never take effect for a prompt that was already classified once.
	for (const previous of sessionStates.values()) previous.lastClassifiedText = undefined;

	/** Live routing status per session, pushed to the composer indicator (SSE). */
	const status = new Map();
	const statusSubscribers = new Set();
	/** Heartbeat timers of the open SSE responses; they outlive the route. */
	const statusHeartbeats = new Set();

	/** Last classifier verdict per session, for diagnostics. */
	const classifyDebug = new Map();

	/**
	 * Whether this router drives one session: its own hand-set switch when it has
	 * one, else the profile row's `enabled`.
	 */
	const enabledFor = (sessionId) => {
		const stored = switchOf(sessionId);
		return stored === undefined ? config.enabled : stored;
	};

	/**
	 * Whether this router drives one agent. A subagent answers for the session it
	 * was dispatched from — it is an executor, and it has no composer switch of
	 * its own — so the whole parent chain is walked to the conversation the user
	 * actually sees.
	 */
	const enabledForAgent = (agent) => enabledFor(switchOwnerId(ctx.get?.('agents'), agent));

	const sendTo = (subscriber, frame) => {
		try {
			subscriber.send(frame);
		} catch {
			// a dropped connection cleans itself up via its close handler
		}
	};

	const broadcastStatus = (sessionId, patch) => {
		status.set(sessionId, { ...patch, at: Date.now() });
		const frame = { type: 'status', sessionId, status: status.get(sessionId) };
		for (const subscriber of statusSubscribers) {
			if (subscriber.sessionId === sessionId) sendTo(subscriber, frame);
		}
	};

	const clearStatus = (sessionId) => {
		if (!status.delete(sessionId)) return;
		const frame = { type: 'status', sessionId, status: null };
		for (const subscriber of statusSubscribers) {
			if (subscriber.sessionId === sessionId) sendTo(subscriber, frame);
		}
	};

	/**
	 * The frame that describes one conversation's routing state: the same one an
	 * SSE connection receives on connect, so a surface that is already connected
	 * sees a hand-flipped switch exactly as it sees a re-applied config.
	 * @param sessionId - the conversation the frame describes; undefined means
	 *   "no session", and the frame then carries the profile default.
	 */
	const initFrame = (sessionId) => ({
		type: 'init',
		enabled: enabledFor(sessionId),
		defaultEnabled: config.enabled,
		primary: config.primary,
		aux: config.aux,
		classifierTimeoutMs: config.classifierTimeoutMs,
		status: (sessionId !== undefined ? status.get(sessionId) : undefined) ?? null,
	});

	/** Push one conversation's current state to every subscribed surface of it. */
	const broadcastInit = (sessionId) => {
		if (sessionId === undefined || sessionId === null || String(sessionId).length === 0) return;
		const frame = initFrame(String(sessionId));
		for (const subscriber of statusSubscribers) {
			if (subscriber.sessionId === sessionId) sendTo(subscriber, frame);
		}
	};

	const stateOf = (agent) => {
		let state = states.get(agent.id);
		if (state === undefined) {
			state = {
				lastMessageId: undefined,
				mode: 'simple',
				lastRoute: undefined,
				// text the prompt-time endpoint already classified for this session
				lastClassifiedText: undefined,
			};
			states.set(agent.id, state);
		}
		return state;
	};

	/** Agents whose prompt sections are all registered. */
	const sectionAgents = new Set();

	/**
	 * Agent-owned section registrations: the agent's fiber owns them, so this
	 * plugin must release them itself on teardown.
	 * agentId -> Array<{ name: string, dispose: () => void }>
	 */
	const agentDisposers = new Map();

	/** Release the agent-scoped hooks this plugin installed for one agent. */
	const releaseAgent = (agentId) => {
		const held = agentDisposers.get(agentId);
		if (held === undefined) return;
		agentDisposers.delete(agentId);
		for (const entry of held) {
			if (typeof entry?.dispose !== 'function') continue;
			try {
				entry.dispose();
			} catch {
				// cleanup must not throw
			}
		}
	};

	/**
	 * Whether `EXTRA_VARIABLE` is registered. The extra-instructions section may
	 * only reference it once it exists — a missing reference throws during
	 * assembly — so an unsupported harness turns the feature off rather than
	 * breaking the request.
	 */
	let extraVariableReady = false;

	/**
	 * The prompt sections this plugin contributes to one agent. Registration is
	 * per-agent and one-shot; each `text` provider decides per assembly, and
	 * every gate below returns '' rather than unregistering.
	 */
	const promptSections = (agent) => [
		{
			name: `dual-model-router/${agent.id}`,
			order: SECTION_ORDER,
			interpolate: false,
			text: () => {
				const state = states.get(agent.id);
				if (!enabledForAgent(agent) || !config.plannerGuidance) return '';
				if (state === undefined || state.mode !== 'complex') return '';
				if (isSubagent(agent)) return '';
				if (!isConfigured(config.primary)) return '';
				return guidanceText(config.aux);
			},
		},
		{
			// The user's own instructions, injected alongside the planner guidance:
			// complex ROOT tasks only, exactly like the guidance above, and
			// independent of the `plannerGuidance` switch — that switch owns the
			// built-in text, not this one.
			//
			// No `interpolate: false` here (unlike the section above): this text IS a
			// `{{variable}}` reference and must be interpolated — the user's own
			// words travel through that variable, untouched by the scanner.
			name: `dual-model-router/${agent.id}/extra`,
			order: EXTRA_SECTION_ORDER,
			text: () => {
				if (!extraVariableReady || config.extraPrompt.length === 0) return '';
				const state = states.get(agent.id);
				if (!enabledForAgent(agent)) return '';
				if (state === undefined || state.mode !== 'complex') return '';
				if (isSubagent(agent)) return '';
				if (!isConfigured(config.primary)) return '';
				return extraPromptText();
			},
		},
	];

	/** Register this agent's prompt sections lazily; applies from the next assembly. */
	const ensureSections = (agent) => {
		if (sectionAgents.has(agent.id)) return;
		const installed = agentDisposers.get(agent.id) ?? [];
		let complete = true;
		for (const spec of promptSections(agent)) {
			if (installed.some((entry) => entry.name === spec.name)) continue;
			try {
				installed.push({ name: spec.name, dispose: agent.ctx.systemPrompt.section(spec) });
			} catch {
				// A refused section (a duplicate name in this layer) must never break
				// the request, and must be retried by the next step instead of being
				// remembered as done — while the sections that DID register stay put.
				complete = false;
			}
		}
		agentDisposers.set(agent.id, installed);
		if (complete) sectionAgents.add(agent.id);
	};

	/**
	 * Record one route on the agent itself. `agent/request` may no longer change
	 * provider/model — the loop throws when a waterfall result diverges from the
	 * selection it fixed while preparing the step — so the router drives the
	 * framework's own selection (`agent.model.select`), which appends a durable
	 * model/selection event and applies from the next step boundary on. A route
	 * that is already current appends nothing.
	 */
	const selectRoute = (agent, route, state) => {
		const model = agent?.model;
		state.lastRoute = { provider: route.provider, model: route.model };
		if (model === undefined || typeof model.select !== 'function') return;
		const next = { provider: route.provider, model: route.model };
		if (route.reasoningEffort.length > 0) next.reasoningEffort = route.reasoningEffort;
		let current;
		try {
			current = model.current();
		} catch {
			current = undefined;
		}
		if (sameRoute(current, next) && (next.reasoningEffort === undefined || current?.reasoningEffort === next.reasoningEffort)) return;
		try {
			model.select(next);
		} catch {
			// a rejected selection must never block the step
		}
	};

	/**
	 * Write this agent's route for the step that is about to run and publish it to
	 * the composer surfaces.
	 * @returns what the router did — the prompt-time endpoint reports it back to
	 *   the client that held its send for the classification.
	 */
	const applyRoute = (agent, state) => {
		if (!enabledForAgent(agent) || !isConfigured(config.aux)) return { kind: 'off' };
		if (isSubagent(agent)) {
			// subagents are the executors: they always run on the cheap model
			selectRoute(agent, config.aux, state);
			const route = { provider: config.aux.provider, model: config.aux.model };
			broadcastStatus(agent.id, { kind: 'subagent', route });
			return { kind: 'subagent', route, mode: state.mode };
		}
		const target = pickTarget(state.mode, config);
		if (!isConfigured(target)) return { kind: 'off' };
		selectRoute(agent, target, state);
		broadcastStatus(agent.id, { kind: 'auto', mode: state.mode, route: { ...state.lastRoute } });
		return { kind: 'auto', route: { ...state.lastRoute }, mode: state.mode };
	};

	/**
	 * Recent human/assistant text for the classifier's conversation context.
	 *
	 * `agent.session.deriveMessages()` is the harness's derived message history
	 * (system prompt included, tool traffic included). The classifier needs the
	 * shape of the conversation, not tool output: keep only human-authored user
	 * prompts and assistant text, newest first. The classifier clips the result
	 * to its own prompt budget.
	 *
	 * @param agent - the live agent whose session owns the history.
	 * @param currentText - the message being classified; excluded when a caller
	 *   already has it on the session surface.
	 * @returns chronological `{role, text}` entries, oldest first.
	 */
	const conversationHistory = (agent, currentText) => {
		let messages;
		try {
			messages = agent?.session?.deriveMessages?.();
		} catch {
			return [];
		}
		if (!Array.isArray(messages)) return [];
		const recent = [];
		let index = messages.length - 1;
		let scanned = 0;
		while (index >= 0 && scanned < HISTORY_SCAN_LIMIT && recent.length < HISTORY_ENTRY_LIMIT) {
			const message = messages[index];
			index -= 1;
			scanned += 1;
			if (message?.role !== 'user' && message?.role !== 'assistant') continue;
			// machine-produced user messages are not conversation: goal rounds,
			// reminders, runtime-context snapshots and subagent reports
			if (message.role === 'user' && !isHumanPrompt(message)) continue;
			const text = userTextOf(message).trim();
			if (text.length === 0) continue;
			recent.push({ role: message.role, text });
		}
		recent.reverse();
		// the current prompt is not on the surface yet at either entry point, but
		// a caller that already admitted it must not see the same text twice
		const last = recent[recent.length - 1];
		if (
			last !== undefined
			&& last.role === 'user'
			&& currentText !== undefined
			&& last.text === String(currentText).trim()
		) {
			recent.pop();
		}
		return recent;
	};

	/**
	 * Classify one human task text and record the verdict on the agent's state.
	 * The keyword override stays deterministic (no model call); every other text
	 * costs one auxiliary-model round trip, which also reads the recent
	 * conversation and the session's current mode.
	 * @param signal - optional caller cancellation (the step's own abort signal).
	 * @returns the verdict, with its provenance for diagnostics.
	 */
	const classifyAgentTask = async (agent, state, text, signal) => {
		// a stopped turn changes nothing: no verdict, no recorded text
		if (signal?.aborted === true) return { mode: state.mode, source: 'cancelled', raw: '' };
		const keyword = keywordHit(text, config.complexKeywords);
		if (keyword !== undefined) {
			state.mode = 'complex';
			state.lastClassifiedText = text;
			const verdict = { mode: 'complex', source: 'keyword', raw: `keyword match: ${keyword}` };
			classifyDebug.set(agent.id, { input: text.slice(0, 200), history: 0, ...verdict, at: Date.now() });
			return verdict;
		}
		broadcastStatus(agent.id, { kind: 'classifying' });
		const history = conversationHistory(agent, text);
		const classified = await classifyTaskText(ctx.llm, config, text, {
			signal,
			history,
			currentMode: state.mode,
		});
		// the turn was cancelled while the classifier ran: keep the mode this
		// session already had, and leave the text unclassified so a later resend
		// of the same prompt is judged on its own
		if (signal?.aborted === true) return { mode: state.mode, source: 'cancelled', raw: '' };
		// A failed attempt must not overwrite a mode the session already has: one
		// timeout in the middle of a complex task would otherwise drop the root
		// agent to the cheap route and remove its planner guidance. A new session
		// still starts — and stays — simple. Leave the text unclassified so a
		// later path can retry it.
		if (classified.failed === true) {
			const verdict = { mode: state.mode, source: 'failed', raw: classified.raw.slice(0, 400) };
			classifyDebug.set(agent.id, { input: text.slice(0, 200), history: history.length, ...verdict, at: Date.now() });
			return verdict;
		}
		state.mode = classified.mode;
		// Remember the exact text this verdict belongs to. The prompt-time
		// endpoint classifies the prompt before the send is admitted, and
		// `agent/pre-step` then claims that same text as a fresh message: without
		// this, one message would pay two classifier round trips.
		state.lastClassifiedText = text;
		const verdict = { mode: classified.mode, source: 'llm', raw: classified.raw.slice(0, 400) };
		classifyDebug.set(agent.id, { input: text.slice(0, 200), history: history.length, ...verdict, at: Date.now() });
		return verdict;
	};

	// The extra instructions' value, registered globally and BEFORE the agent
	// hooks below so that a teardown releases the referencing sections first and
	// the variable last: a live section whose variable has already gone would
	// throw during assembly.
	ctx.effect(() => {
		if (typeof ctx.systemPrompt?.variable !== 'function') return () => {};
		const dispose = ctx.systemPrompt.variable(
			EXTRA_VARIABLE,
			// Deliberately NOT gated on any one switch: the text is only ever read by
			// the section above, whose own per-session gate decides whether it is
			// injected — a global gate here would drop the user's instructions for a
			// session that switched the router on by hand while the default is off.
			() => config.extraPrompt,
		);
		extraVariableReady = true;
		return () => {
			extraVariableReady = false;
			dispose();
		};
	}, 'dsh-dual-model-router: extra-instructions variable');

	// Global waterfalls (the shipped checkpoint-policy pattern): every agent's
	// steps pass here no matter when or where the agent was created, so
	// fiber-reload races cannot leave sessions unmanaged.
	ctx.effect(() => {

		const preStep = ctx.on('agent/pre-step', async (payload, next) => {
			// Every host listener calls `next()` first and bails on a rejection
			// (an archived session, a gate plugin), and this router classifies on
			// a real round trip and appends a durable model/selection — work a
			// rejected step must not pay for. The step's own selection is already
			// captured before this waterfall, so ordering changes nothing about
			// which step a route reaches.
			const decision = await next();
			const signal = payload?.signal;
			try {
				const agent = payload?.agent;
				// a rejected or already-cancelled step gets no classification, no
				// route and no durable selection
				if (agent !== undefined && decision?.kind !== 'reject' && signal?.aborted !== true) {
					const messages = payload?.messages ?? [];
					// agent/pre-step fires every step and claims machine-generated
					// user-role messages too (goal rounds, subagent reports); only a
					// human prompt may re-decide the mode
					ensureSections(agent);
					let latest;
					for (let index = messages.length - 1; index >= 0; index -= 1) {
						if (isHumanPrompt(messages[index])) {
							latest = messages[index];
							break;
						}
					}
					const state = stateOf(agent);
					if (latest !== undefined && latest.id !== state.lastMessageId) {
						state.lastMessageId = latest.id;
						if (enabledForAgent(agent) && isConfigured(config.aux) && !isSubagent(agent)) {
							const taskText = userTextOf(latest);
							// an attachment-only prompt carries no task text; keep the
							// current mode rather than forcing it back to 'simple'
							//
							// the prompt-time endpoint may already have classified
							// exactly this text before the send was admitted; asking
							// again would pay a second round trip for one message
							if (taskText.trim().length > 0 && taskText !== state.lastClassifiedText) {
								await classifyAgentTask(agent, state, taskText, signal);
							}
						}
					}
					// a turn cancelled during classification must not record a route
					if (signal?.aborted !== true) applyRoute(agent, state);
				}
			} catch {
				// classification failure must never block the step
			}
			return decision;
		});

		const disposed = ctx.on('agent/disposed', ({ agent }) => {
			releaseAgent(agent.id);
			states.delete(agent.id);
			sectionAgents.delete(agent.id);
			clearStatus(agent.id);
			classifyDebug.delete(agent.id);
		});

		return () => {
			preStep();
			disposed();
			// agent-owned hooks survive this fiber's teardown, so release them
			// explicitly before dropping the per-apply bookkeeping
			for (const agentId of [...agentDisposers.keys()]) releaseAgent(agentId);
			// `states` / `sessionStates` is NOT cleared: the sessions it describes
			// are still live and the next apply must inherit their route.
			sectionAgents.clear();
			classifyDebug.clear();
		};
	}, 'dsh-dual-model-router: agent hooks');

	// Settings endpoints for the client half. The web server is a service that
	// activates on its own schedule — it is NOT available when this plugin
	// applies (a bare `ctx.get('webServer')` here returns undefined, and the
	// endpoints would silently never register), and a headless deployment never
	// provides it at all. A child fiber owned by this plugin waits for it, so
	// the routes appear as soon as the server does and headless profiles still
	// activate cleanly.
	ctx.inject(['webServer'], (webCtx) => {
		const webServer = webCtx.webServer;
		webCtx.effect(() => {
			const json = (res, status, value) => {
				const body = JSON.stringify(value);
				res.writeHead(status, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(body);
			};

			const readBody = (req, limit = 65536) => new Promise((resolve, reject) => {
				const chunks = [];
				let size = 0;
				req.on('data', (chunk) => {
					size += chunk.length;
					if (size > limit) {
						reject(new Error('request body too large'));
						req.destroy();
						return;
					}
					chunks.push(chunk);
				});
				req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
				req.on('error', reject);
			});

			// Exact routes shadow the /api auth prefix, so gate every one of them here
			// (Host/Origin fence + browser-cookie/API-token), fail closed.
			const rejectionOf = (req, res, options = {}) => {
				const connection = ctx.get?.('connection');
				const refuse = (status, text) => {
					res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(text);
					return true;
				};
				const reject503 = () => refuse(503, 'auth unavailable');
				if (typeof connection?.requestRejection !== 'function') return reject503();
				let rejection;
				try {
					rejection = connection.requestRejection(req);
				} catch {
					return reject503();
				}
				if (rejection !== undefined) return refuse(rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
				if (options.owner !== true) return false;
				// Authentication alone is not authorization. These exact routes
				// shadow the /api gateway, so no Remote invocation exists and
				// `remoteAccess`'s policy check short-circuits to "owner" — a
				// non-owner Peer (a shared/remote caller) holding a valid cookie
				// would otherwise be able to rewrite the profile config or pin
				// another session's model. Resolve the Peer and require the owner.
				if (typeof connection.admit !== 'function') return reject503();
				let admission;
				try {
					admission = connection.admit(req);
				} catch {
					return reject503();
				}
				if (admission?.rejection !== undefined) {
					return refuse(admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden');
				}
				if (admission?.peer?.principal?.kind !== 'owner') return refuse(403, 'forbidden');
				return false;
			};

			const providersCatalog = async () => {
				const providers = [];
				try {
					for (const info of ctx.llm.listProviders()) {
						let models = [];
						try {
							models = await ctx.llm.listModels(info.id);
						} catch {
							// one provider's catalog failure is non-fatal
						}
						providers.push({
							id: info.id,
							name: info.name ?? info.id,
							models: await Promise.all((Array.isArray(models) ? models : []).map(async (model) => {
								let efforts;
								try {
									const resolved = await ctx.llm.resolveModelInfo(info.id, model.id);
									efforts = (resolved?.reasoning?.efforts ?? [])
										.map((effort) => effort?.id)
										.filter((id) => typeof id === 'string');
								} catch {
									// efforts stay unknown; the page offers common values
								}
								return {
									id: model.id,
									name: model.name ?? model.id,
									...(efforts !== undefined && efforts.length > 0 ? { efforts } : {}),
								};
							})),
						});
					}
				} catch {
					// catalog unavailable: the page still shows the saved config
				}
				return providers;
			};

			/**
			 * Best-effort availability check for the two configured routes.
			 * `isConfigured` only proves both fields are non-empty, and
			 * `agent.model.select()` performs no availability validation — so a
			 * typo or a removed model would not fail until every later step died
			 * while preparing its request. Refusing at enable time turns that
			 * into one clear 409.
			 * @returns an error message, or undefined when both routes resolve.
			 */
			const unresolvableRoute = async (candidate) => {
				const llm = ctx.llm;
				if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return undefined;
				for (const key of ['primary', 'aux']) {
					const route = candidate?.[key];
					if (!isConfigured(route)) continue;
					try {
						await llm.resolveModelInfo(route.provider, route.model);
					} catch (error) {
						return `${key}: ${String(error?.message ?? error)}`;
					}
				}
				return undefined;
			};

			const getRoute = webServer.register({
				kind: 'exact',
				path: '/api/dual-model-router/settings',
				handler: async (req, res) => {
					if (rejectionOf(req, res)) return;
					if (req.method !== 'GET' && req.method !== 'HEAD') {
						json(res, 405, { ok: false, error: 'GET required' });
						return;
					}
					json(res, 200, {
						debug: {
							appliedAt,
							statusEntries: [...status.entries()].map(([sessionId, value]) => ({ sessionId, ...value })),
							classifier: [...classifyDebug.entries()].map(([sessionId, value]) => ({ sessionId, ...value })),
							// every conversation switched by hand; the rest follow `config.enabled`
							// and are absent here by design
							switches: [...loadSwitches().entries()].map(([sessionId, value]) => ({ sessionId, ...value })),
							defaultEnabled: config.enabled,
						},
						config,
						providers: await providersCatalog(),
					});
				},
			});

			/** The profile row this bundle inserted, as the Loader currently holds it. */
			const configRow = () => {
				const editor = ctx.get?.('configEditor');
				if (editor === undefined) return undefined;
				const entry = editor.entries().find((candidate) => candidate.options.id === ROW_ID);
				if (entry === undefined) return undefined;
				return { editor, entry };
			};

			/**
			 * The row's effective config: profile override over the inherited layer.
			 * `entry.options.config` is only the insert layer, so it would miss
			 * values the profile supplies; the applied `config` IS this apply's
			 * merged, effective config and is the accurate fallback.
			 */
			const rowConfigOf = (editor) => {
				try {
					const record = editor.configuration?.().find((candidate) => candidate.entry?.options?.id === ROW_ID);
					if (record !== undefined) {
						return { ...(record.inherited ?? {}), ...(record.override ?? {}) };
					}
				} catch {
					// configuration() is optional surface; the applied config is the fallback
				}
				return config;
			};

			const postRoute = webServer.register({
				kind: 'exact',
				path: '/api/dual-model-router/settings/save',
				handler: async (req, res) => {
					// a profile write: the owner only
					if (rejectionOf(req, res, { owner: true })) return;
					if (req.method !== 'POST') {
						json(res, 405, { ok: false, error: 'POST required' });
						return;
					}
					try {
						const row = configRow();
						if (row === undefined) {
							json(res, 500, { ok: false, error: 'config editor unavailable' });
							return;
						}
						const raw = JSON.parse(await readBody(req));
						if (raw === null || typeof raw !== 'object') throw new Error('body must be a JSON object');
						const patch = {};
						if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled;
						if (typeof raw.plannerGuidance === 'boolean') patch.plannerGuidance = raw.plannerGuidance;
						if (Number.isFinite(raw.classifierTimeoutMs)) {
							patch.classifierTimeoutMs = Math.min(120000, Math.max(1000, Math.trunc(raw.classifierTimeoutMs)));
						}
						for (const key of ['primary', 'aux']) {
							const route = raw[key];
							if (route === undefined) continue;
							if (route === null || typeof route !== 'object') throw new Error(`${key} must be an object`);
							const provider = String(route.provider ?? '');
							const model = String(route.model ?? '');
							if ((provider.length === 0) !== (model.length === 0)) {
								throw new Error(`${key}: provider and model must be set together`);
							}
							const reasoningEffort = typeof route.reasoningEffort === 'string'
								? route.reasoningEffort.trim().slice(0, 32)
								: '';
							patch[key] = { provider, model, reasoningEffort };
						}
						if (typeof raw.extraPrompt === 'string') {
							patch.extraPrompt = raw.extraPrompt.trim().slice(0, EXTRA_PROMPT_LIMIT);
						}
						if (Array.isArray(raw.complexKeywords)) {
							patch.complexKeywords = raw.complexKeywords
								.map((word) => String(word ?? '').trim())
								.filter((word) => word.length > 0 && word.length <= 64)
								.slice(0, 64);
						}
						// Only a save that leaves the router ON has to be usable:
						// switching it on, or editing a route while it is already
						// running. Saving other fields (or disabling) never blocks.
						const editsRoutes = patch.primary !== undefined || patch.aux !== undefined;
						const nextEnabled = patch.enabled === true
							|| (patch.enabled === undefined && config.enabled === true && editsRoutes);
						if (nextEnabled) {
							const candidate = resolveConfig({ ...rowConfigOf(row.editor), ...patch });
							if (!isConfigured(candidate.primary) || !isConfigured(candidate.aux)) {
								json(res, 409, { ok: false, error: 'configure both models before enabling the router' });
								return;
							}
							const unavailable = await unresolvableRoute(candidate);
							if (unavailable !== undefined) {
								json(res, 409, { ok: false, error: `unknown model — ${unavailable}` });
								return;
							}
						}
						await row.editor.edit(row.entry, (current) => ({ ...current, ...patch }));
						json(res, 200, { ok: true });
					} catch (error) {
						json(res, 400, { ok: false, error: String(error?.message ?? error) });
					}
				},
			});

			// One-tap flip used by the composer pill and the keyboard shortcut.
			//
			// With a `sessionId` the flip belongs to THAT conversation alone: the
			// per-session switch is written to this plugin's own durable state, never
			// to the profile row, so two conversations can no longer drag each other
			// on and off. Without one it falls back to the profile row's `enabled`,
			// which is the default every untouched session follows.
			//
			// Enabling refuses a half-configured router (the settings page does the
			// same before its Save button) or one whose models do not resolve, since a
			// typo would otherwise only surface as every later step failing to prepare.
			const toggleRoute = webServer.register({
				kind: 'exact',
				path: '/api/dual-model-router/toggle',
				handler: async (req, res) => {
					// this pins a session's model or rewrites the default: the owner only
					if (rejectionOf(req, res, { owner: true })) return;
					if (req.method !== 'POST') {
						json(res, 405, { ok: false, error: 'POST required' });
						return;
					}
					try {
						// An empty body is legal here: the endpoint's whole meaning is "flip",
						// and a caller that only wants the opposite state has nothing to say.
						const raw = (await readBody(req)).trim();
						const body = raw.length === 0 ? {} : JSON.parse(raw);
						const sessionId = String(body?.sessionId ?? '');
						if (sessionId.length > 0) {
							// a session's own switch needs no config row at all
							const current = enabledFor(sessionId);
							const enabled = typeof body?.enabled === 'boolean' ? body.enabled : !current;
							if (enabled) {
								if (!isConfigured(config.primary) || !isConfigured(config.aux)) {
									json(res, 409, { ok: false, error: 'configure both models before enabling the router' });
									return;
								}
								const unavailable = await unresolvableRoute(config);
								if (unavailable !== undefined) {
									json(res, 409, { ok: false, error: `unknown model — ${unavailable}` });
									return;
								}
							}
							setSwitch(sessionId, enabled);
							// every surface of this conversation follows the switch, including
							// another browser tab: push the new state instead of waiting for a
							// reconnect that a per-session flip never triggers
							broadcastInit(sessionId);
							json(res, 200, { ok: true, enabled, sessionId });
							return;
						}
						const row = configRow();
						if (row === undefined) {
							json(res, 500, { ok: false, error: 'config editor unavailable' });
							return;
						}
						const current = rowConfigOf(row.editor);
						const enabled = typeof body?.enabled === 'boolean' ? body.enabled : current?.enabled !== true;
						if (enabled) {
							const candidate = resolveConfig({ ...current, enabled: true });
							if (!isConfigured(candidate.primary) || !isConfigured(candidate.aux)) {
								json(res, 409, { ok: false, error: 'configure both models before enabling the router' });
								return;
							}
							const unavailable = await unresolvableRoute(candidate);
							if (unavailable !== undefined) {
								json(res, 409, { ok: false, error: `unknown model — ${unavailable}` });
								return;
							}
						}
						await row.editor.edit(row.entry, (raw) => ({ ...raw, enabled }));
						json(res, 200, { ok: true, enabled });
					} catch (error) {
						json(res, 400, { ok: false, error: String(error?.message ?? error) });
					}
				},
			});

			const statusRoute = webServer.register({
				kind: 'exact',
				path: '/api/dual-model-router/status',
				handler: async (req, res) => {
					if (rejectionOf(req, res)) return;
					const session = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session') ?? undefined;
					// the switch that applies to THIS conversation: its own override when it
					// has one, else the profile default (`defaultEnabled`, which is also what
					// a request without a session — the settings surfaces — sees)
					const snapshot = () => initFrame(session);
					if (!String(req.headers.accept ?? '').includes('text/event-stream')) {
						json(res, 200, snapshot());
						return;
					}
					res.writeHead(200, {
						'content-type': 'text/event-stream; charset=utf-8',
						'cache-control': 'no-store',
						connection: 'keep-alive',
						'x-accel-buffering': 'no',
					});
					res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
					const subscriber = {
						sessionId: session,
						send: (frame) => {
							res.write(`data: ${JSON.stringify(frame)}\n\n`);
						},
						// the response outlives the route registration, so the apply
						// teardown closes it explicitly (see the effect cleanup)
						close: () => {
							try {
								res.end();
							} catch {
								// an already-closed socket needs no further work
							}
						},
					};
					statusSubscribers.add(subscriber);
					const heartbeat = setInterval(() => {
						// a destroyed socket can still hold the interval for one
						// tick; writing into it would emit an unhandled 'error'
						if (res.writableEnded === true || res.destroyed === true) {
							release();
							return;
						}
						try {
							res.write(': ping\n\n');
						} catch {
							release();
						}
					}, 20000);
					statusHeartbeats.add(heartbeat);
					// The response outlives the route registration, and its socket can
					// die without a request 'close' (or between writes): release the
					// subscriber, the heartbeat and the error listener together.
					function release() {
						statusSubscribers.delete(subscriber);
						statusHeartbeats.delete(heartbeat);
						clearInterval(heartbeat);
					}
					req.on('close', release);
					if (typeof res.on === 'function') res.on('error', release);
				},
			});

			// Prompt-time routing. The harness captures a step's model selection
			// BEFORE `agent/pre-step` runs, so a route decided during the step can
			// only take effect one step later. The composer's send path therefore
			// holds its submission for one classification round trip: this route
			// classifies the prompt the user is about to send, records the selection
			// on the live agent (never on the profile default), and returns the
			// route — so the FIRST step of the turn already runs on it.
			const routeNow = webServer.register({
				kind: 'exact',
				path: '/api/dual-model-router/route',
				handler: async (req, res) => {
					// this endpoint pins a live session's model: the owner only
					if (rejectionOf(req, res, { owner: true })) return;
					if (req.method !== 'POST') {
						json(res, 405, { ok: false, error: 'POST required' });
						return;
					}
					// The composer aborts this fetch once its wait bound passes. The
					// classification must stop with the client: a verdict that lands
					// afterwards belongs to a prompt whose send already went out, and
					// could override the route of a later one.
					const gone = new AbortController();
					if (typeof res.on === 'function') {
						res.on('close', () => {
							if (res.writableEnded !== true) gone.abort();
						});
					}
					try {
						const body = JSON.parse(await readBody(req));
						const sessionId = String(body?.sessionId ?? '');
						const text = String(body?.text ?? '');
						if (sessionId.length === 0) throw new Error('sessionId is required');
						const agent = ctx.get?.('agents')?.get?.(sessionId);
						// this conversation's own switch decides, not the profile default
						if (!enabledFor(sessionId) || !isConfigured(config.aux)) {
							json(res, 200, { ok: true, applied: false, kind: 'off' });
							return;
						}
						if (agent === undefined) {
							// a cold Session has no live Agent to select on: the prompt proceeds
							// and the pre-step fallback routes the next step instead
							json(res, 200, { ok: true, applied: false, kind: 'idle' });
							return;
						}
						const state = stateOf(agent);
						let verdict;
						if (!isSubagent(agent) && text.trim().length > 0) {
							verdict = await classifyAgentTask(agent, state, text, gone.signal);
						}
						// the client is gone: leave the route to the pre-step fallback
						// instead of recording a decision nobody is waiting for
						if (gone.signal.aborted) return;
						const applied = applyRoute(agent, state);
						const didApply = applied.kind === 'auto' || applied.kind === 'subagent';
						json(res, 200, { ok: true, ...applied, applied: didApply, verdict: verdict ?? null });
					} catch (error) {
						json(res, 400, { ok: false, error: String(error?.message ?? error) });
					}
				},
			});

			const debugClassify = webServer.register({
				kind: 'exact',
				path: '/api/dual-model-router/debug-classify',
				handler: async (req, res) => {
					// each call is a live auxiliary-model round trip: the owner only
					if (rejectionOf(req, res, { owner: true })) return;
					if (req.method !== 'POST') {
						json(res, 405, { ok: false, error: 'POST required' });
						return;
					}
					try {
						const body = JSON.parse(await readBody(req));
						const text = String(body?.text ?? '');
						const sessionId = String(body?.sessionId ?? '');
						if (text.trim().length === 0) {
							json(res, 400, { ok: false, error: 'text is required' });
							return;
						}
						// mirror the live decision pipeline: keyword override first
						const keyword = keywordHit(text, config.complexKeywords);
						if (keyword !== undefined) {
							json(res, 200, { ok: true, mode: 'complex', source: 'keyword', raw: `keyword match: ${keyword}`, history: 0 });
							return;
						}
						// with a live session, judge the message exactly as a real send
						// would: recent conversation plus the session's current mode
						const agent = sessionId.length > 0 ? ctx.get?.('agents')?.get?.(sessionId) : undefined;
						const history = agent !== undefined ? conversationHistory(agent, text) : [];
						const currentMode = agent !== undefined ? states.get(agent.id)?.mode : undefined;
						const verdict = await classifyTaskText(ctx.llm, config, text, { history, currentMode });
						// mirror the live failure policy: a failed attempt keeps the
						// session's current mode instead of downgrading it
						const mode = verdict.failed === true && currentMode === 'complex' ? 'complex' : verdict.mode;
						json(res, 200, {
							ok: true,
							mode,
							source: verdict.failed === true ? 'failed' : 'llm',
							raw: verdict.raw.slice(0, 400),
							history: history.length,
						});
					} catch (error) {
						json(res, 400, { ok: false, error: String(error?.message ?? error) });
					}
				},
			});

			return () => {
				getRoute();
				postRoute();
				toggleRoute();
				statusRoute();
				routeNow();
				debugClassify();
				// An open SSE response keeps its handler alive after the route is
				// unregistered, so a reload would leave the browser's EventSource
				// attached to the dead apply — heartbeating forever into a pill that
				// never updates. Close them so the client reconnects to the new apply.
				for (const subscriber of [...statusSubscribers]) {
					subscriber.close();
				}
				statusSubscribers.clear();
				for (const heartbeat of [...statusHeartbeats]) {
					clearInterval(heartbeat);
				}
				statusHeartbeats.clear();
				status.clear();
			};
		}, 'dsh-dual-model-router: settings endpoints');
	}, 'dsh-dual-model-router: settings endpoint fiber');
}

export { apply };
