// Difficulty classifier for dsh-dual-model-router. One cheap auxiliary-model
// call per new user message, judged against the recent conversation; a failed
// attempt reports `failed` so the router can keep the mode it already had
// instead of downgrading an ongoing complex task.

const CLASSIFIER_SYSTEM = `You are the difficulty classifier of an AI coding assistant's model router.
You receive the conversation so far, the router's current mode, and the user's CURRENT message,
tagged <conversation>, <current_mode>, and <current_message>.
Decide whether the CURRENT node of work is simple or complex. Earlier user messages are context,
not new requests; judge only the CURRENT message. Reply with ONLY one JSON object and nothing else:
{"difficulty":"simple"} or {"difficulty":"complex"}

Continuity rule (most important):
- A short follow-up that continues an ongoing task inherits that task's difficulty. "继续", "go on",
  "跑一下测试", "按这个方案改", "为什么失败了", "fix that" are complex when the ongoing task is complex,
  even though they look trivial on their own.
- A clearly new, self-contained small request is simple, even right after a complex task.
- When the conversation is already a complex task and the CURRENT message is ambiguous, keep complex;
  do not downgrade a complex task on a terse continuation.

simple (简单) — quick questions, chat or greetings, lookups, formatting, single-file small edits,
  straightforward commands that stand on their own.
  Examples: "hi" · "这个报错是什么意思" · "把这个函数名改成 snake_case" · "跑一下测试" (when it starts a new, standalone request)
complex (复杂) — whole-project or cross-module analysis, architecture or design work, multi-step or
  multi-file implementation, tricky debugging, large refactors, security or correctness review, long reports.
  Examples: "帮我对整个项目做一个深度分析" · "重构数据库层并保证所有测试通过" · "设计一个新的插件系统" · "排查这个偶发的死锁"

If the user states the difficulty explicitly (例如 "这是比较难的任务"), respect that statement.
The current mode is a hint about the ongoing task, not a command: override it when the CURRENT message
clearly starts a different task.
When genuinely unsure, keep the current mode.`;

/** Longest current message sent for classification. */
const MAX_CURRENT_CHARS = 8000;
/** Most recent conversation messages kept as context. */
const MAX_HISTORY_MESSAGES = 12;
/** Total characters kept across those history messages. */
const MAX_HISTORY_CHARS = 6000;
/** Per-message cap so one long plan cannot crowd out the rest. */
const MAX_HISTORY_MESSAGE_CHARS = 1200;

/** Cache of each aux route's lowest supported reasoning effort. */
const lowestEffortCache = new Map();

/**
 * Forget every cached reasoning-effort lookup. The map is module-scoped, so a
 * profile edit, an HMR reload or a swapped adapter could otherwise leave a
 * stale effort id behind; a rejected effort makes `llm.stream` throw and would
 * pin every classification to the session's current mode (initially 'simple')
 * for the rest of the process. The plugin calls this on every apply.
 */
export function resetClassifierCaches() {
	lowestEffortCache.clear();
}

/** The route's least reasoning effort, so classification never pays for thinking. */
async function lowestReasoningEffort(llm, provider, model, signal) {
	const key = `${provider}::${model}`;
	if (lowestEffortCache.has(key)) return lowestEffortCache.get(key);
	let effort;
	try {
		const resolved = await llm.resolveModelInfo(provider, model, signal);
		effort = resolved?.reasoning?.efforts?.[0]?.id;
	} catch {
		// a failed lookup stays uncached so a transient failure retries next message
		return undefined;
	}
	lowestEffortCache.set(key, effort);
	return effort;
}

/** Clip one long history message from the middle, preserving its opening and ending. */
function clipHistoryText(text, limit) {
	if (text.length <= limit) return text;
	const marker = '\n…\n';
	if (limit <= marker.length) return text.slice(0, limit);
	const available = limit - marker.length;
	const head = Math.ceil(available / 2);
	const tail = available - head;
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

/**
 * Keep the newest conversation entries that fit the classifier's budget.
 * Entries arrive in chronological order; the oldest are dropped first, and a
 * long entry is clipped rather than dropped.
 *
 * @param history - chronological `{role, text}` entries, or any untrusted value.
 * @returns chronological entries capped by count and characters.
 */
function recentHistory(history) {
	const entries = Array.isArray(history) ? history : [];
	const kept = [];
	let chars = 0;
	for (let index = entries.length - 1; index >= 0 && kept.length < MAX_HISTORY_MESSAGES; index -= 1) {
		const entry = entries[index];
		const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : undefined;
		if (role === undefined) continue;
		const raw = String(entry?.text ?? '').trim();
		if (raw.length === 0) continue;
		const remaining = MAX_HISTORY_CHARS - chars;
		if (remaining <= 0) break;
		const clipped = clipHistoryText(raw, Math.min(MAX_HISTORY_MESSAGE_CHARS, remaining));
		kept.push({ role, text: clipped });
		chars += clipped.length;
	}
	kept.reverse();
	return kept;
}

/**
 * Render the classifier's one user turn: a bounded conversation transcript plus
 * the CURRENT message. A single labeled turn is more portable across cheap
 * providers than replaying the conversation as real assistant messages.
 *
 * @param text - the latest user message.
 * @param history - chronological recent `{role, text}` entries.
 * @param currentMode - the mode the router already assigned to this session.
 * @returns the classifier input.
 */
export function buildClassifierUserText(text, history, currentMode) {
	const current = String(text ?? '').trim().slice(0, MAX_CURRENT_CHARS);
	const kept = recentHistory(history);
	const conversation = kept.length === 0
		? '(none)'
		: kept.map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.text}`).join('\n\n');
	const mode = currentMode === 'complex' ? 'complex' : 'simple';
	return [
		'<conversation>',
		conversation,
		'</conversation>',
		'',
		`<current_mode>${mode}</current_mode>`,
		'',
		'<current_message>',
		current,
		'</current_message>',
	].join('\n');
}

/**
 * Classify one user message as 'simple' or 'complex' with the auxiliary model,
 * in the context of the conversation so far.
 *
 * @param llm - the host llm service.
 * @param config - resolved plugin config (aux route + classifierTimeoutMs).
 * @param text - the latest user message text.
 * @param options - optional classification context.
 * @param options.signal - caller cancellation (the step's own abort signal);
 *   races the classifier budget so a stopped turn stops classifying.
 * @param options.history - chronological recent `{role, text}` entries. Only
 *   the newest entries that fit the prompt budget are sent.
 * @param options.currentMode - the mode the router already assigned to this
 *   session's task; it is a hint for continuity, not a verdict.
 * @returns {Promise<{mode: 'simple' | 'complex', raw: string, failed: boolean}>}
 * difficulty, the raw model output for diagnostics, and whether the attempt
 * failed (missing route, timeout, error, empty output). A failed attempt
 * reports 'simple' so a caller with no prior keeps the cheap route; a caller
 * that already has a mode must keep its own.
 */
export async function classifyTaskText(llm, config, text, options = {}) {
	const signal = options?.signal;
	const input = String(text ?? '').trim();
	if (input.length === 0) return { mode: 'simple', raw: '', failed: false };
	const aux = config?.aux ?? {};
	const provider = String(aux.provider ?? '');
	const model = String(aux.model ?? '');
	if (!llm || provider.length === 0 || model.length === 0) {
		return { mode: 'simple', raw: '', failed: true };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config?.classifierTimeoutMs ?? 15000);
	const relayAbort = () => controller.abort();
	if (signal !== undefined) {
		if (signal.aborted === true) {
			clearTimeout(timer);
			return { mode: 'simple', raw: '', failed: true };
		}
		signal.addEventListener('abort', relayAbort, { once: true });
	}
	try {
		const effort = await lowestReasoningEffort(llm, provider, model, controller.signal);
		const stream = llm.stream({
			provider,
			model,
			...(effort !== undefined ? { reasoningEffort: effort } : {}),
			temperature: 0,
			messages: [
				{ role: 'system', content: [{ type: 'text', text: CLASSIFIER_SYSTEM }] },
				{
					role: 'user',
					content: [{ type: 'text', text: buildClassifierUserText(input, options?.history, options?.currentMode) }],
				},
			],
			signal: controller.signal,
		});
		let buffer = '';
		for await (const chunk of stream) {
			// StreamChunk (dsh-llm 0.2.x): text arrives as {type:'text-delta', text}
			if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') buffer += chunk.text;
		}
		if (buffer.trim().length === 0) return { mode: 'simple', raw: '(no text output)', failed: true };
		return { mode: parseDifficulty(buffer), raw: buffer, failed: false };
	} catch {
		// A failure may mean the cached effort is stale (a swapped adapter, an
		// edited provider); drop it so the next message re-resolves.
		lowestEffortCache.delete(`${provider}::${model}`);
		return { mode: 'simple', raw: '', failed: true };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.('abort', relayAbort);
	}
}

/**
 * Robustly read the difficulty verdict out of classifier output: the last
 * JSON field wins, then the last bare English token, then Chinese words.
 *
 * The JSON field is case-insensitive (a model may answer `"Simple"`), and it is
 * still authoritative when it appears before contradicting prose: the last
 * `difficulty` field is the verdict, never a later bare token.
 */
export function parseDifficulty(text) {
	const raw = String(text ?? '');
	const jsonMatches = [...raw.matchAll(/"difficulty"\s*:\s*"(simple|complex)"/giu)].map((m) => m[1].toLowerCase());
	if (jsonMatches.length > 0) return jsonMatches[jsonMatches.length - 1];
	let verdict = '';
	for (const match of raw.matchAll(/\b(simple|complex)\b/gi)) {
		verdict = match[1].toLowerCase();
	}
	if (verdict !== '') return verdict;
	// A negated contrast ("这个不复杂，很简单") must not read as complex.
	if (/不(?:复杂|困难|难)|没有难度|不是很难/.test(raw)) return 'simple';
	if (/复杂|困难|较难|难度高|有挑战/.test(raw)) return 'complex';
	if (/简单/.test(raw)) return 'simple';
	return 'simple';
}
