window.__ModuleLoader__.load({
	id: 'dsh-dual-model-router',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		var _react = require('react');
		//#region client/shared.mjs
		const PLUGIN_ID = 'dsh-dual-model-router';
		const STATUS_ENDPOINT = '/api/dual-model-router/status';
		const TOGGLE_ENDPOINT = '/api/dual-model-router/toggle';
		const SETTINGS_ENDPOINT = '/api/dual-model-router/settings';
		const SAVE_ENDPOINT = '/api/dual-model-router/settings/save';
		const ROUTE_ENDPOINT = '/api/dual-model-router/route';
		/**
		 * Longest a send waits for the classification round trip, used until the host
		 * advertises its own classifier budget (see `classifierTimeoutMs` in the
		 * status frame). Past this the message goes out and the host's pre-step
		 * listener routes the following step instead.
		 */
		const ROUTE_WAIT_MS = 6000;
		/** Slack added to the host's classifier budget: the host classifies, then reports. */
		const ROUTE_WAIT_SLACK_MS = 2000;
		/** Bounds on the wait, so a misconfigured budget cannot park the composer. */
		const ROUTE_WAIT_MIN_MS = 2000;
		const ROUTE_WAIT_MAX_MS = 30000;
		/** Longest task text sent for classification. */
		const ROUTE_TEXT_LIMIT = 8000;
		/** Editable command owned by this plugin (Settings → General → Shortcuts). */
		const SHORTCUT_ID = 'dual-model-router.toggle';
		/** KeyM is free on every shipped profile; web:linux stays unbound (see README). */
		const SHORTCUT_DEFAULTS = {
			'desktop:macos': { code: 'KeyM', modifiers: ['primary', 'alt'] },
			'desktop:windows': { code: 'KeyM', modifiers: ['primary', 'alt'] },
			'desktop:linux': { code: 'KeyM', modifiers: ['primary', 'alt'] },
			'web:macos': { code: 'KeyM', modifiers: ['primary', 'alt'] },
			'web:windows': { code: 'KeyM', modifiers: ['primary', 'alt'] },
		};

		const EN_COPY = {
			nav: 'Dual-Model Router',
			title: 'Dual-Model Router',
			description: 'A fast auxiliary model classifies every task and handles simple ones directly; complex tasks are planned by the strong primary model and executed by auxiliary-model subagents.',
			enabledLabel: 'Enable automatic routing by default for new conversations',
			enabledHint: 'Each conversation has its own switch at the composer, next to the model. This checkbox is only the default a conversation starts from: once you flip that conversation\'s switch by hand, that conversation follows its own choice and ignores this one.',
			primaryLabel: 'Primary model (strong · plans complex tasks)',
			auxLabel: 'Auxiliary model (fast · classifies, executes, answers simple tasks)',
			timeoutLabel: 'Classifier timeout (ms)',
			guidanceLabel: 'Inject planner guidance for complex tasks',
			keywordsLabel: 'Complex-task keywords (comma separated; any hit forces complex, no LLM call)',
			keywordsPlaceholder: 'e.g. hard, refactor, deep-dive',
			extraPromptLabel: 'Extra instructions injected into the prompt (optional)',
			extraPromptPlaceholder: 'e.g. when a subtask builds on conclusions already reached in this conversation, dispatch it with subagent_fork, since the child must see what happened; use subagent for independent tasks.',
			extraPromptHint: 'While automatic routing is on and a task is classified as complex, this text is appended to the primary model\'s system prompt (right after the planner guidance). It is the place to steer how the planner uses subagents — subagents run on the auxiliary model, so delegating is cheap. Leave it empty to inject nothing.',
			effortLabel: 'Reasoning effort',
			effortDefault: 'Default (model own)',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved — applied immediately',
			saveFailed: 'Save failed',
			loading: 'Loading…',
			loadFailed: 'Could not read the plugin configuration.',
			hintTitle: 'How it works',
			hintBody: 'Every new message is first classified by the auxiliary model. Simple tasks run entirely on the auxiliary model; complex tasks are planned by the primary model, which delegates execution steps to subagents running on the auxiliary model. The switch is per conversation: the control at the composer flips only the conversation it sits in, and while it is on that conversation\'s model control is locked and shows the model the router is using, so any model you pick yourself through the /model command is taken over at the next step. Switch it off (here or at the composer) to drive a conversation with a model of your own.',
			unconfigured: 'Pick both models before enabling.',
			notSet: '(not configured)',
			shortcutLabel: 'Toggle shortcut',
			shortcutAction: 'Toggle dual-model routing',
			shortcutUnbound: 'not bound',
			shortcutHint: 'Change it in Settings → General → Shortcuts. The status control in the composer toggles too.',
		};

		const ZH_COPY = {
			nav: '双模型路由',
			title: '双模型智能路由',
			description: '辅助（快）模型负责判别每个任务并直接完成简单任务；复杂任务由主（强）模型规划，执行步骤交给运行在辅助模型上的子智能体。',
			enabledLabel: '新会话默认开启自动路由',
			enabledHint: '每个对话在输入框旁（模型控件旁边）都有自己的开关。这里只是新对话的默认值：一旦你在某个对话里手动切换过，该对话就只跟随自己的设置，不再受这里影响。',
			primaryLabel: '主模型（强 · 规划复杂任务）',
			auxLabel: '辅助模型（快 · 判别 / 执行 / 简单任务）',
			timeoutLabel: '判别超时（毫秒）',
			guidanceLabel: '复杂任务时注入规划者指引',
			keywordsLabel: '复杂任务关键词（逗号分隔；命中即判复杂，跳过判别调用）',
			keywordsPlaceholder: '例如：hard, 深度分析, 重构',
			extraPromptLabel: '额外注入提示词（可选）',
			extraPromptPlaceholder: '例如：当子任务需要基于当前对话中已经得出的结论时，优先用 subagent_fork 派发，因为子代理需要知道之前发生了什么；全新的独立任务用 subagent。',
			extraPromptHint: '自动路由开启且任务被判为复杂时，这段文字会追加到主模型系统提示词的末尾（紧接规划者指引之后）。适合用来指导规划模型如何使用子代理：子代理运行在辅助模型上，委派成本很低。留空则不注入。',
			effortLabel: '思考强度',
			effortDefault: '默认（模型自身）',
			save: '保存',
			saving: '保存中…',
			saved: '已保存，立即生效',
			saveFailed: '保存失败',
			loading: '加载中…',
			loadFailed: '读取插件配置失败。',
			hintTitle: '工作方式',
			hintBody: '每条新消息先由辅助模型判别难度：简单任务全程走辅助模型；复杂任务由主模型规划，并把执行步骤委派给运行在辅助模型上的子智能体。开关是按对话生效的：输入框旁的开关只改变它所在的那个对话；开启期间该对话的模型控件被锁定，只显示路由当前使用的模型，通过 /model 选择的模型也会在下一步被接管。关掉它（在这里或在输入框旁）就能用自己的模型驱动这个对话。',
			unconfigured: '启用前请先选择两个模型。',
			notSet: '（未配置）',
			shortcutLabel: '开关快捷键',
			shortcutAction: '切换双模型路由',
			shortcutUnbound: '未绑定',
			shortcutHint: '可在 设置 → 通用 → 键盘快捷键 中修改；点击输入框下方的状态按钮同样可以切换。',
		};

		const EN_ROUTER = {
			/** The dot alone carries the on/off state; the label stays constant. */
			pillLabel: 'Auto routing',
			pillBusy: 'Switching…',
			pillOnTitle: 'Dual-model routing is ON in THIS conversation. Click, or press {keys}, to switch it off.',
			pillOffTitle: 'Dual-model routing is OFF in THIS conversation. Click, or press {keys}, to switch it on.',
			pillOnTitleNoKeys: 'Dual-model routing is ON in THIS conversation. Click to switch it off.',
			pillOffTitleNoKeys: 'Dual-model routing is OFF in THIS conversation. Click to switch it on.',
			pillFailed: 'Could not switch dual-model routing: {error}',
			seatAutoTitle: 'Dual-model routing is driving this conversation: the current request uses {model} ({mode} task). The composer model control follows the router, and a model picked through /model is taken over too; switch the router off to choose a model yourself.',
			modeComplex: 'complex',
			modeSimple: 'simple',
		};

		const ZH_ROUTER = {
			pillLabel: '自动路由',
			pillBusy: '切换中…',
			pillOnTitle: '本对话的双模型路由已开启。点击或按 {keys} 关闭。',
			pillOffTitle: '本对话的双模型路由已关闭。点击或按 {keys} 开启。',
			pillOnTitleNoKeys: '本对话的双模型路由已开启。点击关闭。',
			pillOffTitleNoKeys: '本对话的双模型路由已关闭。点击开启。',
			pillFailed: '切换双模型路由失败：{error}',
			seatAutoTitle: '双模型路由正在驱动本对话：当前请求使用 {model}（{mode}任务）。此处模型控件由路由接管，/model 选择的模型同样会被接管；关闭路由后即可自行选择模型。',
			modeComplex: '复杂',
			modeSimple: '简单',
		};

		const EN_INDICATOR = {
			classifying: 'auxiliary model is classifying…',
			autoSimple: (model) => `simple task · auxiliary model ${model}`,
			autoComplex: (model) => `complex task · primary model ${model} plans, auxiliary executes`,
			subagent: (model) => `subagent · auxiliary model ${model}`,
		};

		const ZH_INDICATOR = {
			classifying: '辅助模型判别任务难度…',
			autoSimple: (model) => `简单任务 · 辅助模型 ${model}`,
			autoComplex: (model) => `复杂任务 · 主模型 ${model} 规划，辅助模型执行`,
			subagent: (model) => `子代理 · 辅助模型 ${model}`,
		};

		const DOT_COLORS = {
			classifying: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
			autoSimple: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
			autoComplex: 'var(--dsw-alias-brand-primary, #4176e6)',
			subagent: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
		};
		/** A kind with no tint of its own stays neutral instead of guessing. */
		const NEUTRAL_DOT = 'var(--dsw-alias-state-idle-primary, #999)';

		const isZh = () => {
			const lang = document.documentElement.lang || navigator.language || '';
			return /^zh(?:-|$)/i.test(lang);
		};

		const copy = () => (isZh() ? ZH_COPY : EN_COPY);
		const routerCopy = () => (isZh() ? ZH_ROUTER : EN_ROUTER);
		const indicatorCopy = () => (isZh() ? ZH_INDICATOR : EN_INDICATOR);

		const h = (tag, props, ...children) => _react.createElement(tag, props ?? {}, ...children);

		/** React 18 store binding, with a minimal shim for an older runtime. */
		const useSyncStore = typeof _react.useSyncExternalStore === 'function'
			? _react.useSyncExternalStore
			: (subscribe, getSnapshot) => {
				const [value, setValue] = _react.useState(getSnapshot);
				_react.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot]);
				return value;
			};

		const NOOP_SUBSCRIBE = () => () => {};

		const routeKey = (route) => (route && route.provider && route.model ? `${route.provider}::${route.model}` : '');

		/** Nothing known about this conversation yet. */
		const EMPTY_SESSION = Object.freeze({
			ready: false,
			enabled: undefined,
			defaultEnabled: undefined,
			primary: null,
			aux: null,
			status: null,
		});

		/**
		 * One SSE connection per live conversation, shared by every surface of
		 * this plugin (the composer pill, the model seat, the routing pill).
		 * Frames carry the conversation's own switch next to the applied config, so
		 * a toggle made anywhere — the shortcut, the pill, the settings page,
		 * another browser tab — reaches every surface of that conversation as soon
		 * as the host answers or re-applies.
		 */
		function createSessionHub() {
			const values = new Map();
			const listeners = new Map();
			/** Listeners of EVERY conversation: the global surfaces read one session. */
			const anyListeners = new Set();
			const sources = new Map();
			/** Conversations a JSON state read is already in flight for. */
			const priming = new Set();

			const stateOf = (sessionId) => values.get(sessionId) ?? EMPTY_SESSION;

			const notify = (sessionId) => {
				const group = listeners.get(sessionId);
				if (group === undefined) return;
				for (const listener of [...group]) {
					try {
						listener();
					} catch {
						// one surface's render error must not starve the others
					}
				}
			};

			const notifyAny = (sessionId) => {
				for (const listener of [...anyListeners]) {
					try {
						listener(sessionId);
					} catch {
						// a global surface that throws must not stop the state from landing
					}
				}
			};

			const patch = (sessionId, next) => {
				values.set(sessionId, { ...stateOf(sessionId), ...next });
				notify(sessionId);
				notifyAny(sessionId);
			};

			const applyFrame = (sessionId, frame) => {
				if (frame?.type === 'init') {
					adoptClassifierBudget(frame);
					// the profile default travels with every frame, so a page learns it
					// from whichever conversation reports first
					adoptDefault(frame);
					patch(sessionId, {
						ready: true,
						enabled: frame.enabled === true,
						defaultEnabled: typeof frame.defaultEnabled === 'boolean' ? frame.defaultEnabled : undefined,
						primary: frame.primary ?? null,
						aux: frame.aux ?? null,
						status: frame.status ?? null,
					});
					return;
				}
				if (frame?.type === 'status') patch(sessionId, { ready: true, status: frame.status ?? null });
			};

			const open = (sessionId) => {
				let source;
				try {
					source = new EventSource(`${STATUS_ENDPOINT}?session=${encodeURIComponent(sessionId)}`);
				} catch {
					return;
				}
				source.onmessage = (event) => {
					let frame;
					try {
						frame = JSON.parse(event.data);
					} catch {
						return;
					}
					applyFrame(sessionId, frame);
				};
				sources.set(sessionId, source);
			};

			const close = (sessionId) => {
				const source = sources.get(sessionId);
				if (source === undefined) return;
				sources.delete(sessionId);
				try {
					source.close();
				} catch {
					// an already-closed stream needs no further work
				}
			};

			return {
				stateOf,
				/** Record one conversation's state locally (the optimistic flip). */
				patch,
				/**
				 * Observe every conversation's state, not one: the model-seat takeover
				 * is a single registration shared by all composers, so it must follow
				 * whichever conversation is active now.
				 */
				subscribeAny(listener) {
					anyListeners.add(listener);
					return () => {
						anyListeners.delete(listener);
					};
				},
				/**
				 * Read one conversation's state without opening its stream.
				 *
				 * The takeover decision has to be made the moment a conversation becomes
				 * active; waiting for an EventSource handshake would flash the shipped
				 * model selector in every conversation that already had the router on.
				 * One JSON read per conversation, skipped once any frame has arrived.
				 */
				prime(sessionId) {
					if (sessionId === undefined || priming.has(sessionId) || stateOf(sessionId).ready === true) return;
					priming.add(sessionId);
					Promise.resolve()
						.then(() => fetch(`${STATUS_ENDPOINT}?session=${encodeURIComponent(sessionId)}`, {
							cache: 'no-store',
							headers: { accept: 'application/json' },
						}))
						.then((response) => (response.ok ? response.json() : null))
						.then((frame) => {
							// the JSON snapshot is an init frame without the envelope
							if (frame !== null && frame !== undefined) applyFrame(sessionId, { type: 'init', ...frame });
						})
						.catch(() => {
							// offline or unauthenticated: the stream still reports the truth
						})
						.finally(() => priming.delete(sessionId));
				},
				subscribe(sessionId, listener) {
					let group = listeners.get(sessionId);
					if (group === undefined) {
						group = new Set();
						listeners.set(sessionId, group);
					}
					group.add(listener);
					if (group.size === 1) open(sessionId);
					return () => {
						const current = listeners.get(sessionId);
						if (current === undefined) return;
						current.delete(listener);
						if (current.size === 0) {
							listeners.delete(sessionId);
							close(sessionId);
						}
					};
				},
			};
		}

		const hub = createSessionHub();

		/**
		 * The profile row's default switch, learned without waiting for a
		 * conversation. It is only the fallback for a conversation this page has
		 * never seen (see `routeGateEnabled`), never the answer for one it has.
		 */
		let routerDefaultEnabled;

		/** Adopt the profile default a status frame reports, if it carries one. */
		const adoptDefault = (frame) => {
			if (typeof frame?.defaultEnabled === 'boolean') routerDefaultEnabled = frame.defaultEnabled;
			else if (typeof frame?.enabled === 'boolean') routerDefaultEnabled = frame.enabled;
		};

		/**
		 * The conversation the user is working in.
		 *
		 * The composer pill and the routing detail are rendered per conversation and
		 * therefore know their own session; the model-seat takeover is ONE global
		 * registration that shadows the shipped selector in every composer at once,
		 * so it has to follow a single conversation. Focus — or a pointer press, or a
		 * send — inside a `[data-conversation-session]` container elects that
		 * conversation, and a page showing exactly one conversation elects it without
		 * any interaction.
		 */
		const activeSession = { value: undefined, listeners: new Set() };

		function setActiveSession(sessionId) {
			if (typeof sessionId !== 'string' || sessionId.length === 0) return;
			if (activeSession.value === sessionId) return;
			activeSession.value = sessionId;
			for (const listener of [...activeSession.listeners]) {
				try {
					listener(sessionId);
				} catch {
					// a broken listener must not stop the election from landing
				}
			}
		}

		const subscribeActiveSession = (listener) => {
			activeSession.listeners.add(listener);
			return () => {
				activeSession.listeners.delete(listener);
			};
		};

		/**
		 * Whether this router CONFIRMED drives one conversation. `undefined` (no frame
		 * yet) is not a yes: the seat is only taken over on a confirmed switch, so a
		 * cold page never hides the shipped selector behind a guess.
		 */
		const enabledForSession = (sessionId) => hub.stateOf(sessionId).enabled === true;

		/** Whether the page currently renders one conversation's container. */
		function isConversationOnScreen(sessionId) {
			const doc = typeof document === 'undefined' ? undefined : document;
			if (typeof doc?.querySelectorAll !== 'function') return false;
			try {
				return [...doc.querySelectorAll('[data-conversation-session]')]
					.some((node) => node?.getAttribute?.('data-conversation-session') === sessionId);
			} catch {
				return false;
			}
		}

		/**
		 * Whether a send should be held for the classification round trip.
		 *
		 * A conversation whose own switch is known answers for itself. One the page
		 * has never seen — a session with no composer mounted, a programmatic
		 * `sendSession` — falls back to the profile default, which is the same gate
		 * this used before the switch became per conversation; the host answers
		 * `kind: 'off'` without spending a model call when that conversation turns
		 * out to be switched off, so the fallback costs one round trip at worst.
		 */
		const routeGateEnabled = (sessionId) => {
			const state = hub.stateOf(sessionId);
			return state.ready === true ? state.enabled === true : routerDefaultEnabled === true;
		};

		/** Whether the conversation the global surfaces follow has the router on. */
		const activeSessionEnabled = () => enabledForSession(activeSession.value);

		/**
		 * How long a send may be held for the routing round trip. It follows the
		 * host's own classifier budget, so the two ends share one knob
		 * (`classifierTimeoutMs`): a host that classifies patiently gets a client
		 * that waits for it, instead of one that gives up mid-classification and
		 * loses first-step routing.
		 */
		let routeWaitMs = ROUTE_WAIT_MS;

		/** Adopt the host's classifier budget from a status frame, if it carries one. */
		function adoptClassifierBudget(frame) {
			const budget = frame?.classifierTimeoutMs;
			if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return;
			routeWaitMs = Math.min(ROUTE_WAIT_MAX_MS, Math.max(ROUTE_WAIT_MIN_MS, budget + ROUTE_WAIT_SLACK_MS));
		}

		/** Effective keycaps of the toggle command, published by the shortcut effect. */
		const shortcutKeys = { value: [], listeners: new Set() };

		function setShortcutKeys(keys) {
			const next = Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : [];
			if (shortcutKeys.value.length === next.length && shortcutKeys.value.every((key, index) => key === next[index])) return;
			shortcutKeys.value = next;
			for (const listener of [...shortcutKeys.listeners]) {
				try {
					listener();
				} catch {
					// keycap text is decoration; never let it break a render
				}
			}
		}

		const subscribeShortcutKeys = (listener) => {
			shortcutKeys.listeners.add(listener);
			return () => {
				shortcutKeys.listeners.delete(listener);
			};
		};
		const snapshotShortcutKeys = () => shortcutKeys.value;

		/** Word-form modifier labels the platform renders as separate keycaps. */
		const WORD_MODIFIER = /^(?:Ctrl|Control|Alt|Option|Shift|Cmd|Command|Meta|Super|Win|Fn)$/i;

		/**
		 * Keycap text for one binding. The catalog hands back SEPARATE keycap
		 * labels and only interleaves a literal '+' on the Windows profile, so
		 * joining blindly renders a Linux chord as "CtrlAltM" and a macOS glyph
		 * chord as "⌃⌥M" (which is right only because the glyphs are single
		 * tokens). Join with '+' exactly when the labels are words and the
		 * platform did not already supply separators.
		 */
		const keycapTextOf = (keys) => {
			if (!Array.isArray(keys) || keys.length === 0) return '';
			if (keys.includes('+')) return keys.join('');
			return keys.some((key) => WORD_MODIFIER.test(String(key))) ? keys.join('+') : keys.join('');
		};

		/** Optional camera on the plugin's own model seat for the session catalog. */
		let pluginCtx;
		let modelDirectories;

		/**
		 * The session model directory service, resolved lazily: a dynamic client
		 * plugin may only READ an undeclared service (`ctx.get`), and the service
		 * may be provided after this plugin applies.
		 */
		const modelDirectoryService = () => {
			if (modelDirectories !== undefined) return modelDirectories;
			if (pluginCtx === undefined) return undefined;
			let service;
			try {
				service = pluginCtx.get('modelDirectories');
			} catch {
				service = undefined;
			}
			if (service === undefined || typeof service.directoryFor !== 'function') return undefined;
			modelDirectories = service;
			return service;
		};

		/**
		 * The session's live model-directory store.
		 *
		 * Re-resolved on every read: the model-selection service keeps one
		 * directory per live session binding and disposes it with that scope, so a
		 * re-created session (closed and reopened without a page reload) resolves
		 * a brand-new store. Memoizing the old one here would pin a disposed store
		 * and freeze this conversation's seat on a selection that no longer
		 * updates. The service's own lookup is a binding-keyed Map read, which is
		 * exactly how the shipped model selector calls it too.
		 */
		const directoryStoreOf = (sessionId) => {
			if (sessionId === undefined) return undefined;
			const service = modelDirectoryService();
			if (service === undefined) return undefined;
			try {
				const store = service.directoryFor(sessionId)?.store;
				return store === undefined ? undefined : store;
			} catch {
				// an unknown, not-yet-scoped or torn-down session has no directory
				// yet. Nothing global is invalidated: the service handle is still
				// good and every other session's directory is still live.
				return undefined;
			}
		};

		/** No catalog read yet; one stable array so a subscriber never sees a fresh identity. */
		const EMPTY_GROUPS = [];

		/**
		 * The session catalog's provider groups, read from the same directory store
		 * the shipped selector builds. Used only to turn a provider-owned model id
		 * into the name the selector itself would print: an unavailable catalog just
		 * leaves the id as the label (`pageGroups` below covers the surfaces that
		 * have no directory of their own).
		 */
		const groupsCache = new WeakMap();
		const groupsOf = (store) => {
			if (store === null || typeof store !== 'object') return EMPTY_GROUPS;
			let snapshot = null;
			try {
				snapshot = store.getSnapshot?.() ?? null;
			} catch {
				snapshot = null;
			}
			const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : EMPTY_GROUPS;
			// Compare the ARRAY, not the snapshot: the store hands back the same
			// groups reference across unrelated updates, while a fresh identity on
			// every read would make uSES loop instead of render.
			if (groupsCache.get(store) === groups) return groups;
			groupsCache.set(store, groups);
			return groups;
		};

		/** The page's fallback catalog, and who is showing a label from it. */
		let pageGroups = EMPTY_GROUPS;
		let pageCatalogRequest = null;
		const pageGroupListeners = new Set();

		/** Adopt a catalog any source resolved, and re-render whoever was waiting. */
		const publishPageGroups = (groups) => {
			if (!Array.isArray(groups) || groups.length === 0 || groups === pageGroups) return;
			pageGroups = groups;
			for (const listener of [...pageGroupListeners]) {
				try {
					listener();
				} catch {
					// one surface failing must not stop the others from repainting
				}
			}
		};

		/**
		 * Load the host catalog once for this page, when nothing else has.
		 *
		 * `remote.session.modelCatalog()` is the same call the shipped selector's
		 * own catalog makes (protocol name: `modelCatalog`), and it needs no
		 * session. A failure is remembered as "nothing to fall back to": the next
		 * session that gets a directory still carries the catalog itself.
		 */
		const requestPageCatalog = () => {
			if (pageGroups.length > 0 || pageCatalogRequest !== null || pluginCtx === undefined) return;
			let session;
			try {
				session = pluginCtx.remote?.session;
			} catch {
				// a build without the remote service: no fallback, no error
				session = undefined;
			}
			if (session === undefined || typeof session.modelCatalog !== 'function') return;
			pageCatalogRequest = Promise.resolve()
				.then(() => session.modelCatalog())
				.then((response) => {
					if (response?.ok === true) publishPageGroups(response.value?.groups);
				})
				.catch(() => {
					// offline, unauthenticated or a host without the route: the
					// session directories remain the source
				})
				.finally(() => {
					pageCatalogRequest = null;
				});
		};

		/** The catalog's display name for one route, falling back to its id. */
		const modelLabelOf = (groups, provider, model) => {
			if (typeof model !== 'string' || model.length === 0) return '';
			for (const group of groups) {
				if (provider !== undefined && provider !== '' && group?.id !== provider) continue;
				for (const entry of group?.models ?? []) {
					if (entry?.id === model) return entry.name ?? model;
				}
			}
			return model;
		};

		/**
		 * Read the profile default without waiting for a conversation (JSON
		 * snapshot). Only the settings surfaces need it: every conversation learns
		 * its OWN switch from that conversation's frames.
		 */
		async function refreshDefaultState() {
			try {
				const response = await fetch(STATUS_ENDPOINT, {
					cache: 'no-store',
					headers: { accept: 'application/json' },
				});
				if (!response.ok) return;
				const frame = await response.json();
				if (frame !== null && typeof frame === 'object') adoptDefault(frame);
				adoptClassifierBudget(frame);
			} catch {
				// offline or unauthenticated: the conversation frames still carry it
			}
		}

		/**
		 * Flip ONE conversation's switch through the host; resolves to the new state.
		 *
		 * The desired state travels with the request instead of being inferred by the
		 * host: a surface whose frame is a beat behind would otherwise flip the
		 * conversation the wrong way, and two tabs toggling at once would race.
		 * @param sessionId - the conversation to flip. Without one the profile
		 *   default is flipped instead, which is what an API caller gets.
		 */
		const togglesInFlight = new Map();

		function toggleRouter(sessionId) {
			const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '';
			if (togglesInFlight.has(key)) return togglesInFlight.get(key);
			const current = key === '' ? undefined : hub.stateOf(key).enabled;
			const body = { enabled: current !== true };
			if (key !== '') body.sessionId = key;
			const pending = (async () => {
				try {
					const response = await fetch(TOGGLE_ENDPOINT, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
					});
					const payload = await response.json().catch(() => null);
					if (payload?.ok !== true || typeof payload.enabled !== 'boolean') {
						throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
					}
					// Optimistic, and only for the conversation that was flipped: the
					// host's own frame for it follows immediately. A flip of the profile
					// DEFAULT patches nothing locally — it re-applies the host, every
					// stream reconnects, and conversations carrying an override must keep it.
					if (key !== '') hub.patch(key, { ready: true, enabled: payload.enabled });
					return payload.enabled;
				} finally {
					togglesInFlight.delete(key);
				}
			})();
			togglesInFlight.set(key, pending);
			return pending;
		}

		/** The conversation a DOM node belongs to, if the node sits inside one. */
		function sessionIdOfNode(node) {
			try {
				const holder = typeof node?.closest === 'function' ? node.closest('[data-conversation-session]') : null;
				const found = holder?.getAttribute?.('data-conversation-session');
				return typeof found === 'string' && found.length > 0 ? found : undefined;
			} catch {
				return undefined;
			}
		}

		/** Resolve the conversation a surface renders in, with a DOM fallback. */
		function useSessionId(sessionIdProp, nodeRef) {
			const [sniffed, setSniffed] = _react.useState(undefined);
			_react.useEffect(() => {
				if (sessionIdProp !== undefined) return undefined;
				const found = sessionIdOfNode(nodeRef.current);
				if (found !== undefined) setSniffed((current) => (current === found ? current : found));
				return undefined;
			});
			return sessionIdProp ?? sniffed;
		}

		/** Subscribe this surface to its conversation's routing state. */
		function useSessionState(sessionId) {
			const subscribe = _react.useMemo(
				() => (listener) => (sessionId === undefined ? NOOP_SUBSCRIBE() : hub.subscribe(sessionId, listener)),
				[sessionId],
			);
			const getSnapshot = _react.useMemo(
				() => () => (sessionId === undefined ? EMPTY_SESSION : hub.stateOf(sessionId)),
				[sessionId],
			);
			return useSyncStore(subscribe, getSnapshot);
		}

		/**
		 * The conversation's model catalog groups: its own directory while the host
		 * has scoped it (empty until the catalog loads), else this page's fallback
		 * catalog. Both sources are subscribed, so a late directory — or the first
		 * fallback response — repaints the label instead of leaving an id behind.
		 */
		function useSessionGroups(sessionId) {
			const store = directoryStoreOf(sessionId);
			const subscribe = _react.useMemo(
				() => (listener) => {
					const stopDirectory = store === undefined || typeof store.subscribe !== 'function'
						? undefined
						: store.subscribe(listener);
					pageGroupListeners.add(listener);
					// seeding here, never during a render: publishing wakes listeners,
					// which React only allows from an effect
					const groups = groupsOf(store);
					if (groups.length > 0) publishPageGroups(groups);
					else requestPageCatalog();
					return () => {
						if (typeof stopDirectory === 'function') stopDirectory();
						pageGroupListeners.delete(listener);
					};
				},
				[store],
			);
			const getSnapshot = _react.useMemo(
				() => () => {
					const groups = groupsOf(store);
					return groups.length > 0 ? groups : pageGroups;
				},
				[store],
			);
			return useSyncStore(subscribe, getSnapshot);
		}

		/**
		 * What this conversation is running on right now: the router's own decision
		 * once it has one, else the route its current mode targets. The router owns
		 * the session's model while it is on, so a pick made through /model is not
		 * a second source of truth here.
		 */
		const currentRouteOf = (session) => {
			const primary = session.primary ?? null;
			const aux = session.aux ?? null;
			const status = session.status;
			const routed = status?.route && status.route.model ? status.route : null;
			const mode = status?.mode === 'complex' ? 'complex' : 'simple';
			if (routed !== null) {
				return { provider: routed.provider ?? '', model: routed.model, mode };
			}
			const target = mode === 'complex' ? primary : aux;
			if (target === null || !target.model) return null;
			return { provider: target.provider, model: target.model, mode };
		};
		//#endregion
		//#region client/status-pill.mjs
		/**
		 * Resident on/off switch at the left of the composer's model seat. It drives
		 * THIS conversation's switch — the profile row is only the default a
		 * conversation starts from — so two conversations never drag each other on
		 * and off.
		 */
		function RouterStatusPill({ sessionId: sessionIdProp }) {
			const t = routerCopy();
			const nodeRef = _react.useRef(null);
			const sessionId = useSessionId(sessionIdProp, nodeRef);
			const session = useSessionState(sessionId);
			const keys = useSyncStore(subscribeShortcutKeys, snapshotShortcutKeys);
			const [pending, setPending] = _react.useState(false);
			const [failure, setFailure] = _react.useState(null);
			const failureTimer = _react.useRef(null);
			_react.useEffect(() => () => {
				if (failureTimer.current !== null) clearTimeout(failureTimer.current);
			}, []);

			const enabled = session.enabled;

			const toggle = () => {
				if (pending) return;
				if (typeof sessionId === 'string' && sessionId.length > 0) setActiveSession(sessionId);
				setPending(true);
				setFailure(null);
				toggleRouter(sessionId)
					.catch((error) => {
						setFailure(String(error?.message ?? error));
						// one live timer: a second failure must not be cleared early
						// by the first one's timeout, and an unmount must cancel it
						if (typeof setTimeout === 'function') {
							if (failureTimer.current !== null) clearTimeout(failureTimer.current);
							failureTimer.current = setTimeout(() => {
								failureTimer.current = null;
								setFailure(null);
							}, 6000);
						}
					})
					.finally(() => setPending(false));
			};

			if (enabled === undefined) return null;

			const active = enabled === true;
			const keyText = keycapTextOf(keys);
			const tip = failure !== null
				? t.pillFailed.replace('{error}', failure)
				: keyText === ''
					// no effective binding (web:linux ships unbound): "press , to…"
					// would render a broken sentence
					? (active ? t.pillOnTitleNoKeys : t.pillOffTitleNoKeys)
					: (active ? t.pillOnTitle : t.pillOffTitle).replace('{keys}', keyText);
			const dot = failure !== null
				? 'var(--dsw-alias-state-error-primary, #ec1313)'
				: active ? 'var(--dsw-alias-state-success-primary, #2e9e5b)' : 'var(--dsw-alias-state-idle-primary, #999)';

			return h('button', {
				ref: (node) => { nodeRef.current = node; },
				type: 'button',
				'aria-pressed': active,
				title: tip,
				disabled: pending,
				onClick: toggle,
				style: {
					display: 'inline-flex', alignItems: 'center', gap: '6px',
					height: '24px', padding: '0 9px', borderRadius: '999px',
					border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))',
					background: active ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))' : 'transparent',
					color: active ? 'var(--dsw-alias-label-primary, inherit)' : 'var(--dsw-alias-label-secondary, #666)',
					fontFamily: 'inherit', fontSize: '12px', lineHeight: '1',
					whiteSpace: 'nowrap', cursor: pending ? 'progress' : 'pointer',
				},
			},
				h('span', { style: { flex: 'none', width: '7px', height: '7px', borderRadius: '999px', background: dot } }),
				h('span', null, pending ? t.pillBusy : t.pillLabel));
		}
		//#endregion
		//#region client/model-seat.mjs
		/**
		 * Replacement for the composer's model control while the router is on.
		 * The seat is owned by the plugin then: it is not interactive, and it
		 * reports the model this conversation actually runs on. Switching the
		 * router off restores the shipped selector.
		 */
		function RouterModelSeat({ sessionId: sessionIdProp }) {
			const t = routerCopy();
			const nodeRef = _react.useRef(null);
			const sessionId = useSessionId(sessionIdProp, nodeRef);
			const session = useSessionState(sessionId);
			const groups = useSessionGroups(sessionId);
			const route = currentRouteOf(session);

			const ref = (node) => { nodeRef.current = node; };
			if (route === null) {
				return h('span', {
					ref,
					style: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #666)' },
				}, h('span', null, '…'));
			}

			// the shipped selector prints the catalog's display name; the router
			// must too, or the seat shows a raw model id the user never picked
			const modelLabel = modelLabelOf(groups, route.provider, route.model);
			const mode = route.mode === 'complex' ? t.modeComplex : t.modeSimple;
			const title = t.seatAutoTitle
				.replace('{model}', route.provider.length > 0 ? `${route.provider}/${modelLabel}` : modelLabel)
				.replace('{mode}', mode);

			return h('span', {
				ref,
				title,
				'aria-label': title,
				'data-dual-model-router-seat': 'auto',
				style: {
					display: 'inline-flex', alignItems: 'center', gap: '6px',
					maxWidth: '260px', padding: '4px 8px', borderRadius: '8px',
					color: 'var(--dsw-alias-label-secondary, #666)',
					fontSize: '13px', lineHeight: '16px', cursor: 'default',
				},
			},
				h('svg', {
					width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true,
					style: { flex: 'none', color: 'var(--dsw-alias-brand-primary, #4176e6)' },
				},
					h('path', {
						d: 'M2 4.5h3l6 7h3M2 11.5h3l1.7-2M14 4.5h-3l-1.7 2',
						fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
					})),
				h('span', {
					style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary, inherit)' },
				}, modelLabel));
		}
		//#endregion
		//#region client/dock-status.mjs
		/** Routing detail below the composer card (what the router just decided). */
		function RoutingStatus({ sessionId: sessionIdProp }) {
			const t = indicatorCopy();
			const nodeRef = _react.useRef(null);
			const sessionId = useSessionId(sessionIdProp, nodeRef);
			const session = useSessionState(sessionId);
			const groups = useSessionGroups(sessionId);
			const enabled = session.enabled;
			const status = session.status;

			if (enabled !== true || status === null || status === undefined) return null;

			// the catalog's display name, not the raw provider-owned id
			const model = modelLabelOf(groups, status.route?.provider ?? '', status.route?.model ?? '');
			// `kind` is the protocol value the host emits ('auto'), while the
			// palette is keyed by the surface it describes: an auto route is
			// tinted by its mode.
			const dotKey = status.kind === 'auto'
				? (status.mode === 'complex' ? 'autoComplex' : 'autoSimple')
				: status.kind;
			const color = DOT_COLORS[dotKey] ?? NEUTRAL_DOT;
			let text = '';
			if (status.kind === 'classifying') text = t.classifying;
			else if (status.kind === 'auto' && status.mode === 'complex') text = t.autoComplex(model);
			else if (status.kind === 'auto') text = t.autoSimple(model);
			else if (status.kind === 'subagent') text = t.subagent(model);
			if (text === '') return null;

			return h('div', {
				ref: (node) => { nodeRef.current = node; },
				style: { display: 'flex', justifyContent: 'flex-end', padding: '2px 6px', pointerEvents: 'none' },
			},
				h('span', {
					style: {
						display: 'inline-flex', alignItems: 'center', gap: '7px',
						padding: '3px 10px', borderRadius: '999px',
						fontSize: '12px', lineHeight: '18px',
						color: 'var(--dsw-alias-label-secondary, #666)',
						background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
						border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))',
					},
				},
					h('span', { style: { flex: 'none', width: '7px', height: '7px', borderRadius: '999px', background: color } }),
					h('span', null, text)));
		}
		//#endregion
		//#region client/settings-page.mjs
		const routeValue = (route) => (route && route.provider && route.model ? `${route.provider}::${route.model}` : '');

		const parseRouteValue = (value) => {
			const separator = value.indexOf('::');
			if (separator < 0) return { provider: '', model: '' };
			return { provider: value.slice(0, separator), model: value.slice(separator + 2) };
		};

		const COMMON_EFFORTS = ['off', 'low', 'medium', 'high', 'max'];

		const selectStyle = {
			padding: '8px 10px',
			borderRadius: '8px',
			border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.15))',
			background: 'var(--dsw-alias-bg-layer-2, transparent)',
			color: 'inherit',
			fontSize: '13px',
			minWidth: 0,
		};

		const findModel = (providers, route) => {
			for (const provider of providers) {
				for (const model of provider.models) {
					if (provider.id === route.provider && model.id === route.model) return model;
				}
			}
			return undefined;
		};

		/**
		 * The effort a Save must persist for one route.
		 *
		 * The picker shows "default" whenever the saved value is not among the
		 * model's advertised efforts, so the same clearing rule has to run on
		 * submit: otherwise the control says "default" while the stale hidden
		 * value is written back.
		 */
		const effectiveEffortOf = (providers, value, effort) => {
			const model = findModel(providers ?? [], parseRouteValue(value));
			const efforts = model?.efforts ?? COMMON_EFFORTS;
			return efforts.includes(effort) ? effort : '';
		};

		function RoutePicker({ label, value, effort, providers, onChange, onEffortChange, placeholder, effortLabel, effortDefaultLabel }) {
			const route = parseRouteValue(value);
			const model = findModel(providers, route);
			const efforts = model?.efforts ?? COMMON_EFFORTS;
			const effectiveEffort = efforts.includes(effort) ? effort : '';
			return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: 220 } },
				h('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
					h('span', { style: { fontSize: '13px', fontWeight: 500 } }, label),
					h('select', { value, onChange: (event) => onChange(event.target.value), style: selectStyle },
						h('option', { value: '' }, placeholder),
						providers.map((provider) => h('optgroup', { key: provider.id, label: provider.name ?? provider.id },
							provider.models.map((model) => h('option', {
								key: `${provider.id}::${model.id}`,
								value: `${provider.id}::${model.id}`,
							}, `${model.name ?? model.id}`)),
						)))),
				h('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
					h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)' } }, effortLabel),
					h('select', { value: effectiveEffort, onChange: (event) => onEffortChange(event.target.value), style: selectStyle },
						h('option', { value: '' }, effortDefaultLabel),
						efforts.map((id) => h('option', { key: id, value: id }, id)))));
		}

		function SettingsPage() {
			const t = copy();
			const keys = useSyncStore(subscribeShortcutKeys, snapshotShortcutKeys);
			const [data, setData] = _react.useState(null);
			const [loadFailed, setLoadFailed] = _react.useState(false);
			const [enabled, setEnabled] = _react.useState(false);
			const [primary, setPrimary] = useStateRoute('');
			const [aux, setAux] = useStateRoute('');
			const [primaryEffort, setPrimaryEffort] = _react.useState('');
			const [auxEffort, setAuxEffort] = _react.useState('');
			const [timeoutMs, setTimeoutMs] = _react.useState(15000);
			const [guidance, setGuidance] = _react.useState(true);
			const [keywordsText, setKeywordsText] = _react.useState('');
			const [extraPrompt, setExtraPrompt] = _react.useState('');
			const [status, setStatus] = _react.useState(null);
			const [saving, setSaving] = _react.useState(false);

			_react.useEffect(() => {
				let cancelled = false;
				fetch(SETTINGS_ENDPOINT, { cache: 'no-store' })
					.then((response) => (response.ok ? response.json() : null))
					.then((payload) => {
						if (cancelled || payload?.config === undefined) {
							if (!cancelled) setLoadFailed(true);
							return;
						}
						setData(payload);
						setEnabled(payload.config.enabled === true);
						setPrimary(routeValue(payload.config.primary));
						setAux(routeValue(payload.config.aux));
						setTimeoutMs(payload.config.classifierTimeoutMs ?? 15000);
						setGuidance(payload.config.plannerGuidance !== false);
						setKeywordsText(Array.isArray(payload.config.complexKeywords) ? payload.config.complexKeywords.join(', ') : '');
						setExtraPrompt(typeof payload.config.extraPrompt === 'string' ? payload.config.extraPrompt : '');
						setPrimaryEffort(payload.config.primary?.reasoningEffort ?? '');
						setAuxEffort(payload.config.aux?.reasoningEffort ?? '');
					})
					.catch(() => { if (!cancelled) setLoadFailed(true); });
				return () => { cancelled = true; };
			}, []);

			const save = async () => {
				setSaving(true);
				setStatus(null);
				try {
					const response = await fetch(SAVE_ENDPOINT, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							enabled,
							primary: { ...parseRouteValue(primary), reasoningEffort: effectiveEffortOf(providers, primary, primaryEffort) },
							aux: { ...parseRouteValue(aux), reasoningEffort: effectiveEffortOf(providers, aux, auxEffort) },
							classifierTimeoutMs: timeoutMs,
							plannerGuidance: guidance,
							extraPrompt,
							complexKeywords: keywordsText.split(/[,，;；、\s]+/u).map((word) => word.trim()).filter((word) => word.length > 0),
						}),
					});
					const payload = await response.json().catch(() => null);
					if (payload?.ok === true) {
						// the save re-applies the plugin, which closes every open status
						// stream: each conversation reconnects and re-reads its own switch
						setStatus('saved');
					} else {
						setStatus(`error:${payload?.error ?? response.status}`);
					}
				} catch {
					setStatus('error:network');
				} finally {
					setSaving(false);
				}
			};

			if (loadFailed) return h('div', null, h('p', { style: { color: 'var(--dsw-alias-label-secondary, #666)' } }, t.loadFailed));
			if (data === null) return h('div', null, h('p', { style: { color: 'var(--dsw-alias-label-secondary, #666)' } }, t.loading));

			const providers = data.providers ?? [];
			const bothConfigured = primary !== '' && aux !== '';
			const styles = {
				page: { display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '14px', lineHeight: '22px', maxWidth: 640 },
				title: { margin: 0, fontSize: '16px', fontWeight: 600 },
				description: { margin: 0, color: 'var(--dsw-alias-label-secondary, #666)' },
				card: {
					display: 'flex', flexDirection: 'column', gap: '14px',
					padding: '16px',
					border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
					borderRadius: '12px',
					background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03))',
				},
				row: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
				checkRow: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
				shortcutRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
				shortcutKey: {
					padding: '3px 10px', borderRadius: '6px',
					border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.15))',
					background: 'var(--dsw-alias-bg-layer-2, transparent)',
					fontSize: '12px', lineHeight: '18px',
				},
				shortcutHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)' },
				hint: {
					margin: 0, padding: '10px 12px',
					borderLeft: '3px solid var(--dsw-alias-brand-primary, #4176e6)',
					background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03))',
					fontSize: '13px',
				},
				hintTitle: { margin: '0 0 4px', fontWeight: 600 },
				hintBody: { margin: 0 },
				actions: { display: 'flex', alignItems: 'center', gap: '12px' },
				button: {
					padding: '8px 18px', borderRadius: '8px', border: 'none', cursor: 'pointer',
					fontSize: '13px', fontWeight: 500,
					background: 'var(--dsw-alias-brand-primary, #4176e6)',
					color: '#fff',
				},
				statusOk: { fontSize: '13px', color: 'var(--dsw-alias-state-success-primary, #2e9e5b)' },
				statusError: { fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #ec1313)' },
				warn: { fontSize: '13px', color: 'var(--dsw-alias-state-warn-primary, #f59e0b)', margin: 0 },
				numberInput: {
					padding: '8px 10px', borderRadius: '8px', width: 120,
					border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.15))',
					background: 'var(--dsw-alias-bg-layer-2, transparent)',
					color: 'inherit', fontSize: '13px',
				},
				extraPromptInput: {
					padding: '8px 10px', borderRadius: '8px', width: '100%', boxSizing: 'border-box',
					border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.15))',
					background: 'var(--dsw-alias-bg-layer-2, transparent)',
					color: 'inherit', fontSize: '13px', fontFamily: 'inherit', lineHeight: '20px',
					resize: 'vertical',
				},
				extraPromptHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)' },
				enabledHint: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)' },
			};

			return h('div', { style: styles.page },
				h('h3', { style: styles.title }, t.title),
				h('p', { style: styles.description }, t.description),
				h('div', { style: styles.card },
					h('label', { style: styles.checkRow },
						h('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }),
						h('span', { style: { fontWeight: 500 } }, t.enabledLabel)),
					h('p', { style: styles.enabledHint }, t.enabledHint),
					h('div', { style: styles.shortcutRow },
						h('span', { style: { fontSize: '13px', fontWeight: 500 } }, t.shortcutLabel),
						h('span', { style: styles.shortcutKey }, keycapTextOf(keys) !== '' ? keycapTextOf(keys) : t.shortcutUnbound),
						h('span', { style: styles.shortcutHint }, t.shortcutHint)),
					h('div', { style: styles.row },
					h(RoutePicker, {
						label: t.primaryLabel,
						value: primary,
						effort: primaryEffort,
						providers,
						placeholder: t.notSet,
						onChange: (value) => {
							setPrimary(value);
							const model = findModel(providers, parseRouteValue(value));
							if (model?.efforts !== undefined && !model.efforts.includes(primaryEffort)) setPrimaryEffort('');
						},
						onEffortChange: setPrimaryEffort,
						effortLabel: t.effortLabel,
						effortDefaultLabel: t.effortDefault,
					}),
					h(RoutePicker, {
						label: t.auxLabel,
						value: aux,
						effort: auxEffort,
						providers,
						placeholder: t.notSet,
						onChange: (value) => {
							setAux(value);
							const model = findModel(providers, parseRouteValue(value));
							if (model?.efforts !== undefined && !model.efforts.includes(auxEffort)) setAuxEffort('');
						},
						onEffortChange: setAuxEffort,
						effortLabel: t.effortLabel,
						effortDefaultLabel: t.effortDefault,
					})),
					h('div', { style: styles.row },
						h('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
							h('span', { style: { fontSize: '13px', fontWeight: 500 } }, t.timeoutLabel),
							h('input', {
								type: 'number', min: 1000, max: 120000, step: 500,
								value: timeoutMs,
								onChange: (event) => setTimeoutMs(Number(event.target.value)),
								style: styles.numberInput,
							})),
						h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
							h('span', { style: { fontSize: '13px', fontWeight: 500 } }, t.keywordsLabel),
							h('input', {
								type: 'text',
								value: keywordsText,
								placeholder: t.keywordsPlaceholder,
								onChange: (event) => setKeywordsText(event.target.value),
								style: {
									padding: '8px 10px', borderRadius: '8px',
									border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.15))',
									background: 'var(--dsw-alias-bg-layer-2, transparent)',
									color: 'inherit', fontSize: '13px',
								},
							})),
						h('label', { style: { ...styles.checkRow, alignSelf: 'flex-start' } },
							h('input', { type: 'checkbox', checked: guidance, onChange: (event) => setGuidance(event.target.checked) }),
							h('span', { style: { fontSize: '13px' } }, t.guidanceLabel))),
					h('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
						h('span', { style: { fontSize: '13px', fontWeight: 500 } }, t.extraPromptLabel),
						h('textarea', {
							value: extraPrompt,
							placeholder: t.extraPromptPlaceholder,
							rows: 5,
							onChange: (event) => setExtraPrompt(event.target.value),
							style: styles.extraPromptInput,
						}),
						h('span', { style: styles.extraPromptHint }, t.extraPromptHint)),
					enabled && !bothConfigured ? h('p', { style: styles.warn }, t.unconfigured) : null,
					h('div', { style: styles.actions },
						h('button', {
							type: 'button',
							style: styles.button,
							disabled: saving || (enabled && !bothConfigured),
							onClick: save,
						}, saving ? t.saving : t.save),
						status === 'saved' ? h('span', { style: styles.statusOk }, t.saved) : null,
						status !== null && status !== 'saved' ? h('span', { style: styles.statusError }, `${t.saveFailed}: ${status.replace(/^error:/, '')}`) : null)),
				h('div', { style: styles.hint },
					h('p', { style: styles.hintTitle }, t.hintTitle),
					h('p', { style: styles.hintBody }, t.hintBody)));
		}

		/** Route value state helper: '' or 'provider::model'. */
		function useStateRoute(initial) {
			const [value, setValue] = _react.useState(initial);
			return [value, setValue];
		}
		//#endregion
		//#region client/index.mjs
		const name = PLUGIN_ID;
		// `slots` is a real cordis service (provided by
		// @deepseek-ai/dsh-client-ui-renderer), and the context proxy REFUSES an
		// undeclared read: `ctx.slots` without injection throws "cannot get
		// property \"slots\" without inject" and the whole client half fails to
		// activate. Declare it like every shipped slots-using bundle does.
		//
		// `remote.session` is the same rule one level deeper: the model directory
		// service returned by `ctx.get('modelDirectories')` is bound to THIS
		// context, so `directoryFor()` reads `remote.session` through our own
		// tracker proxy while it materializes a session's directory (a provider
		// catalog read). Undeclared, that read throws, `directoryStoreOf` returns
		// undefined, and every surface silently falls back to the provider-owned
		// model id. `remote` and `sessions` are declared with it because they are
		// the same access path (`remote.session`, and the session scope the
		// directory resolves for its session binding).
		const inject = ['slots', 'sessions', 'remote', 'remote.session'];

		/**
		 * Classify one about-to-be-sent prompt and record its route on the host.
		 *
		 * The harness captures a step's model selection before `agent/pre-step`
		 * runs, so a route decided during a step can only reach the step after it.
		 * Holding the submission for one classification round trip is therefore the
		 * only way the FIRST request of a turn already uses the routed model.
		 *
		 * Every failure path is silent: routing must never delay a send beyond its
		 * wait bound, and never break one — the host's pre-step listener still
		 * routes from the next step on.
		 */
		async function routeBeforeSend(sessionId, text) {
			if (typeof sessionId !== 'string' || sessionId.length === 0) return;
			// A send the user typed into the conversation on screen is a stronger hint
			// than focus; a programmatic send to a conversation that is NOT rendered
			// (another session's prompt, a background delivery) must not drag the
			// global surfaces — the model-seat takeover — onto that conversation.
			if (isConversationOnScreen(sessionId)) setActiveSession(sessionId);
			// THIS conversation's switch, not the profile default: a conversation the
			// user switched off must not pay a classification round trip, and one
			// switched on by hand must get its first step routed even when the
			// default is off. A conversation this page has never seen falls back to
			// the profile default (see `routeGateEnabled`).
			if (!routeGateEnabled(sessionId)) return;
			if (typeof text !== 'string' || text.trim().length === 0) return;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), routeWaitMs);
			try {
				await fetch(ROUTE_ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId, text: text.slice(0, ROUTE_TEXT_LIMIT) }),
					signal: controller.signal,
				});
			} catch {
				// offline, unauthenticated, timed out, or a host without this route:
				// the prompt goes out exactly as it would have without the plugin
			} finally {
				clearTimeout(timer);
			}
		}

		/**
		 * Conversation-service prototypes this plugin already wrapped, mapped to
		 * the releases that undo them.
		 *
		 * Keyed by prototype, never by the service object: `ctx.get`/`inject`
		 * reads run through cordis's tracker proxy, which mints a NEW Proxy on
		 * every read, so the instance identity always differs and a WeakSet of
		 * services would never dedup — a second apply would stack a second
		 * wrapper and a dead generation's closure would survive the teardown.
		 */
		const routedPrototypes = new WeakMap();

		/**
		 * Hold one conversation-service send until the prompt's route is recorded.
		 * The service is only readable (never declared in `inject`), so the wrapper
		 * is installed on the instance and removed again on teardown. Property
		 * writes and reads go through the service tracker proxy: the write lands on
		 * the shared instance, and forwarding the call with the caller's own `this`
		 * preserves the per-call context rebinding every method relies on.
		 * @param ctx - this plugin's apply context.
		 */
		function installPromptRouting(ctx) {
			ctx.inject(['conversation'], (scope) => {
				const service = scope.conversation;
				if (service === undefined || service === null) return undefined;
				const prototype = Object.getPrototypeOf(service);
				if (prototype === null || routedPrototypes.has(prototype)) return undefined;
				const releases = [];
				for (const [method, sessionIdOf] of [
					['sendSession', (args) => args[0]?.sessionId],
					['send', function () {
						try {
							return this.scopeId('send');
						} catch {
							return undefined;
						}
					}],
				]) {
					// Prefer an OWN property: another plugin (or a previous apply)
					// may already own a wrapper here, and calling the raw prototype
					// method would silently skip it for as long as this plugin is
					// loaded. The saved descriptor restores whatever we displaced.
					const previous = Object.getOwnPropertyDescriptor(service, method);
					const original = typeof previous?.value === 'function' ? previous.value : prototype?.[method];
					if (typeof original !== 'function') continue;
					// `send(text)` carries the prompt first; `sendSession(session, text, …)`
					// carries it second
					const textIndex = method === 'send' ? 0 : 1;
					const wrapper = async function (...args) {
						try {
							const sessionId = sessionIdOf.call(this, args);
							await routeBeforeSend(sessionId, args[textIndex]);
						} catch {
							// routing never stands between the user and their message
						}
						return original.apply(this, args);
					};
					service[method] = wrapper;
					releases.push(() => {
						// a later wrapper from someone else owns the property now
						if (service[method] !== wrapper) return;
						if (previous === undefined) delete service[method];
						else Object.defineProperty(service, method, previous);
					});
				}
				if (releases.length === 0) return undefined;
				routedPrototypes.set(prototype, releases);
				return () => {
					if (routedPrototypes.get(prototype) === releases) routedPrototypes.delete(prototype);
					for (const release of releases) {
						try {
							release();
						} catch {
							// a property someone else already restored needs no further work
						}
					}
				};
			});
		}

		function apply(ctx) {
			pluginCtx = ctx;
			// Prompt-time routing rides the composer's own submission path; a host
			// without it (or a client build without that service) simply keeps the
			// pre-step fallback.
			installPromptRouting(ctx);
			// Read the profile default (classifier budget, settings surfaces) without
			// waiting for a conversation. Each conversation's own switch arrives with
			// its stream, primed as soon as the conversation becomes active.
			void refreshDefaultState();

			// Which conversation the global surfaces follow. The DOM is the only
			// authority available to a client plugin: the renderer's containers carry
			// `data-conversation-session`, which is exactly how the shipped stop
			// shortcut finds the conversation a key event belongs to.
			ctx.effect(() => {
				const doc = typeof document === 'undefined' ? undefined : document;
				if (doc === undefined || typeof doc.addEventListener !== 'function') return () => {};
				const sniff = (event) => {
					const target = event?.target;
					const holder = typeof target?.closest === 'function' ? target.closest('[data-conversation-session]') : null;
					const found = holder?.getAttribute?.('data-conversation-session');
					if (typeof found === 'string') setActiveSession(found);
				};
				doc.addEventListener('focusin', sniff, true);
				doc.addEventListener('pointerdown', sniff, true);
				// A page showing exactly one conversation needs no interaction to elect
				// it. Retried briefly: this plugin applies before the conversation
				// mounts, and the composer appears a moment later.
				let timer = null;
				let attempts = 0;
				const seed = () => {
					timer = null;
					if (activeSession.value !== undefined) return;
					const holders = typeof doc.querySelectorAll === 'function'
						? doc.querySelectorAll('[data-conversation-session]')
						: [];
					if (holders.length === 1) {
						const found = holders[0]?.getAttribute?.('data-conversation-session');
						if (typeof found === 'string') setActiveSession(found);
						return;
					}
					if (attempts < 20) {
						attempts += 1;
						timer = setTimeout(seed, 500);
					}
				};
				seed();
				return () => {
					doc.removeEventListener('focusin', sniff, true);
					doc.removeEventListener('pointerdown', sniff, true);
					if (timer !== null) clearTimeout(timer);
				};
			}, 'dsh-dual-model-router: active conversation');

			// The active conversation's state is what the seat follows, so ask for it
			// as soon as one is elected — including the one the seed above just
			// elected, which happened before this listener existed.
			ctx.effect(() => {
				const off = subscribeActiveSession((sessionId) => hub.prime(sessionId));
				hub.prime(activeSession.value);
				return off;
			}, 'dsh-dual-model-router: active conversation state');

			ctx.effect(() => () => {
				modelDirectories = undefined;
			}, 'dsh-dual-model-router: model directory handle');

			// The toggle command is editable in Settings → General → Shortcuts.
			// A dynamic client plugin reads an undeclared service through
			// `ctx.get`, so a shortcut registry that mounts later (or is absent)
			// only delays or drops the command — never the rest of the plugin.
			ctx.effect(() => {
				let cancelled = false;
				let timer = null;
				let attempts = 0;
				let dispose = null;
				let offCatalog = null;

				const teardown = () => {
					if (offCatalog !== null) {
						try {
							offCatalog();
						} catch {
							// a dropped subscription needs no further work
						}
						offCatalog = null;
					}
					if (dispose !== null) {
						try {
							dispose();
						} catch {
							// an already-removed command needs no further work
						}
						dispose = null;
					}
					setShortcutKeys([]);
				};

				const publish = (shortcuts) => {
					try {
						const entry = shortcuts.catalog?.getSnapshot?.().find((row) => row.id === SHORTCUT_ID);
						setShortcutKeys(Array.isArray(entry?.keys) ? [...entry.keys] : []);
					} catch {
						setShortcutKeys([]);
					}
				};

				const install = () => {
					timer = null;
					if (cancelled || dispose !== null) return;
					let shortcuts;
					try {
						shortcuts = ctx.get('shortcuts');
					} catch {
						shortcuts = undefined;
					}
					if (shortcuts === undefined || typeof shortcuts.register !== 'function') {
						if (attempts < 20) {
							attempts += 1;
							timer = setTimeout(install, 500);
						}
						return;
					}
					try {
						dispose = shortcuts.register({
							id: SHORTCUT_ID,
							label: () => copy().shortcutAction,
							aliases: ['dual-model router', 'auto routing', '双模型路由', '自动路由'],
							defaults: SHORTCUT_DEFAULTS,
							regions: ['page', 'editable'],
							modals: [],
							resolve: (context) => {
								// The command is page-wide, so the conversation comes from the input
								// element the key event arrived on (a native menu activation carries
								// none) and falls back to the active conversation. With neither, the
								// key is not consumed: swallowing it would hide a dead command.
								const sessionId = sessionIdOfNode(context?.target) ?? activeSession.value;
								if (sessionId === undefined) return { status: 'pass' };
								return {
									status: 'handled',
									run: () => {
										setActiveSession(sessionId);
										void toggleRouter(sessionId).catch(() => {});
									},
								};
							},
						});
					} catch (error) {
						// a taken default binding must not take the plugin down:
						// the command stays out of the catalog and the rest works
						console.warn('[dsh-dual-model-router] toggle shortcut unavailable:', error);
						return;
					}
					try {
						if (typeof shortcuts.catalog?.subscribe === 'function') {
							offCatalog = shortcuts.catalog.subscribe(() => publish(shortcuts));
						}
					} catch {
						offCatalog = null;
					}
					publish(shortcuts);
				};

				install();
				return () => {
					cancelled = true;
					if (timer !== null) clearTimeout(timer);
					timer = null;
					teardown();
				};
			}, 'dsh-dual-model-router: toggle shortcut');


			ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'dual-model-router',
				order: 65,
				label: () => copy().nav,
			}, SettingsPage)), 'dsh-dual-model-router: settings page');

			// Resident on/off switch, immediately left of the model seat.
			ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
				name: 'conversation.input.right',
				id: 'dual-model-router-toggle',
				order: 50,
			}, RouterStatusPill)), 'dsh-dual-model-router: toggle pill');

			ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
				name: 'conversation.composer.dock',
				id: 'dual-model-router-status',
				order: 2,
			}, RoutingStatus)), 'dsh-dual-model-router: routing status indicator');

			// Model seat takeover: while the router is on, the shipped selector
			// is shadowed by this plugin's read-only model display. The entry is
			// installed only while the switch is on, so turning it off restores
			// the shipped selector without a reload — and now only while the
			// conversation the user is in has it on, since one registration shadows
			// the selector in every composer at once.
			const seat = { live: false, held: null, timer: null, attempts: 0, probe: null };

			/** Re-evaluate the takeover against the conversation that is active NOW. */
			const syncSeatNow = () => syncSeat(activeSessionEnabled());

			const clearSeatTimer = () => {
				if (seat.timer === null) return;
				clearTimeout(seat.timer);
				seat.timer = null;
			};
			const clearProbe = () => {
				const probe = seat.probe;
				seat.probe = null;
				if (typeof probe !== 'function') return;
				try {
					probe();
				} catch {
					// an already-dropped probe needs no further work
				}
			};
			/**
			 * Report a takeover anomaly as an invisible dock entry: Slot
			 * inspection reads the state off the entry id, the UI renders
			 * nothing. Dropped as soon as the takeover is in place.
			 */
			const reportSeat = (state) => {
				clearProbe();
				try {
					seat.probe = ctx.slots.register({
						name: 'conversation.composer.dock',
						id: `dual-model-router-seat-probe[${state}]`,
						order: 9,
					}, () => null);
				} catch {
					seat.probe = null;
				}
			};
			const releaseSeat = () => {
				clearSeatTimer();
				seat.attempts = 0;
				const held = seat.held;
				seat.held = null;
				if (typeof held === 'function') {
					try {
						held();
					} catch {
						// disposing an already-dropped registration is not an error
					}
				}
				clearProbe();
			};
			/** The model seat is declared: a conversation composer is on screen. */
			const seatDeclared = () => {
				try {
					return typeof ctx.slots?.spec === 'function' && ctx.slots.spec('conversation.input.model') !== undefined;
				} catch {
					return false;
				}
			};
			/**
			 * Priorities tried in order for the seat entry. A single slot refuses
			 * a second entry at the SAME priority ("register at a different
			 * priority to shadow it (lowest renders)"), and the shipped selector
			 * sits at 0, so the seat goes below it.
			 */
			const SEAT_PRIORITIES = [-1, -2, -4, -8];
			const syncSeat = (enabled) => {
				if (enabled !== true) {
					releaseSeat();
					return;
				}
				if (seat.held !== null) return;
				if (!seat.live) seat.live = seatDeclared();
				if (!seat.live) {
					// The declaration watch may not have fired for this slot (a
					// late composer, a reloaded slot): retry briefly, then stop.
					if (seat.timer === null && seat.attempts < 20) {
						seat.attempts += 1;
						seat.timer = setTimeout(() => {
							seat.timer = null;
							syncSeatNow();
						}, 500);
					}
					reportSeat(`waiting live=0 attempts=${seat.attempts}`);
					return;
				}
				let failure = null;
				for (const priority of SEAT_PRIORITIES) {
					try {
						seat.held = ctx.slots.register({ name: 'conversation.input.model', priority }, RouterModelSeat);
						failure = null;
						break;
					} catch (error) {
						seat.held = null;
						failure = error;
					}
				}
				if (seat.held !== null) {
					clearProbe();
					return;
				}
				console.warn('[dsh-dual-model-router] model seat takeover failed:', failure);
				reportSeat(`failed ${String(failure?.message ?? failure).slice(0, 120)}`);
			};
			ctx.effect(() => {
				// two triggers: the active conversation changes, or the state of the
				// conversation that is active changes (a toggle anywhere, a frame from
				// the host, another tab)
				const offActive = subscribeActiveSession(syncSeatNow);
				const offAny = hub.subscribeAny(syncSeatNow);
				return () => {
					offActive();
					offAny();
					releaseSeat();
				};
			}, 'dsh-dual-model-router: model seat switch');
			ctx.effect(() => {
				try {
					return ctx.slots.inject('conversation.input.model', () => {
						seat.live = true;
						seat.attempts = 0;
						syncSeatNow();
						return () => {
							seat.live = false;
							releaseSeat();
						};
					});
				} catch (error) {
					// a declaration watch that cannot attach must not stop the
					// switch from retrying the takeover on its own
					console.warn('[dsh-dual-model-router] model seat declaration watch failed:', error);
					reportSeat(`watch-failed ${String(error?.message ?? error).slice(0, 120)}`);
					return () => {};
				}
			}, 'dsh-dual-model-router: model seat occupancy');
		}
		//#endregion
		module.exports = { name, inject, apply };
		return module.exports;
	}
});
