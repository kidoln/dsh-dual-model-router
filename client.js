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
			enabledLabel: 'Enable automatic model switching',
			primaryLabel: 'Primary model (strong · plans complex tasks)',
			auxLabel: 'Auxiliary model (fast · classifies, executes, answers simple tasks)',
			timeoutLabel: 'Classifier timeout (ms)',
			guidanceLabel: 'Inject planner guidance for complex tasks',
			keywordsLabel: 'Complex-task keywords (comma separated; any hit forces complex, no LLM call)',
			keywordsPlaceholder: 'e.g. hard, refactor, deep-dive',
			effortLabel: 'Reasoning effort',
			effortDefault: 'Default (model own)',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved — applied immediately',
			saveFailed: 'Save failed',
			loading: 'Loading…',
			loadFailed: 'Could not read the plugin configuration.',
			hintTitle: 'How it works',
			hintBody: 'Every new message is first classified by the auxiliary model. Simple tasks run entirely on the auxiliary model; complex tasks are planned by the primary model, which delegates execution steps to subagents running on the auxiliary model. While this is on, the composer\'s model control is locked and shows the model the router is using; a model you pick yourself through the /model command still wins.',
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
			enabledLabel: '启用自动模型切换',
			primaryLabel: '主模型（强 · 规划复杂任务）',
			auxLabel: '辅助模型（快 · 判别 / 执行 / 简单任务）',
			timeoutLabel: '判别超时（毫秒）',
			guidanceLabel: '复杂任务时注入规划者指引',
			keywordsLabel: '复杂任务关键词（逗号分隔；命中即判复杂，跳过判别调用）',
			keywordsPlaceholder: '例如：hard, 深度分析, 重构',
			effortLabel: '思考强度',
			effortDefault: '默认（模型自身）',
			save: '保存',
			saving: '保存中…',
			saved: '已保存，立即生效',
			saveFailed: '保存失败',
			loading: '加载中…',
			loadFailed: '读取插件配置失败。',
			hintTitle: '工作方式',
			hintBody: '每条新消息先由辅助模型判别难度：简单任务全程走辅助模型；复杂任务由主模型规划，并把执行步骤委派给运行在辅助模型上的子智能体。开启后输入框下方的模型控件被锁定，只显示路由当前使用的模型；你通过 /model 手动选择的模型仍然优先。',
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
			pillOnTitle: 'Dual-model routing is ON. Click, or press {keys}, to switch it off.',
			pillOffTitle: 'Dual-model routing is OFF. Click, or press {keys}, to switch it on.',
			pillOnTitleNoKeys: 'Dual-model routing is ON. Click to switch it off.',
			pillOffTitleNoKeys: 'Dual-model routing is OFF. Click to switch it on.',
			pillFailed: 'Could not switch dual-model routing: {error}',
			seatManual: 'manual',
			seatAutoTitle: 'Dual-model routing is driving this conversation: the current request uses {model} ({mode} task). The composer model control follows the router; switch the router off to choose a model yourself.',
			seatManualTitle: 'Dual-model routing is on, but this conversation uses the model you selected manually: {model}.',
			modeComplex: 'complex',
			modeSimple: 'simple',
		};

		const ZH_ROUTER = {
			pillLabel: '自动路由',
			pillBusy: '切换中…',
			pillOnTitle: '双模型路由已开启。点击或按 {keys} 关闭。',
			pillOffTitle: '双模型路由已关闭。点击或按 {keys} 开启。',
			pillOnTitleNoKeys: '双模型路由已开启。点击关闭。',
			pillOffTitleNoKeys: '双模型路由已关闭。点击开启。',
			pillFailed: '切换双模型路由失败：{error}',
			seatManual: '手动',
			seatAutoTitle: '双模型路由正在驱动本对话：当前请求使用 {model}（{mode}任务）。此处模型控件由路由接管，关闭路由后即可自行选择模型。',
			seatManualTitle: '双模型路由已开启，但本对话使用的是你手动选择的模型：{model}。',
			modeComplex: '复杂',
			modeSimple: '简单',
		};

		const EN_INDICATOR = {
			classifying: 'auxiliary model is classifying…',
			autoSimple: (model) => `simple task · auxiliary model ${model}`,
			autoComplex: (model) => `complex task · primary model ${model} plans, auxiliary executes`,
			subagent: (model) => `subagent · auxiliary model ${model}`,
			manual: (model) => `manual model ${model} · auto routing deferred`,
		};

		const ZH_INDICATOR = {
			classifying: '辅助模型判别任务难度…',
			autoSimple: (model) => `简单任务 · 辅助模型 ${model}`,
			autoComplex: (model) => `复杂任务 · 主模型 ${model} 规划，辅助模型执行`,
			subagent: (model) => `子代理 · 辅助模型 ${model}`,
			manual: (model) => `手动模型 ${model} · 自动路由未接管`,
		};

		const DOT_COLORS = {
			classifying: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
			autoSimple: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
			autoComplex: 'var(--dsw-alias-brand-primary, #4176e6)',
			subagent: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
			manual: 'var(--dsw-alias-state-idle-primary, #999)',
		};

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
		const sameRoute = (a, b) => Boolean(a && b && a.provider === b.provider && a.model === b.model);

		/** Nothing known about this conversation yet. */
		const EMPTY_SESSION = Object.freeze({
			ready: false,
			enabled: undefined,
			primary: null,
			aux: null,
			defaultSelection: null,
			status: null,
		});

		/**
		 * One SSE connection per live conversation, shared by every surface of
		 * this plugin (the composer pill, the model seat, the routing pill).
		 * Frames carry the applied config, so a toggle made anywhere — the
		 * shortcut, the pill, the settings page, another browser tab — reaches
		 * every surface as soon as the host re-applies and the stream reconnects.
		 */
		function createSessionHub() {
			const values = new Map();
			const listeners = new Map();
			const sources = new Map();

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

			const patch = (sessionId, next) => {
				values.set(sessionId, { ...stateOf(sessionId), ...next });
				notify(sessionId);
			};

			const applyFrame = (sessionId, frame) => {
				if (frame?.type === 'init') {
					// the global switch first: the model seat reacts to it
					setRouterEnabled(frame.enabled);
					adoptClassifierBudget(frame);
					patch(sessionId, {
						ready: true,
						enabled: frame.enabled === true,
						primary: frame.primary ?? null,
						aux: frame.aux ?? null,
						defaultSelection: frame.defaultSelection ?? null,
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
				/** Optimistic local flip while the host round-trip settles. */
				patchAll(next) {
					for (const sessionId of [...values.keys()]) patch(sessionId, next);
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

		/** Config-level switch, known before any conversation reports one. */
		const routerEnabled = { value: undefined, listeners: new Set() };

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

		function setRouterEnabled(value) {
			if (typeof value !== 'boolean') return;
			if (routerEnabled.value === value) return;
			routerEnabled.value = value;
			for (const listener of [...routerEnabled.listeners]) {
				try {
					listener();
				} catch {
					// a broken listener must not stop the switch from landing
				}
			}
		}

		const subscribeRouterEnabled = (listener) => {
			routerEnabled.listeners.add(listener);
			return () => {
				routerEnabled.listeners.delete(listener);
			};
		};
		const snapshotRouterEnabled = () => routerEnabled.value;

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

		/** Optional camera on the plugin's own model seat for the session selection. */
		let pluginCtx;
		let modelDirectories;
		const selectionCache = new WeakMap();

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

		/** The session's durable selection, cached so uSES sees a stable value. */
		const selectionOf = (store) => {
			let raw = null;
			try {
				raw = store.getSnapshot?.()?.current ?? null;
			} catch {
				raw = null;
			}
			const cached = selectionCache.get(store);
			if (cached !== undefined && cached.raw === raw) return cached.value;
			const value = (raw !== null && typeof raw.model === 'string' && raw.model.length > 0)
				? { provider: String(raw.provider ?? ''), model: raw.model }
				: null;
			selectionCache.set(store, { raw, value });
			return value;
		};

		/** No catalog read yet; one stable array so a subscriber never sees a fresh identity. */
		const EMPTY_GROUPS = [];

		/**
		 * The session catalog's provider groups, read from the same directory
		 * store the shipped selector builds. Used only to turn a provider-owned
		 * model id into the name the selector itself would print: an unavailable
		 * catalog just leaves the id as the label.
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

		/** Read the applied config without waiting for a conversation (JSON snapshot). */
		async function refreshRouterState() {
			try {
				const response = await fetch(STATUS_ENDPOINT, {
					cache: 'no-store',
					headers: { accept: 'application/json' },
				});
				if (!response.ok) return;
				const frame = await response.json();
				setRouterEnabled(frame?.enabled);
				adoptClassifierBudget(frame);
			} catch {
				// offline or unauthenticated: the SSE frames still carry the switch
			} finally {
				// The composer switch is resident, so an unknown state must still
				// render: "off" is its safe face (no seat takeover) until a frame
				// or a click reports the truth.
				if (snapshotRouterEnabled() === undefined) setRouterEnabled(false);
			}
		}

		let toggleInFlight = null;

		/** Flip the router through the host row; resolves to the new state. */
		function toggleRouter() {
			if (toggleInFlight !== null) return toggleInFlight;
			toggleInFlight = (async () => {
				try {
					const response = await fetch(TOGGLE_ENDPOINT, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: '{}',
					});
					const payload = await response.json().catch(() => null);
					if (payload?.ok !== true || typeof payload.enabled !== 'boolean') {
						throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
					}
					setRouterEnabled(payload.enabled);
					hub.patchAll({ enabled: payload.enabled });
					void refreshRouterState();
					return payload.enabled;
				} finally {
					toggleInFlight = null;
				}
			})();
			return toggleInFlight;
		}

		/** Resolve the conversation a surface renders in, with a DOM fallback. */
		function useSessionId(sessionIdProp, nodeRef) {
			const [sniffed, setSniffed] = _react.useState(undefined);
			_react.useEffect(() => {
				if (sessionIdProp !== undefined) return undefined;
				const node = nodeRef.current;
				const found = typeof node?.closest === 'function'
					? node.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')
					: undefined;
				if (found !== undefined && found !== null) setSniffed((current) => (current === found ? current : found));
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

		/** The conversation's durable model selection (null when unavailable). */
		function useSessionSelection(sessionId) {
			const store = directoryStoreOf(sessionId);
			const subscribe = _react.useMemo(
				() => (store === undefined || typeof store.subscribe !== 'function' ? NOOP_SUBSCRIBE : (listener) => store.subscribe(listener)),
				[store],
			);
			const getSnapshot = _react.useMemo(
				() => () => (store === undefined ? null : selectionOf(store)),
				[store],
			);
			return useSyncStore(subscribe, getSnapshot);
		}

		/** The conversation's model catalog groups (empty until the catalog loads). */
		function useSessionGroups(sessionId) {
			const store = directoryStoreOf(sessionId);
			const subscribe = _react.useMemo(
				() => (store === undefined || typeof store.subscribe !== 'function' ? NOOP_SUBSCRIBE : (listener) => store.subscribe(listener)),
				[store],
			);
			const getSnapshot = _react.useMemo(() => () => groupsOf(store), [store]);
			return useSyncStore(subscribe, getSnapshot);
		}

		/**
		 * What this conversation is running on right now: the router's own
		 * decision while it drives, the user's durable pick while it defers.
		 */
		const currentRouteOf = (session, selection) => {
			const primary = session.primary ?? null;
			const aux = session.aux ?? null;
			const status = session.status;
			const routed = status?.route && status.route.model ? status.route : null;
			const manual = selection !== null
				&& session.defaultSelection !== null
				&& !sameRoute(selection, session.defaultSelection)
				&& !(status?.kind === 'auto' && sameRoute(selection, routed));
			if (manual) return { provider: selection.provider, model: selection.model, manual: true, mode: 'simple' };
			if (routed !== null && status?.kind !== 'manual') {
				return { provider: routed.provider ?? '', model: routed.model, manual: false, mode: status?.mode === 'complex' ? 'complex' : 'simple' };
			}
			if (routed !== null) return { provider: routed.provider ?? '', model: routed.model, manual: true, mode: 'simple' };
			const mode = status?.mode === 'complex' ? 'complex' : 'simple';
			const target = mode === 'complex' ? primary : aux;
			if (target === null || !target.model) return null;
			return { provider: target.provider, model: target.model, manual: false, mode };
		};
		//#endregion
		//#region client/status-pill.mjs
		/**
		 * Resident on/off switch at the left of the composer's model seat: the
		 * same control the config flag drives, so it is never out of date with
		 * what the router does.
		 */
		function RouterStatusPill({ sessionId: sessionIdProp }) {
			const t = routerCopy();
			const nodeRef = _react.useRef(null);
			const sessionId = useSessionId(sessionIdProp, nodeRef);
			const session = useSessionState(sessionId);
			const globalEnabled = useSyncStore(subscribeRouterEnabled, snapshotRouterEnabled);
			const keys = useSyncStore(subscribeShortcutKeys, snapshotShortcutKeys);
			const [pending, setPending] = _react.useState(false);
			const [failure, setFailure] = _react.useState(null);
			const failureTimer = _react.useRef(null);
			_react.useEffect(() => () => {
				if (failureTimer.current !== null) clearTimeout(failureTimer.current);
			}, []);

			const enabled = globalEnabled === undefined ? session.enabled : globalEnabled;

			const toggle = () => {
				if (pending) return;
				setPending(true);
				setFailure(null);
				toggleRouter()
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
			const selection = useSessionSelection(sessionId);
			const groups = useSessionGroups(sessionId);
			const route = currentRouteOf(session, selection);

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
			const title = (route.manual ? t.seatManualTitle : t.seatAutoTitle)
				.replace('{model}', route.provider.length > 0 ? `${route.provider}/${modelLabel}` : modelLabel)
				.replace('{mode}', mode);

			return h('span', {
				ref,
				title,
				'aria-label': title,
				'data-dual-model-router-seat': route.manual ? 'manual' : 'auto',
				style: {
					display: 'inline-flex', alignItems: 'center', gap: '6px',
					maxWidth: '260px', padding: '4px 8px', borderRadius: '8px',
					color: 'var(--dsw-alias-label-secondary, #666)',
					fontSize: '13px', lineHeight: '16px', cursor: 'default',
				},
			},
				h('svg', {
					width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true,
					style: { flex: 'none', color: route.manual ? 'var(--dsw-alias-state-warn-primary, #f59e0b)' : 'var(--dsw-alias-brand-primary, #4176e6)' },
				},
					h('path', {
						d: 'M2 4.5h3l6 7h3M2 11.5h3l1.7-2M14 4.5h-3l-1.7 2',
						fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
					})),
				h('span', {
					style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary, inherit)' },
				}, modelLabel),
				// while the router drives the seat every model is router-chosen, so
				// a chip would carry no information — only a manual pick is news
				route.manual ? h('span', {
					style: {
						flex: 'none', padding: '0 5px', borderRadius: '999px',
						border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))',
						fontSize: '11px', lineHeight: '15px',
						color: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
					},
				}, t.seatManual) : null);
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
			const globalEnabled = useSyncStore(subscribeRouterEnabled, snapshotRouterEnabled);
			const enabled = globalEnabled === undefined ? session.enabled : globalEnabled;
			const status = session.status;

			if (enabled !== true || status === null || status === undefined) return null;

			// the catalog's display name, not the raw provider-owned id
			const model = modelLabelOf(groups, status.route?.provider ?? '', status.route?.model ?? '');
			// `kind` is the protocol value the host emits ('auto'), while the
			// palette is keyed by the surface it describes: an auto route must be
			// tinted by its mode, not fall through to the neutral manual dot.
			const dotKey = status.kind === 'auto'
				? (status.mode === 'complex' ? 'autoComplex' : 'autoSimple')
				: status.kind;
			const color = DOT_COLORS[dotKey] ?? DOT_COLORS.manual;
			let text = '';
			if (status.kind === 'classifying') text = t.classifying;
			else if (status.kind === 'auto' && status.mode === 'complex') text = t.autoComplex(model);
			else if (status.kind === 'auto') text = t.autoSimple(model);
			else if (status.kind === 'subagent') text = t.subagent(model);
			else if (status.kind === 'manual') text = t.manual(model);
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
							complexKeywords: keywordsText.split(/[,，;；、\s]+/u).map((word) => word.trim()).filter((word) => word.length > 0),
						}),
					});
					const payload = await response.json().catch(() => null);
					if (payload?.ok === true) {
						setRouterEnabled(enabled);
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
			};

			return h('div', { style: styles.page },
				h('h3', { style: styles.title }, t.title),
				h('p', { style: styles.description }, t.description),
				h('div', { style: styles.card },
					h('label', { style: styles.checkRow },
						h('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }),
						h('span', { style: { fontWeight: 500 } }, t.enabledLabel)),
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
		const inject = ['slots'];

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
			if (snapshotRouterEnabled() !== true) return;
			if (typeof sessionId !== 'string' || sessionId.length === 0) return;
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
			// Seed the switch before any conversation subscribes, so a page that
			// boots with the router on never flashes the manual model selector.
			void refreshRouterState();

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
							resolve: () => ({
								status: 'handled',
								run: () => { void toggleRouter().catch(() => {}); },
							}),
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
			// the shipped selector without a reload.
			const seat = { live: false, held: null, timer: null, attempts: 0, probe: null };

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
							syncSeat(routerEnabled.value === true);
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
				const off = subscribeRouterEnabled(() => syncSeat(routerEnabled.value));
				return () => {
					off();
					releaseSeat();
				};
			}, 'dsh-dual-model-router: model seat switch');
			ctx.effect(() => {
				try {
					return ctx.slots.inject('conversation.input.model', () => {
						seat.live = true;
						seat.attempts = 0;
						syncSeat(routerEnabled.value);
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
