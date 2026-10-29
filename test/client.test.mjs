// Wiring tests for dsh-dual-model-router/client.js — the browser half. The
// module is evaluated with a stub loader and driven through a stub client
// context: no React renderer and no DOM are involved, so these tests cover the
// registrations (which slots, which options) and the switch that installs and
// removes the model-seat takeover.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** Evaluate the loader-wrapped bundle and return its plugin exports. */
function loadClient({ react: reactOverride } = {}) {
	const loaded = [];
	const fakeWindow = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } };
	// eslint-disable-next-line no-new-func -- the bundle is a classic script
	new Function('window', SOURCE)(fakeWindow);
	assert.equal(loaded.length, 1, 'the bundle registers exactly one factory');
	const react = reactOverride ?? {
		// never reached: these tests do not render
		createElement: () => { throw new Error('unexpected render'); },
		useState: () => { throw new Error('unexpected render'); },
		useEffect: () => { throw new Error('unexpected render'); },
		useMemo: () => { throw new Error('unexpected render'); },
		useRef: () => { throw new Error('unexpected render'); },
		useSyncExternalStore: () => { throw new Error('unexpected render'); },
	};
	const exports = loaded[0].factory((id) => {
		if (id === 'react') return react;
		throw new Error(`unexpected module request: ${id}`);
	});
	assert.equal(exports.name, 'dsh-dual-model-router');
	assert.deepEqual(exports.inject, ['slots'], 'the client half must declare the slots service: the context proxy refuses an undeclared `ctx.slots` read ("cannot get property \"slots\" without inject") and the fiber fails to activate');
	return exports;
}

/**
 * A miniature hooks runtime: just enough to invoke one slot component in a
 * render pass and inspect the element tree it returns. Hook slots are stored by
 * call order, which is stable for these components across renders.
 */
function hookRuntime() {
	// the copy helpers sniff document.documentElement.lang / navigator.language
	if (globalThis.document === undefined) globalThis.document = { documentElement: { lang: 'en' } };
	const state = [];
	let index = 0;
	const react = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		useState(initial) {
			const at = index++;
			if (!(at in state)) state[at] = typeof initial === 'function' ? initial() : initial;
			return [state[at], (next) => { state[at] = typeof next === 'function' ? next(state[at]) : next; }];
		},
		useRef(initial) {
			const at = index++;
			if (!(at in state)) state[at] = { current: initial };
			return state[at];
		},
		useMemo(factory) {
			index += 1;
			return factory();
		},
		useCallback(callback) {
			index += 1;
			return callback;
		},
		useEffect(effect) {
			index += 1;
			effect();
		},
		useSyncExternalStore(subscribe, getSnapshot) {
			index += 1;
			subscribe(() => {});
			return getSnapshot();
		},
	};
	return {
		react,
		/** Run one render pass and return its element tree. */
		render(component, props) {
			index = 0;
			return component(props);
		},
	};
}

/** Every text node in an element tree, flattened. */
function textOf(node) {
	if (node === null || node === undefined || typeof node === 'string') return [node].filter(Boolean);
	if (Array.isArray(node)) return node.flatMap(textOf);
	return textOf(node.children);
}

/**
 * Minimal client context: effects run immediately, declarations are live.
 * `watchFires: false` models a slot whose declaration notification never
 * reaches this plugin, and `declared: []` hides the slot entirely.
 */
function fakeContext({ modelDirectories, conversation, watchFires = true, proxyServices = false, declared = ['conversation.input.right', 'conversation.composer.dock', 'conversation.input.model', 'settings.section'] } = {}) {
	const registrations = [];
	const commands = [];
	const catalog = [];
	const catalogListeners = new Set();
	const held = [];

	const shortcuts = {
		register(command) {
			commands.push(command);
			catalog.push({ id: command.id, keys: ['⌥', '⌘', 'M'] });
			for (const listener of [...catalogListeners]) listener();
			return () => {
				const at = commands.indexOf(command);
				if (at >= 0) commands.splice(at, 1);
				catalog.length = 0;
			};
		},
		catalog: {
			subscribe(listener) {
				catalogListeners.add(listener);
				return () => catalogListeners.delete(listener);
			},
			getSnapshot: () => catalog.slice(),
		},
	};

	const slots = {
		inject(key, callback) {
			// a live declaration runs its effect synchronously, like the runtime
			if (!watchFires) return () => {};
			held.push(callback());
			return () => {};
		},
		spec(key) {
			return declared.includes(key) ? { kind: 'single', scope: 'session' } : undefined;
		},
		register(options, component) {
			// mirror the core: a single slot refuses a second entry at the same
			// priority, and the SHIPPED model selector already holds priority 0
			if (options.name === 'conversation.input.model') {
				const shipped = SHIPPED_SINGLE_PRIORITY.get(options.name);
				const taken = shipped === (options.priority ?? 0)
					|| registrations.some((entry) => entry.options.name === options.name && (entry.options.priority ?? 0) === (options.priority ?? 0));
				if (taken) throw new Error(`single slot "${options.name}" already has a registration at priority ${options.priority ?? 0}`);
			}
			const record = { options, component };
			registrations.push(record);
			return () => {
				const at = registrations.indexOf(record);
				if (at >= 0) registrations.splice(at, 1);
			};
		},
	};

	const services = { shortcuts, ...(modelDirectories === undefined ? {} : { modelDirectories }), ...(conversation === undefined ? {} : { conversation }) };
	// cordis hands service reads back through a tracker proxy: with this on,
	// every read is a NEW Proxy over the same target, exactly like the host.
	const readService = (name) => {
		const value = services[name];
		return proxyServices && value !== undefined ? new Proxy(value, {}) : value;
	};
	const ctx = {
		slots,
		get: (name) => readService(name),
		effect(callback) {
			const dispose = callback();
			if (typeof dispose === 'function') held.push(dispose);
			return () => {};
		},
		inject(deps, callback) {
			// every dependency this harness offers is loaded
			const names = Array.isArray(deps) ? deps : [deps];
			const loaded = Object.fromEntries(names.map((name) => [name, readService(name)]));
			const scope = { ...ctx, ...loaded };
			const dispose = callback(scope);
			if (typeof dispose === 'function') held.push(dispose);
			return () => {};
		},
	};
	const dispose = () => {
		for (const disposer of [...held].reverse()) disposer();
		held.length = 0;
	};
	return { ctx, registrations, commands, catalog, dispose, services, conversation };
}

/** Let the module's fetch round-trips settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function withFetch(handler, run) {
	const real = globalThis.fetch;
	globalThis.fetch = async (url, options) => handler(String(url), options);
	return Promise.resolve()
		.then(run)
		.finally(() => { globalThis.fetch = real; });
}

const optionsOf = (registrations, name) => registrations.filter((entry) => entry.options.name === name);

/** Priority the shipped UI already holds on a single slot (see FakeContext.register). */
const SHIPPED_SINGLE_PRIORITY = new Map([['conversation.input.model', 0]]);

test('the client half registers every surface it owns', async () => {
	const client = loadClient();
	const harness = fakeContext();
	await withFetch(() => ({ ok: true, json: async () => ({ enabled: true }) }), async () => {
		client.apply(harness.ctx);
		await settle();
	});

	assert.equal(optionsOf(harness.registrations, 'conversation.input.right').length, 1, 'composer switch');
	assert.equal(optionsOf(harness.registrations, 'conversation.composer.dock').length, 1, 'routing detail');
	assert.equal(optionsOf(harness.registrations, 'settings.section').length, 1, 'settings page');
	assert.equal(optionsOf(harness.registrations, 'conversation.input.model').length, 1, 'model seat, because the router is on');

	const [command] = harness.commands;
	assert.equal(command.id, 'dual-model-router.toggle');
	assert.deepEqual(command.regions, ['page', 'editable']);
	assert.deepEqual(command.modals, []);
	assert.match(command.defaults['web:macos'].code, /^Key[A-Z]$/);
	assert.ok(!('web:linux' in command.defaults), 'web:linux has no legal default (see README)');
	assert.equal(command.resolve({}).status, 'handled');
});

test('the model seat is only taken over while the router is on', async () => {
	const client = loadClient();

	// switch ON: the seat entry is installed once the state is known
	const onHarness = fakeContext();
	await withFetch((url) => {
		if (url.includes('/toggle')) return { ok: true, status: 200, json: async () => ({ ok: true, enabled: false }) };
		return { ok: true, json: async () => ({ enabled: true }) };
	}, async () => {
		client.apply(onHarness.ctx);
		await settle();
	});
	assert.equal(optionsOf(onHarness.registrations, 'conversation.input.model').length, 1, 'seat taken over');
	assert.ok(
		optionsOf(onHarness.registrations, 'conversation.input.model')[0].options.priority < 0,
		'the seat registers below the shipped selector (priority 0) to shadow it',
	);

	// the shortcut flips it off and the seat is released again
	const [command] = onHarness.commands;
	await withFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, enabled: false }) }), async () => {
		command.resolve({ region: 'editable', modal: null }).run();
		await settle();
	});
	assert.equal(optionsOf(onHarness.registrations, 'conversation.input.model').length, 0, 'shipped selector restored');

	// switch OFF at boot: the shipped selector is never shadowed
	const offHarness = fakeContext();
	await withFetch(() => ({ ok: true, json: async () => ({ enabled: false }) }), async () => {
		client.apply(offHarness.ctx);
		await settle();
	});
	assert.equal(optionsOf(offHarness.registrations, 'conversation.input.model').length, 0);
});

test('the seat is still installed when the declaration watch never fires', async () => {
	const client = loadClient();
	// the slot exists, but this plugin's `slots.inject` callback never runs
	const harness = fakeContext({ watchFires: false });
	await withFetch(() => ({ ok: true, json: async () => ({ enabled: true }) }), async () => {
		client.apply(harness.ctx);
		await settle();
	});
	assert.equal(optionsOf(harness.registrations, 'conversation.input.model').length, 1, 'taken over through the live-spec check');
	assert.equal(
		harness.registrations.filter((entry) => String(entry.options.id ?? '').startsWith('dual-model-router-seat-probe')).length,
		0,
		'no anomaly sentinel once the takeover is in place',
	);
	harness.dispose();
});

test('an unreachable seat reports the anomaly through an invisible sentinel', async () => {
	const client = loadClient();
	const harness = fakeContext({ watchFires: false, declared: [] });
	await withFetch(() => ({ ok: true, json: async () => ({ enabled: true }) }), async () => {
		client.apply(harness.ctx);
		await settle();
	});
	const probes = harness.registrations.filter((entry) => String(entry.options.id ?? '').startsWith('dual-model-router-seat-probe'));
	assert.equal(probes.length, 1, 'exactly one sentinel entry');
	assert.match(probes[0].options.id, /waiting live=0/, 'the sentinel id carries the state');
	assert.equal(probes[0].options.name, 'conversation.composer.dock', 'it rides the dock slot');
	harness.dispose();
	assert.equal(
		harness.registrations.filter((entry) => String(entry.options.id ?? '').startsWith('dual-model-router-seat-probe')).length,
		0,
		'plugin unload drops the sentinel and the retry timer',
	);
});

test('a refused toggle leaves the state and the seat alone', async () => {
	const client = loadClient();
	const harness = fakeContext();
	await withFetch(() => ({ ok: true, json: async () => ({ enabled: false }) }), async () => {
		client.apply(harness.ctx);
		await settle();
	});

	const [command] = harness.commands;
	let failure;
	await withFetch(() => ({
		ok: false,
		status: 409,
		json: async () => ({ ok: false, error: 'configure both models before enabling the router' }),
	}), async () => {
		command.resolve({ region: 'page', modal: null }).run();
		await settle();
	}).catch((error) => { failure = error; });

	assert.equal(optionsOf(harness.registrations, 'conversation.input.model').length, 0, 'nothing was enabled');
	assert.equal(failure, undefined, 'the shortcut action swallows its own failure');
});

test('a missing shortcuts service does not stop the other surfaces', () => {
	const client = loadClient();
	const harness = fakeContext();
	// a dynamic client plugin reads an undeclared service through ctx.get
	const ctxWithoutShortcuts = {
		...harness.ctx,
		get: (name) => (name === 'shortcuts' ? undefined : harness.ctx.get(name)),
	};
	client.apply(ctxWithoutShortcuts);
	assert.equal(optionsOf(harness.registrations, 'conversation.input.right').length, 1);
	assert.equal(optionsOf(harness.registrations, 'settings.section').length, 1);
	assert.equal(harness.commands.length, 0, 'no shortcut without the service');
	harness.dispose();
});

// ---------- prompt-time routing (the send is held for the classification) ----------

/**
 * A conversation service shaped like the shipped one: `sendSession`/`send` live
 * on the prototype, and the tracker proxy's property write lands on the shared
 * instance.
 * @returns the service plus the ordered call log the test asserts on.
 */
function fakeConversation(order) {
	const log = [];
	const prototype = {
		async sendSession(...args) {
			order?.push('sendSession');
			log.push({ call: 'sendSession', args });
			return { kind: 'success' };
		},
		async send(...args) {
			order?.push('send');
			log.push({ call: 'send', args });
			return { ok: true };
		},
		scopeId() {
			return 'session-scoped';
		},
	};
	return { service: Object.create(prototype), log };
}

/**
 * Apply the client half with a scripted fetch that stays installed for the whole
 * test (the send's routing round trip happens long after `apply` returned), and
 * collect everything it touched. `harness.dispose()` restores the real fetch.
 */
async function routedHarness({ enabled = true, routeResponse, offline = false, order } = {}) {
	const client = loadClient();
	const conversation = fakeConversation(order);
	const harness = fakeContext({ conversation: conversation.service });
	const fetches = [];
	const real = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		const href = String(url);
		fetches.push({ url: href, options });
		if (href.includes('/route')) {
			order?.push('route');
			if (offline) throw new Error('offline');
			return routeResponse ?? { ok: true, json: async () => ({ ok: true, applied: true, kind: 'auto' }) };
		}
		return { ok: true, json: async () => ({ enabled }) };
	};
	const dispose = harness.dispose;
	harness.dispose = () => {
		globalThis.fetch = real;
		dispose();
	};
	client.apply(harness.ctx);
	await settle();
	const result = { client, harness, conversation, fetches };
	// a live view: the routing round trip happens after this function returned
	Object.defineProperty(result, 'routes', { get: () => fetches.filter((entry) => entry.url.includes('/route')) });
	return result;
}

test('the client half holds a send until the host has routed the prompt', async () => {
	const routed = await routedHarness();
	assert.equal(routed.routes.length, 0, 'no classification happens without a send');

	const session = { sessionId: 'session-1' };
	await routed.conversation.service.sendSession(session, '重构整个数据层', [], 'queue');

	assert.equal(routed.routes.length, 1, 'the prompt is classified once');
	assert.deepEqual(JSON.parse(routed.routes[0].options.body), { sessionId: 'session-1', text: '重构整个数据层' });
	assert.equal(routed.routes[0].options.method, 'POST');
	assert.equal(routed.conversation.log.length, 1, 'the prompt still reaches the conversation service');
	assert.deepEqual(routed.conversation.log[0].args, [session, '重构整个数据层', [], 'queue']);
	routed.harness.dispose();
});

test('the route call always lands before the send it holds', async () => {
	const order = [];
	const routed = await routedHarness({ order });
	await routed.conversation.service.sendSession({ sessionId: 's' }, 'deep work', [], 'queue');
	assert.deepEqual(order, ['route', 'sendSession'], 'the host must record the selection before admission');
	routed.harness.dispose();
});

test('the plain send API is routed too, and both wrappers come off on unload', async () => {
	const routed = await routedHarness();
	await routed.conversation.service.send('quick question');
	assert.equal(routed.routes.length, 1);
	assert.deepEqual(JSON.parse(routed.routes[0].options.body), { sessionId: 'session-scoped', text: 'quick question' });

	routed.harness.dispose();
	const service = routed.conversation.service;
	assert.equal(typeof service.sendSession, 'function', 'the service survives the unload');
	assert.equal(Object.hasOwn(service, 'sendSession'), false, 'the wrapper is removed, not left behind');
	assert.equal(Object.hasOwn(service, 'send'), false, 'the send wrapper too');
	await service.send('after unload');
	assert.equal(routed.routes.length, 1, 'an unloaded plugin no longer routes');
});

test('a send is never held up by routing failures', async () => {
	// the host refuses the route
	const refused = await routedHarness({ routeResponse: { ok: false, status: 500, json: async () => ({ ok: false }) } });
	const session = { sessionId: 'session-1' };
	await refused.conversation.service.sendSession(session, 'deep work', [], 'queue');
	assert.equal(refused.conversation.log.length, 1, 'a refused route still sends the prompt');
	assert.equal(refused.routes.length, 1, 'the host was asked');
	refused.harness.dispose();

	// the host is unreachable
	const offline = await routedHarness({ offline: true });
	await offline.conversation.service.sendSession(session, 'deep work', [], 'queue');
	assert.equal(offline.conversation.log.length, 1, 'a network failure still sends');
	offline.harness.dispose();

	// the router is switched off
	const off = await routedHarness({ enabled: false });
	await off.conversation.service.sendSession(session, 'deep work', [], 'queue');
	assert.equal(off.routes.length, 0, 'a disabled router never classifies');
	assert.equal(off.conversation.log.length, 1, 'and it still sends');
	off.harness.dispose();
});

test('an attachment-only prompt keeps the route the session already has', async () => {
	const routed = await routedHarness();
	await routed.conversation.service.sendSession({ sessionId: 'session-1' }, '', ['attachment-1'], 'queue');
	assert.equal(routed.routes.length, 0, 'no text means nothing to classify');
	assert.equal(routed.conversation.log.length, 1, 'the attachments still go out');
	routed.harness.dispose();
});

// ---------- correctness regressions found in review ----------

test('an existing own-property wrapper keeps running underneath this plugin', async () => {
	const client = loadClient();
	const conversation = fakeConversation();
	const service = conversation.service;
	// a co-installed plugin wrapped sendSession on the instance BEFORE we applied
	const foreign = [];
	const inner = service.sendSession.bind(service);
	service.sendSession = async function (...args) {
		foreign.push(args[1]);
		return inner(...args);
	};

	const harness = fakeContext({ conversation: service });
	await withFetch((url) => {
		if (url.includes('/route')) return { ok: true, json: async () => ({ ok: true, applied: true, kind: 'auto' }) };
		return { ok: true, json: async () => ({ enabled: true }) };
	}, async () => {
		client.apply(harness.ctx);
		await settle();
	});
	await service.sendSession({ sessionId: 'session-1' }, 'deep work', [], 'queue');

	assert.deepEqual(foreign, ['deep work'], 'reading the raw prototype would silently skip a foreign wrapper');
	assert.equal(conversation.log.length, 1);
	harness.dispose();
});

test('a re-apply does not stack a second send wrapper', async () => {
	const client = loadClient();
	const conversation = fakeConversation();
	// every service read mints a new Proxy, like the host's tracker proxy does
	const harness = fakeContext({ conversation: conversation.service, proxyServices: true });
	let routeCalls = 0;
	await withFetch((url) => {
		if (url.includes('/route')) {
			routeCalls += 1;
			return { ok: true, json: async () => ({ ok: true, applied: true, kind: 'auto' }) };
		}
		return { ok: true, json: async () => ({ enabled: true }) };
	}, async () => {
		client.apply(harness.ctx);
		await settle();
		// the second apply reads a NEW proxy for the same service: an identity
		// WeakSet cannot dedup it, so the wrapper must be keyed by prototype
		client.apply(harness.ctx);
		await settle();
		await conversation.service.sendSession({ sessionId: 'session-1' }, 'deep work', [], 'queue');
	});

	assert.equal(routeCalls, 1, 'one send must be routed once, not once per wrapper generation');
	assert.equal(conversation.log.length, 1, 'the prompt still reaches the service exactly once');
	harness.dispose();
});

test('the model seat re-reads a session directory the host replaced', async () => {
	const hooks = hookRuntime();
	const client = loadClient({ react: hooks.react });
	const directories = new Map([['session-1', { store: { getSnapshot: () => ({ current: { provider: 'p', model: 'aux-m' } }) } }]]);
	const reads = [];
	const modelDirectories = {
		directoryFor(sessionId) {
			reads.push(sessionId);
			return directories.get(sessionId);
		},
	};
	const harness = fakeContext({ modelDirectories });
	await withFetch(() => ({ ok: true, json: async () => ({ enabled: true }) }), async () => {
		client.apply(harness.ctx);
		await settle();
	});

	const [seat] = optionsOf(harness.registrations, 'conversation.input.model');
	assert.ok(seat, 'the seat is installed while the router is on');
	hooks.render(seat.component, { sessionId: 'session-1' });
	// one read for the durable selection, one for the catalog groups that name it
	assert.deepEqual(reads, ['session-1', 'session-1'], 'the directory service is consulted on render');

	// the host disposes the session binding and re-creates it: a memoized store
	// would now be a dead object and the seat would freeze on a stale selection
	directories.set('session-1', { store: { getSnapshot: () => ({ current: { provider: 'p', model: 'aux-m-2' } }) } });
	hooks.render(seat.component, { sessionId: 'session-1' });
	assert.deepEqual(
		reads,
		['session-1', 'session-1', 'session-1', 'session-1'],
		'a replaced directory must be re-resolved, never served from a cache',
	);

	// a directory that disappears again (session teardown) must not throw
	directories.delete('session-1');
	assert.doesNotThrow(() => hooks.render(seat.component, { sessionId: 'session-1' }));
	harness.dispose();
});

test('the seat and the routing detail print the catalog display name, not the model id', async () => {
	const hooks = hookRuntime();
	const client = loadClient({ react: hooks.react });
	// the shape the shipped selector reads: provider groups whose models carry
	// both the provider-owned id and the name the menu shows
	const groups = [
		{ id: 'strong-p', name: 'Strong', models: [{ id: 'strong-m', name: 'Strong Model' }] },
		{ id: 'fast-p', name: 'Fast', models: [{ id: 'fast-m', name: 'Fast Model' }] },
	];
	const modelDirectories = {
		directoryFor() {
			return { store: { getSnapshot: () => ({ current: null, groups }), subscribe: () => () => {} } };
		},
	};
	const harness = fakeContext({ modelDirectories });
	const streams = [];
	const realEventSource = globalThis.EventSource;
	globalThis.EventSource = class {
		constructor(url) {
			this.url = String(url);
			streams.push(this);
		}
		close() {}
	};
	try {
		await withFetch(() => ({ ok: true, json: async () => ({ enabled: true }) }), async () => {
			client.apply(harness.ctx);
			await settle();
		});

		const [seat] = optionsOf(harness.registrations, 'conversation.input.model');
		const [dock] = optionsOf(harness.registrations, 'conversation.composer.dock');
		assert.ok(seat, 'the seat is installed while the router is on');
		assert.ok(dock, 'the routing detail surface is installed');
		// rendering subscribes both surfaces, which opens the session's stream
		hooks.render(seat.component, { sessionId: 'session-1' });
		hooks.render(dock.component, { sessionId: 'session-1' });
		const stream = streams.find((entry) => entry.url.includes('session-1'));
		assert.ok(stream, 'the surfaces open one status stream for their session');

		stream.onmessage({
			data: JSON.stringify({
				type: 'init',
				enabled: true,
				primary: { provider: 'strong-p', model: 'strong-m' },
				aux: { provider: 'fast-p', model: 'fast-m' },
				status: { kind: 'auto', mode: 'simple', route: { provider: 'fast-p', model: 'fast-m' } },
			}),
		});

		const seatText = textOf(hooks.render(seat.component, { sessionId: 'session-1' })).join(' ');
		assert.match(seatText, /Fast Model/, 'the seat shows the catalog name');
		assert.doesNotMatch(seatText, /fast-m/, 'the raw model id is not the seat label');

		const dockText = textOf(hooks.render(dock.component, { sessionId: 'session-1' })).join(' ');
		assert.match(dockText, /Fast Model/, 'the routing detail shows the catalog name');
		assert.doesNotMatch(dockText, /fast-m/, 'the raw model id is not the routing detail label');

		// a catalog that does not know the routed model (e.g. not loaded yet, or a
		// provider that vanished) must still render something recognisable
		groups.length = 0;
		const fallbackText = textOf(hooks.render(dock.component, { sessionId: 'session-1' })).join(' ');
		assert.match(fallbackText, /fast-m/, 'an unknown model falls back to its id');
	} finally {
		globalThis.EventSource = realEventSource;
		harness.dispose();
	}
});

test('the routing dot is tinted by the auto mode, not the neutral fallback', async () => {
	const hooks = hookRuntime();
	const client = loadClient({ react: hooks.react });
	const harness = fakeContext();
	const streams = [];
	const realEventSource = globalThis.EventSource;
	globalThis.EventSource = class {
		constructor(url) {
			this.url = String(url);
			streams.push(this);
		}
		close() {}
	};
	try {
		await withFetch(() => ({ ok: true, json: async () => ({ enabled: true }) }), async () => {
			client.apply(harness.ctx);
			await settle();
		});

		const [dock] = optionsOf(harness.registrations, 'conversation.composer.dock');
		assert.ok(dock, 'the routing detail surface is installed');
		// rendering the surface subscribes it, which opens the session's stream
		hooks.render(dock.component, { sessionId: 'session-1' });
		const stream = streams.find((entry) => entry.url.includes('session-1'));
		assert.ok(stream, 'the surface opens one status stream for its session');

		stream.onmessage({
			data: JSON.stringify({
				type: 'init',
				enabled: true,
				primary: { provider: 'strong-p', model: 'strong-m' },
				aux: { provider: 'fast-p', model: 'fast-m' },
				status: { kind: 'auto', mode: 'complex', route: { provider: 'strong-p', model: 'strong-m' } },
			}),
		});
		const complex = hooks.render(dock.component, { sessionId: 'session-1' });
		const complexDot = complex.children[0].children[0];
		assert.match(complexDot.props.style.background, /brand-primary/, 'an auto complex route keeps its own tint');
		assert.match(textOf(complex).join(' '), /strong-m/, 'the surface names the model it routed to');

		stream.onmessage({
			data: JSON.stringify({
				type: 'init',
				enabled: true,
				aux: { provider: 'fast-p', model: 'fast-m' },
				status: { kind: 'auto', mode: 'simple', route: { provider: 'fast-p', model: 'fast-m' } },
			}),
		});
		const simple = hooks.render(dock.component, { sessionId: 'session-1' });
		assert.match(simple.children[0].children[0].props.style.background, /success-primary/, 'an auto simple route is not the neutral dot');

		// the neutral dot belongs to a manual pick only
		stream.onmessage({
			data: JSON.stringify({
				type: 'status',
				status: { kind: 'manual', mode: 'simple', route: { provider: 'manual-p', model: 'manual-m' } },
			}),
		});
		const manual = hooks.render(dock.component, { sessionId: 'session-1' });
		assert.match(manual.children[0].children[0].props.style.background, /idle-primary/);
	} finally {
		globalThis.EventSource = realEventSource;
		harness.dispose();
	}
});
