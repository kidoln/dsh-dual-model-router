// Pure routing decisions for dsh-dual-model-router. No Cordis imports so the
// logic can be unit-tested standalone.

/** Whether two {provider, model} routes point at the same model. */
export function sameRoute(a, b) {
	return Boolean(a && b && a.provider === b.provider && a.model === b.model);
}

/** The route one root-agent request should use for the current task mode. */
export function pickTarget(mode, config) {
	const primary = config?.primary ?? {};
	const aux = config?.aux ?? {};
	const configured = String(primary.provider ?? '').length > 0 && String(primary.model ?? '').length > 0;
	return mode === 'complex' && configured ? primary : aux;
}

/**
 * Whether one claimed message is a human-authored prompt.
 *
 * `agent/pre-step` claims every kind of inbound message, and `role: 'user'` is
 * not authority: DSH's machine producers emit user-role messages for goal
 * auto-continuation rounds (`'goal'`), scheduled reminders (`'schedule'`),
 * runtime-context snapshots (`'runtime-context'`), agent instructions
 * (`'agent-instructions'`), model-switch notices (`'model-selection'`) and
 * agent-to-agent relays — including a subagent reporting back to its parent
 * (`'agent-message'`, `createAgentMessage`).
 *
 * The human entry points all use `kind: 'user'`: the browser prompt
 * (`user-rpc`, which tags `principal` only for a caller other than the owner),
 * ACP clients, the headless runner, the JSON-RPC SDK, and browser delivery to
 * a subagent. Only those may re-decide the task mode; otherwise a terse "done"
 * from a subagent would drop a complex task back to the cheap model mid-flight
 * and silently drop the planner guidance with it.
 *
 * Owner-only is deliberate, and the `principal` tag is exactly how a non-owner
 * caller is recognized: `principalOf()` returns a principal only for a caller
 * other than the owner. A shared/remote caller therefore never re-decides this
 * session's mode — and never reaches the prompt-time route either, which is
 * owner-gated (see index.js `rejectionOf(…, { owner: true })`). Its prompts run
 * on the session's current selection.
 *
 * @returns {boolean} true only for a prompt the owner authored.
 */
export function isHumanPrompt(message) {
	if (message?.role !== 'user') return false;
	const source = message.source;
	// a message predating the source tag stays routable
	if (source === undefined || source === null) return true;
	if (source.kind !== 'user') return false;
	return source.principal === undefined;
}

/** Concatenated text blocks of one user message. */
export function userTextOf(message) {
	const blocks = message?.content;
	if (!Array.isArray(blocks)) return '';
	return blocks
		.filter((block) => block?.type === 'text')
		.map((block) => (typeof block.text === 'string' ? block.text : ''))
		.join('\n');
}

const ASCII_ONLY = /^[\x20-\x7e]+$/u;
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/gu;
/** Word/non-word edges of one keyword, for edge-aware boundary assertions. */
const WORD_START = /^\w/u;
const WORD_END = /\w$/u;

/**
 * Keyword override: any configured keyword hit forces a complex verdict.
 * Pure-ASCII keywords match on word boundaries (so "hard" does not hit
 * "hardware"); other keywords match as case-insensitive substrings.
 *
 * `\b` asserts a word/non-word transition, so it can never hold when the
 * keyword's own edge character is not a word character: a bare `\bc\+\+\b`
 * fails on every input, and `c++`, `C#`, `.net` and `@scope` would be silent
 * no-ops. Each edge therefore uses `\b` only when that edge really is a word
 * character, and a non-word lookaround otherwise.
 *
 * @returns {string | undefined} the keyword that hit, if any.
 */
export function keywordHit(text, keywords) {
	const haystack = String(text ?? '');
	const list = Array.isArray(keywords) ? keywords : [];
	for (const keyword of list) {
		const needle = String(keyword ?? '').trim();
		if (needle.length === 0) continue;
		if (ASCII_ONLY.test(needle)) {
			const escaped = needle.replace(REGEX_ESCAPE, '\\$&');
			const left = WORD_START.test(needle) ? '\\b' : '(?<![\\w])';
			const right = WORD_END.test(needle) ? '\\b' : '(?![\\w])';
			const pattern = new RegExp(`${left}${escaped}${right}`, 'iu');
			if (pattern.test(haystack)) return needle;
		} else if (haystack.toLowerCase().includes(needle.toLowerCase())) {
			return needle;
		}
	}
	return undefined;
}
