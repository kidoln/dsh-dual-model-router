// Regression tests for dsh-dual-model-router/index.js — the hook-orchestration
// half. These cover the defects verified against DSH:
//   1. the four /api routes were reachable without authentication
//      (exact routes shadow the /api auth prefix);
//   2. agent-scoped listeners/sections registered on agent.ctx belong to the
//      AGENT fiber, so a plugin reload (every Settings save) left stale hooks
//      behind: routing kept using the old config and planner guidance died;
//   3. the route is applied with `agent.model.select()` (the harness's own
//      durable selection) — `agent/request` rejects a rewritten provider/model
//      once the loop has fixed the step's selection, so the router must never
//      listen to that waterfall;
//   4. the /api routes live in a child fiber that waits for `webServer`, which
//      is a service that activates after this plugin applies and is absent in
//      headless profiles.
// The fake harness models the cordis semantics the plugin relies on:
// waterfall = outermost-first with a shifting `next`, `prepend` unshifts,
// agent-scoped hooks rank outside root-scoped ones, and a duplicate
// systemPrompt section name in the same layer throws.

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';
import { isHumanPrompt } from '../lib/routing.js';

const CONFIG = {
	enabled: true,
	primary: { provider: 'strong-p', model: 'strong-m', reasoningEffort: '' },
	aux: { provider: 'fast-p', model: 'fast-m', reasoningEffort: '' },
	classifierTimeoutMs: 5000,
	plannerGuidance: true,
	complexKeywords: ['hard'],
};

/** Models one cordis scope tree: root hooks + per-agent hooks/sections. */
class Harness {
	constructor() {
		this.rootHooks = [];
		this.agentHooks = new Map();
		this.sections = new Map();
		this.pluginDisposers = [];
		this.llmCalls = [];
	}

	rootOn(name, callback) {
		const record = { name, callback };
		this.rootHooks.push(record);
		return () => {
			const at = this.rootHooks.indexOf(record);
			if (at >= 0) this.rootHooks.splice(at, 1);
		};
	}

	agent(agent) {
		// The plugin's routing state is module-scoped (a Settings reload must not
		// lose the route it wrote), so each test's agents need unique ids, like the
		// uuids a real harness hands out.
		agent.id = `t${++agentSeq}-${agent.id}`;
		const hooks = this.agentHooks;
		const sections = this.sections;
		// the session's recorded model selection, exactly what the real
		// `agent.model.current()` reads: the profile default until something
		// (a manual pick or this router) records another one.
		let selection = agent.selection ?? { ...defaultBaseline };
		agent.model = {
			selects: [],
			current: () => ({ ...selection }),
			/** Simulate a pick the host recorded WITHOUT a router select(). */
			set(next) {
				selection = { ...next };
			},
			select(next) {
				if (next.reasoningEffort === undefined) delete selection.reasoningEffort;
				selection = {
					provider: next.provider,
					model: next.model,
					...(next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort }),
				};
				agent.model.selects.push({ ...selection });
			},
		};
		agent.ctx = {
			on(name, callback, options) {
				const record = { name, callback, prepend: options?.prepend === true };
				if (!hooks.has(agent.id)) hooks.set(agent.id, []);
				hooks.get(agent.id).push(record);
				return () => {
					const list = hooks.get(agent.id) ?? [];
					const at = list.indexOf(record);
					if (at >= 0) list.splice(at, 1);
				};
			},
			systemPrompt: {
				section(spec) {
					const list = sections.get(agent.id) ?? [];
					// real behaviour: duplicate name in the same layer throws
					if (list.some((entry) => entry.spec.name === spec.name)) {
						throw new Error(`duplicate section name: ${spec.name}`);
					}
					const record = { spec };
					list.push(record);
					sections.set(agent.id, list);
					return () => {
						const current = sections.get(agent.id) ?? [];
						const at = current.indexOf(record);
						if (at >= 0) current.splice(at, 1);
					};
				},
			},
		};
		return agent;
	}

	ctx(overrides = {}) {
		const harness = this;
		const serviceOf = overrides.get ?? (() => undefined);
		const ctx = {
			llm: overrides.llm ?? this.llm(),
			agentDefaultModel: overrides.agentDefaultModel ?? {
				currentSelection: () => ({ provider: 'default-p', model: 'default-m' }),
			},
			systemPrompt: {},
			get: serviceOf,
			effect(callback) {
				const disposer = callback();
				if (typeof disposer === 'function') harness.pluginDisposers.push(disposer);
				return () => {};
			},
			on: (name, callback) => harness.rootOn(name, callback),
		};
		// cordis runs the callback in a child fiber that waits until every
		// dependency is provided, and the scope exposes them as properties.
		ctx.inject = (deps, callback) => {
			const names = Array.isArray(deps) ? deps : [deps];
			if (names.some((name) => serviceOf(name) === undefined)) return { dispose() {} };
			const scope = { ...ctx, ...Object.fromEntries(names.map((name) => [name, serviceOf(name)])) };
			const disposer = callback(scope);
			if (typeof disposer === 'function') harness.pluginDisposers.push(disposer);
			return { dispose() {} };
		};
		return ctx;
	}

	llm() {
		const harness = this;
		return {
			async resolveModelInfo() {
				return { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } };
			},
			stream(options) {
				harness.llmCalls.push(options);
				const verdict = harness.nextVerdict ?? '{"difficulty":"complex"}';
				return (async function* emit() {
					yield { type: 'text-delta', index: 0, text: verdict };
					yield { type: 'finish', reason: { kind: 'stop' } };
				})();
			},
		};
	}

	/** Full teardown of one apply: exactly what a cordis fiber restart does. */
	disposeApply() {
		for (const disposer of [...this.pluginDisposers].reverse()) disposer();
		this.pluginDisposers.length = 0;
	}

	/** The systemPrompt sections the plugin registered on one agent's fiber. */
	section(agent) {
		return this.sections.get(agent.id) ?? [];
	}

	/** The agent-scoped hooks the plugin registered on one agent's fiber. */
	hooks(agent) {
		return this.agentHooks.get(agent.id) ?? [];
	}

	// ---- dispatch (cordis waterfall: outermost-first, shifting next) ----
	hooksFor(name, agent) {
		const scoped = this.agentHooks.get(agent?.id) ?? [];
		return [
			...scoped.filter((hook) => hook.name === name && hook.prepend),
			...this.rootHooks.filter((hook) => hook.name === name),
			...scoped.filter((hook) => hook.name === name && !hook.prepend),
		];
	}

	async preStep(agent, messages, options = {}) {
		const hooks = this.hooksFor('agent/pre-step', agent).map((hook) => hook.callback);
		let at = 0;
		const next = async () => {
			const hook = hooks[at++];
			if (hook === undefined) return options.inner === undefined ? undefined : options.inner();
			return hook({ agent, messages, signal: options.signal }, next);
		};
		return next();
	}

	async request(agent, baseline, inner = async () => baseline) {
		const hooks = this.hooksFor('agent/request', agent).map((hook) => hook.callback);
		if (hooks.length === 0) return baseline;
		let at = 0;
		const next = async () => {
			const hook = hooks[at++];
			return hook === undefined ? inner() : hook({ agent }, next);
		};
		return next();
	}

	/** The routes the router has written through agent.model.select(). */
	routes(agent) {
		return agent.model.selects.map((route) => [route.provider, route.model]);
	}

	emitDisposed(agent) {
		for (const hook of this.rootHooks.filter((entry) => entry.name === 'agent/disposed')) {
			hook.callback({ agent });
		}
	}
}

const userMessage = (id, text) => ({
	id,
	role: 'user',
	source: { kind: 'user', rpcId: `rpc-${id}` },
	content: [{ type: 'text', text }],
});
/** A machine-produced user-role message (goal round, schedule, subagent report…). */
const machineMessage = (id, text, source) => ({
	id,
	role: 'user',
	source,
	content: [{ type: 'text', text }],
});
const defaultBaseline = { provider: 'default-p', model: 'default-m' };
/** Unique-session-id counter; see Harness#agent. */
let agentSeq = 0;

test('root tasks route to aux when simple and to primary when complex', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });

	await harness.preStep(agent, [userMessage('m1', 'refactor the whole thing')]);
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']]);
	assert.deepEqual(agent.model.current(), { provider: 'strong-p', model: 'strong-m' });

	const agent2 = harness.agent({ id: 'a2', session: { header: {} } });
	harness.nextVerdict = '{"difficulty":"simple"}';
	await harness.preStep(agent2, [userMessage('m2', 'rename this function')]);
	assert.deepEqual(harness.routes(agent2), [['fast-p', 'fast-m']]);
	assert.deepEqual(agent2.model.current(), { provider: 'fast-p', model: 'fast-m' });
});

test('the router never rewrites the agent/request waterfall', async () => {
	const harness = new Harness();
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	// the loop fixes the step's provider/model and rejects a divergent waterfall
	// result, so a listener here would break every request
	assert.equal(harness.hooksFor('agent/request', agent).length, 0);
	assert.deepEqual(await harness.request(agent, defaultBaseline), defaultBaseline);
});

test('an already-current route records nothing new', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"simple"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} }, selection: { provider: 'fast-p', model: 'fast-m' } });
	await harness.preStep(agent, [userMessage('m1', 'rename this')]);
	assert.deepEqual(harness.routes(agent), [], 'the aux route is already recorded');

	// a continuation step must not re-select either
	await harness.preStep(agent, []);
	assert.deepEqual(harness.routes(agent), []);
});

test('subagents always run on the auxiliary model', async () => {
	const harness = new Harness();
	apply(harness.ctx(), CONFIG);
	const sub = harness.agent({ id: 's1', session: { header: { origin: 'subagent' } } });
	await harness.preStep(sub, []);
	assert.deepEqual(harness.routes(sub), [['fast-p', 'fast-m']]);
});

test('a manual selection is never overridden', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} }, selection: { provider: 'manual-p', model: 'manual-m' } });
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	assert.deepEqual(harness.routes(agent), [], 'a manual pick must not be selected over');
	assert.deepEqual(agent.model.current(), { provider: 'manual-p', model: 'manual-m' });
});

test('a complex keyword short-circuits the classifier call', async () => {
	const harness = new Harness();
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'this is hard, do it')]);
	assert.equal(harness.llmCalls.length, 0, 'keyword hit must not call the model');
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']]);
});

test('planner guidance is served only to a complex root agent', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	const section = harness.section(agent)[0]?.spec;
	assert.ok(section, 'a section must be registered for the agent');
	assert.match(section.text(), /COMPLEX/);

	const sub = harness.agent({ id: 's1', session: { header: { origin: 'subagent' } } });
	await harness.preStep(sub, [userMessage('m1', 'deep work')]);
	const subSection = harness.section(sub)[0]?.spec;
	assert.equal(subSection.text(), '', 'subagents get no planner guidance');
});

test('continuation steps with no user message are not classified', async () => {
	const harness = new Harness();
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });

	// a tool-continuation step: nothing claimed
	await harness.preStep(agent, []);
	assert.equal(harness.llmCalls.length, 0);

	// a claimed batch whose newest message is a tool result
	await harness.preStep(agent, [
		{ id: 't1', role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
	]);
	assert.equal(harness.llmCalls.length, 0, 'tool output must not be classified');
});

test('teardown releases agent-scoped sections', async () => {
	const harness = new Harness();
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'x')]);

	assert.equal(harness.section(agent).length, 1, 'section registered');
	assert.equal(
		harness.hooks(agent).length,
		0,
		'the router must own no agent-scoped listeners at all',
	);

	harness.disposeApply();

	assert.equal(harness.section(agent).length, 0, 'section must not outlive the apply');
});

test('a reload re-registers cleanly with the new config for a live agent', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"simple"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	assert.deepEqual(harness.routes(agent), [['fast-p', 'fast-m']]);

	// every Settings save is a dispose + re-apply
	harness.disposeApply();
	const next = {
		...CONFIG,
		aux: { provider: 'fast2-p', model: 'fast2-m', reasoningEffort: '' },
	};
	apply(harness.ctx(), next);

	// the stale section must be gone, so this must not throw/hit the duplicate name
	harness.nextVerdict = '{"difficulty":"complex"}';
	await harness.preStep(agent, [userMessage('m2', 'more deep work')]);
	const section = harness.section(agent)[0]?.spec;
	assert.ok(section, 'the reloaded apply must own a fresh section');
	assert.match(section.text(), /fast2-p\/fast2-m/, 'guidance must use the new aux route');
	assert.deepEqual(harness.routes(agent), [['fast-p', 'fast-m'], ['strong-p', 'strong-m']]);

	// and a simple task must land on the NEW aux route, not the stale one
	harness.nextVerdict = '{"difficulty":"simple"}';
	await harness.preStep(agent, [userMessage('m3', 'rename this')]);
	assert.deepEqual(harness.routes(agent).at(-1), ['fast2-p', 'fast2-m']);
});

test('disabling the plugin stops routing for an already-live agent', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']]);

	harness.disposeApply();
	apply(harness.ctx(), { ...CONFIG, enabled: false });

	await harness.preStep(agent, [userMessage('m2', 'rename this')]);
	// disabled means the router writes nothing; the session keeps its selection
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']], 'disabled means untouched');
});

// ---------- settings endpoints / auth ----------

function fakeWebServer() {
	const routes = new Map();
	return {
		routes,
		register(route) {
			routes.set(`${route.kind}:${route.path}`, route);
			return () => routes.delete(`${route.kind}:${route.path}`);
		},
	};
}

function fakeRes() {
	return {
		status: undefined,
		headers: undefined,
		body: undefined,
		ended: false,
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
			return this;
		},
		end(body) {
			this.ended = true;
			this.body = body;
			return this;
		},
		write() {
			return true;
		},
	};
}

function fakeReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
	const listeners = new Map();
	const req = {
		method,
		url,
		headers,
		on(name, callback) {
			listeners.set(name, callback);
			return req;
		},
		destroy() {},
	};
	// deliver the body on the next tick, like a real socket would
	setTimeout(() => {
		if (body !== '') listeners.get('data')?.(Buffer.from(body));
		listeners.get('end')?.();
	}, 0);
	return req;
}

/** An apply whose webServer + connection services are controlled by the test. */
function endpointHarness({ connection, rowConfig, rowMissing = false, agents, config = CONFIG, llm } = {}) {
	const harness = new Harness();
	const webServer = fakeWebServer();
	const editor = {
		edited: 0,
		/** The row's raw config as the fake Loader holds it. */
		current: rowConfig === undefined ? {} : { ...rowConfig },
		entries: () => (rowMissing ? [] : [{ options: { id: 'dual-model-router' } }]),
		configuration() {
			if (rowMissing) return [];
			return [{ entry: { options: { id: 'dual-model-router' } }, inherited: {}, override: { ...this.current } }];
		},
		async edit(entry, change) {
			this.edited += 1;
			this.current = change(this.current);
			return this.current;
		},
	};
	const services = {
		webServer,
		configEditor: editor,
		...(agents === undefined ? {} : { agents }),
		...(connection === undefined
			? {}
			// Every test Peer speaks for the owner unless the test overrides
			// `admit`: the mutating routes require an owner Peer, not just a
			// valid credential.
			: { connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }), ...connection } }),
	};
	apply(harness.ctx({ get: (name) => services[name], ...(llm === undefined ? {} : { llm }) }), config);
	return { harness, webServer, editor };
}

const route = (webServer, path) => webServer.routes.get(`exact:${path}`);
const SETTINGS = '/api/dual-model-router/settings';
const SAVE = '/api/dual-model-router/settings/save';
const TOGGLE = '/api/dual-model-router/toggle';
const ROUTE_NOW = '/api/dual-model-router/route';

/** A registry whose `get(sessionId)` answers the live agents the test built. */
const registryOf = (agents) => ({ get: (sessionId) => agents.get(sessionId) });

/**
 * POST one prompt to the prompt-time route endpoint.
 * @returns the parsed response body.
 */
async function routeNow(webServer, body) {
	const res = fakeRes();
	await route(webServer, ROUTE_NOW).handler(
		fakeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
		res,
	);
	let parsed;
	try {
		parsed = res.body === undefined ? undefined : JSON.parse(res.body);
	} catch {
		// a refusal answers with plain text ('unauthorized'), not JSON
		parsed = undefined;
	}
	return { status: res.status, body: parsed };
}

test('settings and save routes are registered', () => {
	const { webServer } = endpointHarness({ connection: { requestRejection: () => undefined } });
	assert.ok(route(webServer, SETTINGS), 'GET settings route');
	assert.ok(route(webServer, SAVE), 'POST save route');
	assert.ok(route(webServer, TOGGLE), 'POST toggle route');
	assert.ok(route(webServer, ROUTE_NOW), 'prompt-time route');
	assert.ok(route(webServer, '/api/dual-model-router/debug-classify'), 'debug route');
});

test('an unauthenticated request is rejected before any work happens', async () => {
	const { webServer, editor } = endpointHarness({ connection: { requestRejection: () => 401 } });

	const getRes = fakeRes();
	await route(webServer, SETTINGS).handler(fakeReq(), getRes);
	assert.equal(getRes.status, 401);
	assert.equal(getRes.body, 'unauthorized');

	const saveRes = fakeRes();
	await route(webServer, SAVE).handler(
		fakeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' }),
		saveRes,
	);
	assert.equal(saveRes.status, 401, 'the config write must be gated');
	assert.equal(editor.edited, 0, 'no config edit may happen for an unauthenticated caller');
});

test('a forbidden (untrusted origin) request is rejected with 403', async () => {
	const { webServer } = endpointHarness({ connection: { requestRejection: () => 403 } });
	const res = fakeRes();
	await route(webServer, SAVE).handler(fakeReq({ method: 'POST', body: '{}' }), res);
	assert.equal(res.status, 403);
	assert.equal(res.body, 'forbidden');
});

test('the debug-classify LLM call is gated too', async () => {
	const { harness, webServer } = endpointHarness({ connection: { requestRejection: () => 401 } });
	const res = fakeRes();
	await route(webServer, '/api/dual-model-router/debug-classify').handler(
		fakeReq({ method: 'POST', body: '{"text":"anything"}' }),
		res,
	);
	assert.equal(res.status, 401);
	assert.equal(harness.llmCalls.length, 0, 'gated callers must not reach the model');
});

test('a missing auth service fails closed', async () => {
	const { webServer, editor } = endpointHarness({ connection: undefined });
	const res = fakeRes();
	await route(webServer, SAVE).handler(fakeReq({ method: 'POST', body: '{"enabled":true}' }), res);
	assert.ok(res.status >= 400, `expected a failure status, got ${res.status}`);
	assert.equal(editor.edited, 0);
});

test('an admitted request still works', async () => {
	const { webServer, editor } = endpointHarness({ connection: { requestRejection: () => undefined } });

	const getRes = fakeRes();
	await route(webServer, SETTINGS).handler(fakeReq(), getRes);
	assert.equal(getRes.status, 200);
	const payload = JSON.parse(getRes.body);
	assert.equal(payload.config.enabled, true);

	const saveRes = fakeRes();
	await route(webServer, SAVE).handler(
		fakeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' }),
		saveRes,
	);
	assert.equal(saveRes.status, 200, saveRes.body);
	assert.equal(editor.edited, 1);
});

// ---------- prompt-time routing endpoint ----------

/** One live agent registered under its own id, as the host registry holds it. */
function liveAgent(spec, config = CONFIG) {
	const agents = new Map();
	const { harness, webServer } = endpointHarness({
		connection: { requestRejection: () => undefined },
		agents: registryOf(agents),
		config,
	});
	const agent = harness.agent(spec);
	agents.set(agent.id, agent);
	return { harness, webServer, agent };
}

test('the prompt-time route endpoint selects the route before the send', async () => {
	const { harness, webServer, agent } = liveAgent({ id: 'a1', session: { header: {} } });
	harness.nextVerdict = '{"difficulty":"complex"}';
	const response = await routeNow(webServer, { sessionId: agent.id, text: '用 bash 统计文件数' });
	assert.equal(response.status, 200);
	assert.equal(response.body.ok, true);
	assert.equal(response.body.applied, true);
	assert.equal(response.body.kind, 'auto');
	assert.equal(response.body.mode, 'complex');
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']]);
	assert.equal(harness.llmCalls.length, 1, 'the prompt is classified exactly once');

	// the recorded route is the one the framework will capture for the step the
	// held send is about to start
	assert.deepEqual(agent.model.current(), { provider: 'strong-p', model: 'strong-m' });
});

test('the prompt-time route endpoint reads the session history', async () => {
	const history = [
		userMessage('h1', '帮我对整个项目做一个深度分析'),
		{
			id: 'h2',
			role: 'assistant',
			source: { kind: 'model', provider: 'p', model: 'm' },
			content: [{ type: 'text', text: '先梳理模块，再给出方案。' }],
		},
	];
	const { harness, webServer, agent } = liveAgent({
		id: 'a1',
		session: { header: {}, deriveMessages: () => history },
	});
	harness.nextVerdict = '{"difficulty":"complex"}';
	const response = await routeNow(webServer, { sessionId: agent.id, text: '继续' });
	assert.equal(response.status, 200);
	assert.equal(response.body.mode, 'complex');
	const prompt = harness.llmCalls.at(-1).messages.find((message) => message.role === 'user').content[0].text;
	assert.match(prompt, /User: 帮我对整个项目做一个深度分析/);
	assert.match(prompt, /Assistant: 先梳理模块，再给出方案。/);
	assert.match(prompt, /<current_mode>simple<\/current_mode>/, 'a new session starts simple');
	assert.match(prompt, /<current_message>\n继续\n<\/current_message>/);
});

test('the prompt-time route endpoint keeps the keyword shortcut', async () => {
	const { harness, webServer, agent } = liveAgent({ id: 'a1', session: { header: {} } });
	const response = await routeNow(webServer, { sessionId: agent.id, text: 'this is hard, do it' });
	assert.equal(response.body.mode, 'complex');
	assert.equal(response.body.verdict.source, 'keyword');
	assert.equal(harness.llmCalls.length, 0, 'a keyword hit must not call the model');
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']]);
});

test('the prompt-time route endpoint never overrides a manual pick', async () => {
	const { harness, webServer, agent } = liveAgent({
		id: 'a1',
		session: { header: {} },
		selection: { provider: 'manual-p', model: 'manual-m' },
	});
	const response = await routeNow(webServer, { sessionId: agent.id, text: 'deep work' });
	assert.equal(response.body.kind, 'manual');
	assert.deepEqual(harness.routes(agent), [], 'a manual pick must not be selected over');
});

test('the prompt-time route endpoint pins subagents to the auxiliary model', async () => {
	const { harness, webServer, agent } = liveAgent({ id: 's1', session: { header: { origin: 'subagent' } } });
	const response = await routeNow(webServer, { sessionId: agent.id, text: 'anything' });
	assert.equal(response.body.kind, 'subagent');
	assert.deepEqual(harness.routes(agent), [['fast-p', 'fast-m']]);
	assert.equal(harness.llmCalls.length, 0, 'subagents carry no classification');
});

test('the prompt-time route endpoint is inert for a cold session or a disabled router', async () => {
	const cold = await routeNow(endpointHarness({
		connection: { requestRejection: () => undefined },
		agents: registryOf(new Map()),
	}).webServer, { sessionId: 'nobody', text: 'hello' });
	assert.equal(cold.status, 200);
	assert.equal(cold.body.applied, false, 'a cold session has no live agent to select on');

	const { harness, webServer, agent } = liveAgent({ id: 'a1', session: { header: {} } }, { ...CONFIG, enabled: false });
	const disabled = await routeNow(webServer, { sessionId: agent.id, text: 'deep work' });
	assert.equal(disabled.body.applied, false);
	assert.equal(disabled.body.kind, 'off');
	assert.deepEqual(harness.routes(agent), [], 'a disabled router writes nothing');
	assert.equal(harness.llmCalls.length, 0, 'a disabled router never classifies');
});

test('the prompt-time route endpoint is gated and refuses non-POST', async () => {
	const gated = endpointHarness({
		connection: { requestRejection: () => 401 },
		agents: registryOf(new Map()),
	});
	const denied = await routeNow(gated.webServer, { sessionId: 's', text: 'hi' });
	assert.equal(denied.status, 401);
	assert.equal(gated.harness.llmCalls.length, 0, 'gated callers must not reach the model');

	const { webServer } = endpointHarness({
		connection: { requestRejection: () => undefined },
		agents: registryOf(new Map()),
	});
	const res = fakeRes();
	await route(webServer, ROUTE_NOW).handler(fakeReq({ method: 'GET' }), res);
	assert.equal(res.status, 405);
});

// ---------- toggle endpoint (composer pill + keyboard shortcut) ----------

const CONFIGURED_ROW = {
	enabled: false,
	primary: { provider: 'strong-p', model: 'strong-m' },
	aux: { provider: 'fast-p', model: 'fast-m' },
};

test('the toggle route flips the row and reports the new state', async () => {
	const { webServer, editor } = endpointHarness({
		connection: { requestRejection: () => undefined },
		rowConfig: CONFIGURED_ROW,
	});

	const on = fakeRes();
	await route(webServer, TOGGLE).handler(fakeReq({ method: 'POST', body: '{}' }), on);
	assert.equal(on.status, 200, on.body);
	assert.deepEqual(JSON.parse(on.body), { ok: true, enabled: true });
	assert.equal(editor.edited, 1);
	assert.equal(editor.current.enabled, true);
	assert.deepEqual(editor.current.primary, CONFIGURED_ROW.primary, 'the rest of the row survives');

	const off = fakeRes();
	await route(webServer, TOGGLE).handler(fakeReq({ method: 'POST', body: '{}' }), off);
	assert.deepEqual(JSON.parse(off.body), { ok: true, enabled: false });
	assert.equal(editor.current.enabled, false);
});

test('toggling on refuses a half-configured router', async () => {
	const { webServer, editor } = endpointHarness({
		connection: { requestRejection: () => undefined },
		rowConfig: { enabled: false, primary: { provider: 'strong-p', model: 'strong-m' } },
	});

	const res = fakeRes();
	await route(webServer, TOGGLE).handler(fakeReq({ method: 'POST', body: '{}' }), res);
	assert.equal(res.status, 409, res.body);
	assert.equal(JSON.parse(res.body).ok, false);
	assert.equal(editor.edited, 0, 'a refused toggle must not write the row');

	// turning it OFF is always allowed, even from a half-configured row
	const offHarness = endpointHarness({
		connection: { requestRejection: () => undefined },
		rowConfig: { enabled: true },
	});
	const off = fakeRes();
	await route(offHarness.webServer, TOGGLE).handler(fakeReq({ method: 'POST', body: '{}' }), off);
	assert.deepEqual(JSON.parse(off.body), { ok: true, enabled: false });
});

test('the toggle route is gated and refuses non-POST methods', async () => {
	const gated = endpointHarness({ connection: { requestRejection: () => 401 } });
	const denied = fakeRes();
	await route(gated.webServer, TOGGLE).handler(fakeReq({ method: 'POST', body: '{}' }), denied);
	assert.equal(denied.status, 401);
	assert.equal(gated.editor.edited, 0, 'no config write for an unauthenticated caller');

	const { webServer, editor } = endpointHarness({
		connection: { requestRejection: () => undefined },
		rowConfig: CONFIGURED_ROW,
	});
	const wrongMethod = fakeRes();
	await route(webServer, TOGGLE).handler(fakeReq({ method: 'GET' }), wrongMethod);
	assert.equal(wrongMethod.status, 405);
	assert.equal(editor.edited, 0);
});

test('the status snapshot carries the applied switch and the default selection', async () => {
	const { webServer } = endpointHarness({ connection: { requestRejection: () => undefined } });
	const res = fakeRes();
	await route(webServer, SETTINGS.replace('/settings', '/status')).handler(fakeReq(), res);
	const payload = JSON.parse(res.body);
	assert.equal(payload.type, 'init');
	assert.equal(payload.enabled, true);
	assert.deepEqual(payload.primary, CONFIG.primary);
	assert.deepEqual(payload.aux, CONFIG.aux);
	assert.deepEqual(payload.defaultSelection, { provider: 'default-p', model: 'default-m' });
	assert.equal(
		payload.classifierTimeoutMs,
		CONFIG.classifierTimeoutMs,
		'the composer holds a send for exactly the host classifier budget',
	);
});

// ---------- human vs machine user messages ----------

test('isHumanPrompt accepts only human authority', () => {
	// the browser/ACP/headless prompt shape
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'user', rpcId: 'r1' } }), true);
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'user' } }), true);
	// a message predating the source tag
	assert.equal(isHumanPrompt({ role: 'user' }), true);
	// DSH's machine producers
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'goal', goalId: 'g' } }), false);
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'schedule' } }), false);
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'runtime-context' } }), false);
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'agent-instructions' } }), false);
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'model-selection' } }), false);
	// a subagent relaying a message to its parent (createAgentMessage)
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'agent-message', form: 'relay', senderSessionId: 's' } }), false);
	// a caller that is not the owner (principal is tagged only for those)
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'user', principal: { id: 'other' } } }), false);
	// other roles are never human prompts
	assert.equal(isHumanPrompt({ role: 'tool', source: { kind: 'tool' } }), false);
	assert.equal(isHumanPrompt(undefined), false);
});

test('machine-generated user messages never re-decide the mode', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	assert.equal(harness.llmCalls.length, 1);

	// the classifier would say "simple" for every one of these; none may be asked
	harness.nextVerdict = '{"difficulty":"simple"}';
	await harness.preStep(agent, [machineMessage('g1', 'continue the goal', { kind: 'goal', goalId: 'g' })]);
	await harness.preStep(agent, [machineMessage('s1', 'reminder fired', { kind: 'schedule' })]);
	await harness.preStep(agent, [machineMessage('c1', 'context snapshot', { kind: 'runtime-context' })]);
	// the plugin's own recommended path: a subagent relays a result to its parent
	await harness.preStep(agent, [machineMessage('r1', 'done', { kind: 'agent-message', form: 'relay', senderSessionId: 'sub' })]);
	// a prompt submitted by a caller that is not the owner
	await harness.preStep(agent, [machineMessage('o1', 'another caller', { kind: 'user', rpcId: 'r', principal: { id: 'other' } })]);
	await harness.preStep(agent, [machineMessage('i1', 'instructions changed', { kind: 'agent-instructions' })]);

	assert.equal(harness.llmCalls.length, 1, 'only the human prompt may be classified');
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']], 'mode must stay complex');
	assert.match(harness.section(agent)[0].spec.text(), /COMPLEX/, 'planner guidance must survive');
});

test('a human prompt may still move a complex agent back to simple', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']]);

	harness.nextVerdict = '{"difficulty":"simple"}';
	await harness.preStep(agent, [userMessage('m2', 'thanks, now rename this variable')]);
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m'], ['fast-p', 'fast-m']]);
	assert.equal(harness.section(agent)[0].spec.text(), '', 'guidance stands down with the mode');
});

test('a follow-up is classified with recent conversation and the current mode', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const history = [
		userMessage('h1', '帮我对整个项目做一个深度分析'),
		machineMessage('g1', 'goal auto-continuation', { kind: 'goal', goalId: 'g' }),
		{
			id: 'h2',
			role: 'assistant',
			source: { kind: 'model', provider: 'p', model: 'm' },
			content: [{ type: 'text', text: '我会先梳理模块，再给出方案。' }],
		},
	];
	const agent = harness.agent({ id: 'a1', session: { header: {}, deriveMessages: () => history } });
	await harness.preStep(agent, [userMessage('m1', '重构数据库层')]);
	assert.deepEqual(agent.model.current(), { provider: 'strong-p', model: 'strong-m' });

	// the mocked verdict says simple; the point is what the classifier was shown
	harness.nextVerdict = '{"difficulty":"simple"}';
	await harness.preStep(agent, [userMessage('m2', '继续')]);
	const prompt = harness.llmCalls.at(-1).messages.find((message) => message.role === 'user').content[0].text;
	assert.match(prompt, /User: 帮我对整个项目做一个深度分析/);
	assert.match(prompt, /Assistant: 我会先梳理模块，再给出方案。/);
	assert.doesNotMatch(prompt, /goal auto-continuation/, 'machine messages are not conversation');
	assert.match(prompt, /<current_mode>complex<\/current_mode>/, 'the prior mode is offered for continuity');
	assert.match(prompt, /<current_message>\n继续\n<\/current_message>/);
});

test('a failed classification keeps an ongoing complex task on the primary route', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', '重构数据库层')]);
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']]);

	// the classifier times out or returns no text: keep the mode instead of
	// dropping the root agent to the cheap route mid-task
	harness.nextVerdict = '';
	await harness.preStep(agent, [userMessage('m2', '继续')]);
	assert.deepEqual(agent.model.current(), { provider: 'strong-p', model: 'strong-m' });
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']], 'a failure must not select aux');
	assert.match(harness.section(agent)[0].spec.text(), /COMPLEX/, 'planner guidance must survive');
});

test('a failed classification leaves a new session on the cheap route', async () => {
	const harness = new Harness();
	harness.nextVerdict = '';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'hello')]);
	assert.deepEqual(agent.model.current(), { provider: 'fast-p', model: 'fast-m' });
});

test('an attachment-only human prompt keeps the current mode', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);

	const imageOnly = {
		id: 'm2',
		role: 'user',
		source: { kind: 'user', rpcId: 'r2' },
		content: [{ type: 'image', image: 'x' }],
	};
	await harness.preStep(agent, [imageOnly]);

	assert.equal(harness.llmCalls.length, 1, 'no text means no classifier call');
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']], 'mode is preserved');
});

// ---------- SSE teardown ----------

test('teardown closes open SSE subscribers and clears their heartbeats', async () => {
	const intervals = new Set();
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	globalThis.setInterval = (callback, ms) => {
		const id = realSetInterval(callback, ms);
		intervals.add(id);
		return id;
	};
	globalThis.clearInterval = (id) => {
		intervals.delete(id);
		return realClearInterval(id);
	};
	try {
		const { harness, webServer } = endpointHarness({ connection: { requestRejection: () => undefined } });
		const res = fakeRes();
		const req = fakeReq({ headers: { accept: 'text/event-stream' } });
		await route(webServer, '/api/dual-model-router/status').handler(req, res);

		assert.equal(res.status, 200);
		assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
		assert.equal(intervals.size, 1, 'one heartbeat per open subscriber');
		assert.equal(res.ended, false);

		harness.disposeApply();

		assert.equal(res.ended, true, 'the response must be closed so the client reconnects');
		assert.equal(intervals.size, 0, 'the heartbeat must not outlive the apply');
	} finally {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
		for (const id of intervals) realClearInterval(id);
	}
});

// ---------- correctness regressions found in review ----------

test('one browser prompt is classified once across the route endpoint and the step', async () => {
	const { harness, webServer, agent } = liveAgent({ id: 'a1', session: { header: {} } });
	harness.nextVerdict = '{"difficulty":"complex"}';

	const response = await routeNow(webServer, { sessionId: agent.id, text: 'deep work' });
	assert.equal(response.body.kind, 'auto');
	assert.equal(harness.llmCalls.length, 1);

	// the held send is admitted and agent/pre-step claims the very same text
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	assert.equal(harness.llmCalls.length, 1, 'the prompt-time verdict must be reused, not bought twice');
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']]);
});

test('a rejected step is not classified and records no route', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	// a listener further down the waterfall rejects (an archived session, a gate)
	harness.rootOn('agent/pre-step', async () => ({ kind: 'reject' }));

	const decision = await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	assert.deepEqual(decision, { kind: 'reject' });
	assert.equal(harness.llmCalls.length, 0, 'a rejected step must not pay for a classification');
	assert.deepEqual(harness.routes(agent), [], 'a rejected step must not record a durable selection');
});

test('a turn cancelled during classification keeps the mode and records no route', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	const controller = new AbortController();
	controller.abort();

	await harness.preStep(agent, [userMessage('m1', 'deep work')], { signal: controller.signal });
	assert.deepEqual(harness.routes(agent), [], 'an aborted step must not record a selection');
	assert.equal(harness.llmCalls.length, 0, 'an aborted step must not reach the model');
});

test('a non-owner Peer cannot rewrite the profile or pin a session', async () => {
	const { harness, webServer } = endpointHarness({
		connection: {
			requestRejection: () => undefined,
			admit: () => ({ peer: { principal: { kind: 'user' } } }),
		},
	});
	const save = fakeRes();
	await route(webServer, SAVE).handler(fakeReq({ method: 'POST', body: '{"enabled":false}' }), save);
	assert.equal(save.status, 403, 'a profile write is owner-only');

	const toggle = fakeRes();
	await route(webServer, TOGGLE).handler(fakeReq({ method: 'POST' }), toggle);
	assert.equal(toggle.status, 403);

	const classify = fakeRes();
	await route(webServer, '/api/dual-model-router/debug-classify').handler(
		fakeReq({ method: 'POST', body: '{"text":"anything"}' }),
		classify,
	);
	assert.equal(classify.status, 403);
	assert.equal(harness.llmCalls.length, 0, 'a non-owner must not drive a model call');

	// reads stay open to any authenticated caller
	const settings = fakeRes();
	await route(webServer, SETTINGS).handler(fakeReq(), settings);
	assert.equal(settings.status, 200);
});

test('an owner Peer still writes', async () => {
	const { webServer, editor } = endpointHarness({
		connection: {
			requestRejection: () => undefined,
			admit: () => ({ peer: { principal: { kind: 'owner' } } }),
		},
	});
	const res = fakeRes();
	await route(webServer, SAVE).handler(fakeReq({ method: 'POST', body: '{"enabled":false}' }), res);
	assert.equal(res.status, 200, res.body);
	assert.equal(editor.edited, 1);
});

test('a manual pick stands the planner guidance down with the router', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const auto = harness.agent({ id: 'auto1', session: { header: {} } });
	await harness.preStep(auto, [userMessage('m1', 'deep work')]);
	const autoSection = harness.section(auto)[0];
	assert.ok(autoSection, 'an auto-routed root agent gets the guidance section');
	assert.notEqual(autoSection.spec.text(), '', 'a complex auto task gets planner guidance');

	const manual = harness.agent({
		id: 'manual1',
		session: { header: {} },
		selection: { provider: 'manual-p', model: 'manual-m' },
	});
	await harness.preStep(manual, [userMessage('m2', 'deep work')]);
	const manualSection = harness.section(manual)[0];
	assert.ok(manualSection);
	assert.equal(manualSection.spec.text(), '', 'a deferred session must not have its prompt rewritten');
});

test('a manual pick equal to a configured route wins once the router has routed', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"simple"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'rename this')]);
	assert.deepEqual(harness.routes(agent), [['fast-p', 'fast-m']]);

	// the user then picks exactly the configured primary model by hand, with no
	// select() call of ours to distinguish it
	agent.model.set({ provider: 'strong-p', model: 'strong-m' });
	await harness.preStep(agent, [userMessage('m2', 'and this too')]);
	assert.deepEqual(harness.routes(agent), [['fast-p', 'fast-m']], 'a manual pick must not be selected over');
	assert.deepEqual(agent.model.current(), { provider: 'strong-p', model: 'strong-m' });
});

test('a route this router wrote survives a reload (own-route recovery)', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	// a fresh apply has no lastRoute; the session still carries the aux route
	// the router itself wrote before the reload
	const agent = harness.agent({
		id: 'a1',
		session: { header: {} },
		selection: { provider: 'fast-p', model: 'fast-m' },
	});
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	assert.deepEqual(harness.routes(agent), [['strong-p', 'strong-m']], 'the recovered route is the router\'s own');
});

test('the route endpoint reports applied:false when it changed nothing', async () => {
	const { webServer, agent } = liveAgent({
		id: 'a1',
		session: { header: {} },
		selection: { provider: 'manual-p', model: 'manual-m' },
	});
	const response = await routeNow(webServer, { sessionId: agent.id, text: 'deep work' });
	assert.equal(response.body.kind, 'manual');
	assert.equal(response.body.applied, false, 'a refusal is not an application');
});

test('enabling refuses a route whose model does not resolve', async () => {
	const { webServer, editor } = endpointHarness({
		connection: { requestRejection: () => undefined },
		rowConfig: { enabled: false, primary: { provider: 'strong-p', model: 'strong-m' }, aux: { provider: 'fast-p', model: 'fast-m' } },
		llm: {
			listProviders: () => [],
			async resolveModelInfo(_provider, model) {
				if (model === 'strong-m') throw new Error('unknown model');
				return { reasoning: { efforts: [] } };
			},
			stream() {
				throw new Error('unused');
			},
		},
	});
	const res = fakeRes();
	await route(webServer, TOGGLE).handler(fakeReq({ method: 'POST' }), res);
	assert.equal(res.status, 409, res.body);
	assert.match(res.body, /unknown model/);
	assert.equal(editor.edited, 0, 'a broken route must not be enabled');
});

test('the settings route refuses a method that is not a read', async () => {
	const { webServer } = endpointHarness({ connection: { requestRejection: () => undefined } });
	const res = fakeRes();
	await route(webServer, SETTINGS).handler(fakeReq({ method: 'POST' }), res);
	assert.equal(res.status, 405);
});

test('debug-classify runs the real pipeline for an owner', async () => {
	const harness = new Harness();
	const webServer = fakeWebServer();
	const services = {
		webServer,
		connection: { requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
	};
	apply(harness.ctx({ get: (name) => services[name] }), CONFIG);

	const keyword = fakeRes();
	await route(webServer, '/api/dual-model-router/debug-classify').handler(
		fakeReq({ method: 'POST', body: '{"text":"this is hard"}' }),
		keyword,
	);
	assert.equal(keyword.status, 200);
	const keywordBody = JSON.parse(keyword.body);
	assert.equal(keywordBody.source, 'keyword');
	assert.equal(keywordBody.mode, 'complex');
	assert.equal(harness.llmCalls.length, 0);

	harness.nextVerdict = '{"difficulty":"simple"}';
	const llm = fakeRes();
	await route(webServer, '/api/dual-model-router/debug-classify').handler(
		fakeReq({ method: 'POST', body: '{"text":"rename it"}' }),
		llm,
	);
	assert.equal(llm.status, 200);
	assert.equal(JSON.parse(llm.body).source, 'llm');
	assert.equal(harness.llmCalls.length, 1);

	const empty = fakeRes();
	await route(webServer, '/api/dual-model-router/debug-classify').handler(
		fakeReq({ method: 'POST', body: '{"text":"  "}' }),
		empty,
	);
	assert.equal(empty.status, 400);
});

test('debug-classify reads a live session history and mode', async () => {
	const agents = new Map();
	const { harness, webServer } = endpointHarness({
		connection: { requestRejection: () => undefined },
		agents: registryOf(agents),
	});
	const history = [
		userMessage('h1', '分析整个项目'),
		{
			id: 'h2',
			role: 'assistant',
			source: { kind: 'model', provider: 'p', model: 'm' },
			content: [{ type: 'text', text: '先梳理模块，再执行。' }],
		},
	];
	const agent = harness.agent({ id: 'a1', session: { header: {}, deriveMessages: () => history } });
	agents.set(agent.id, agent);

	// make the session complex first, so the diagnostic sees that mode
	harness.nextVerdict = '{"difficulty":"complex"}';
	await harness.preStep(agent, [userMessage('m1', '深度分析')]);

	harness.nextVerdict = '{"difficulty":"simple"}';
	const res = fakeRes();
	await route(webServer, '/api/dual-model-router/debug-classify').handler(
		fakeReq({ method: 'POST', body: JSON.stringify({ text: '继续', sessionId: agent.id }) }),
		res,
	);
	assert.equal(res.status, 200, res.body);
	const body = JSON.parse(res.body);
	assert.equal(body.history, 2);
	const prompt = harness.llmCalls.at(-1).messages.find((message) => message.role === 'user').content[0].text;
	assert.match(prompt, /User: 分析整个项目/);
	assert.match(prompt, /<current_mode>complex<\/current_mode>/);
	assert.match(prompt, /<current_message>\n继续\n<\/current_message>/);

	// a failed diagnostic mirrors the live policy: keep the session's mode
	harness.nextVerdict = '';
	const failed = fakeRes();
	await route(webServer, '/api/dual-model-router/debug-classify').handler(
		fakeReq({ method: 'POST', body: JSON.stringify({ text: '继续', sessionId: agent.id }) }),
		failed,
	);
	const failedBody = JSON.parse(failed.body);
	assert.equal(failedBody.source, 'failed');
	assert.equal(failedBody.mode, 'complex');
});

test('agent/disposed releases the section and forgets the session', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"complex"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'deep work')]);
	assert.equal(harness.section(agent).length, 1);

	harness.emitDisposed(agent);
	assert.equal(harness.section(agent).length, 0, 'the agent-scoped section must be released');

	// the same session id starts over: a stale mode must not survive disposal
	const reused = harness.agent({ id: 'a1', session: { header: {} } });
	harness.nextVerdict = '{"difficulty":"simple"}';
	await harness.preStep(reused, [userMessage('m2', 'rename it')]);
	assert.deepEqual(harness.routes(reused), [['fast-p', 'fast-m']], 'a disposed session must not keep its old route memory');
});

test('a config change re-judges a text classified under the old rules', async () => {
	const harness = new Harness();
	harness.nextVerdict = '{"difficulty":"simple"}';
	apply(harness.ctx(), CONFIG);
	const agent = harness.agent({ id: 'a1', session: { header: {} } });
	await harness.preStep(agent, [userMessage('m1', 'tidy up the repo')]);
	assert.deepEqual(harness.routes(agent), [['fast-p', 'fast-m']]);
	assert.equal(harness.llmCalls.length, 1);

	// the user edits the keyword list; the very same text is sent again
	harness.disposeApply();
	apply(harness.ctx(), { ...CONFIG, complexKeywords: ['repo'] });
	await harness.preStep(agent, [userMessage('m2', 'tidy up the repo')]);
	assert.deepEqual(harness.routes(agent), [['fast-p', 'fast-m'], ['strong-p', 'strong-m']]);
	assert.equal(harness.llmCalls.length, 1, 'the keyword path costs no model call');
});
