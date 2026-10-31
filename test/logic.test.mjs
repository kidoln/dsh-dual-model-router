import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClassifierUserText, classifyTaskText, parseDifficulty } from '../lib/classifier.js';
import { keywordHit, pickTarget, sameRoute, isHumanPrompt, userTextOf } from '../lib/routing.js';

const CONFIG = {
	aux: { provider: 'p', model: 'm' },
	classifierTimeoutMs: 5000,
};

/** Fake llm.stream emitting dsh-llm 0.2.x StreamChunk frames. */
function fakeLlm(...deltas) {
	return {
		stream: async function* fakeStream() {
			for (const text of deltas) yield { type: 'text-delta', index: 0, text };
			yield { type: 'usage', usage: {} };
			yield { type: 'finish', reason: { kind: 'stop' } };
		},
	};
}

test('classifyTaskText accumulates text-delta chunks and parses the verdict', async () => {
	const verdict = await classifyTaskText(fakeLlm('{"difficulty":"com', 'plex"}'), CONFIG, 'some task');
	assert.equal(verdict.mode, 'complex');
	assert.equal(verdict.raw, '{"difficulty":"complex"}');
	assert.equal(verdict.failed, false);
});

test('classifyTaskText reports a failed attempt separately', async () => {
	const empty = await classifyTaskText(fakeLlm(), CONFIG, 'some task');
	assert.equal(empty.mode, 'simple');
	assert.equal(empty.raw, '(no text output)');
	assert.equal(empty.failed, true);
	const whitespace = await classifyTaskText(fakeLlm('   '), CONFIG, 'some task');
	assert.equal(whitespace.failed, true, 'whitespace is not a verdict');
	const throwing = { stream: async function* broken() { throw new Error('boom'); } };
	const failed = await classifyTaskText(throwing, CONFIG, 'some task');
	assert.equal(failed.mode, 'simple');
	assert.equal(failed.raw, '');
	assert.equal(failed.failed, true);
	const blank = await classifyTaskText(fakeLlm('x'), CONFIG, '');
	assert.equal(blank.mode, 'simple');
	assert.equal(blank.failed, false, 'nothing to classify is not a failed attempt');
});

test('buildClassifierUserText includes recent context and the current mode', () => {
	const history = [
		{ role: 'user', text: '帮我对整个项目做一个深度分析' },
		{ role: 'assistant', text: '我会先梳理模块…' },
	];
	const input = buildClassifierUserText('继续', history, 'complex');
	assert.match(input, /<conversation>/);
	assert.match(input, /User: 帮我对整个项目做一个深度分析/);
	assert.match(input, /Assistant: 我会先梳理模块…/);
	assert.match(input, /<current_mode>complex<\/current_mode>/);
	assert.match(input, /<current_message>\n继续\n<\/current_message>/);
	assert.ok(input.indexOf('深度分析') < input.indexOf('我会先梳理模块'), 'history must stay chronological');
});

test('buildClassifierUserText keeps the newest history messages only', () => {
	const history = Array.from({ length: 30 }, (_, index) => ({
		role: index % 2 === 0 ? 'user' : 'assistant',
		text: `turn-${index}`,
	}));
	const input = buildClassifierUserText('now', history, 'simple');
	// twelve newest entries survive; older turns are dropped first
	assert.doesNotMatch(input, /\bturn-0\b/);
	assert.doesNotMatch(input, /\bturn-17\b/);
	assert.match(input, /\bturn-18\b/);
	assert.match(input, /\bturn-29\b/);
	assert.ok(input.indexOf('turn-18') < input.indexOf('turn-29'), 'history must stay chronological');
});

test('buildClassifierUserText clips a long history entry from the middle', () => {
	const long = `HEAD${'x'.repeat(3000)}TAIL`;
	const input = buildClassifierUserText('继续', [{ role: 'user', text: long }], 'complex');
	assert.match(input, /HEAD/);
	assert.match(input, /TAIL/);
	assert.match(input, /…/);
	assert.ok(input.length < long.length, 'a long entry must not blow the prompt budget');
});

test('buildClassifierUserText tolerates an empty or untrusted history', () => {
	const input = buildClassifierUserText('  hi  ', undefined, undefined);
	assert.match(input, /\(none\)/);
	assert.match(input, /<current_mode>simple<\/current_mode>/);
	assert.match(input, /<current_message>\nhi\n<\/current_message>/);
	const junk = buildClassifierUserText('x', [{ role: 'tool', text: 'nope' }, null], 'complex');
	assert.match(junk, /\(none\)/);
});

const config = {
	enabled: true,
	primary: { provider: 'p1', model: 'strong' },
	aux: { provider: 'p2', model: 'fast' },
	classifierTimeoutMs: 15000,
	plannerGuidance: true,
};

test('sameRoute compares provider and model', () => {
	assert.equal(sameRoute({ provider: 'a', model: 'x' }, { provider: 'a', model: 'x' }), true);
	assert.equal(sameRoute({ provider: 'a', model: 'x' }, { provider: 'a', model: 'y' }), false);
	assert.equal(sameRoute(undefined, { provider: 'a', model: 'x' }), false);
});

test('pickTarget routes complex to primary and everything else to aux', () => {
	assert.equal(pickTarget('complex', config), config.primary);
	assert.equal(pickTarget('simple', config), config.aux);
	assert.equal(pickTarget(undefined, config), config.aux);
	const noPrimary = { ...config, primary: { provider: '', model: '' } };
	assert.equal(pickTarget('complex', noPrimary), config.aux);
});

test('parseDifficulty is robust to surrounding text and junk', () => {
	assert.equal(parseDifficulty('{"difficulty":"complex"}'), 'complex');
	assert.equal(parseDifficulty('Sure! {"difficulty": "simple"} as requested.'), 'simple');
	assert.equal(parseDifficulty('thinking... it is hard ... {"difficulty":"complex"} done'), 'complex');
	assert.equal(parseDifficulty('the final answer is COMPLEX'), 'complex');
	assert.equal(parseDifficulty('这比较复杂，需要深入分析'), 'complex');
	assert.equal(parseDifficulty('这个很简单'), 'simple');
	assert.equal(parseDifficulty('the task is hard'), 'simple');
	assert.equal(parseDifficulty(''), 'simple');
	assert.equal(parseDifficulty(undefined), 'simple');
});

test('keywordHit forces complex with word boundaries for ASCII keywords', () => {
	const keywords = ['hard', '深度分析', 'ReFactor'];
	assert.equal(keywordHit('这个任务很 hard，帮我搞定', keywords), 'hard');
	assert.equal(keywordHit('HARD mode please', keywords), 'hard');
	assert.equal(keywordHit('please refactor the parser', keywords), 'ReFactor');
	assert.equal(keywordHit('帮我对整个项目做一个深度分析', keywords), '深度分析');
	assert.equal(keywordHit('the hardware is broken', keywords), undefined, 'word boundary must not hit hardware');
	assert.equal(keywordHit('nothing relevant here', keywords), undefined);
	assert.equal(keywordHit('anything', ['  ', '']), undefined, 'blank keywords are ignored');
	assert.equal(keywordHit(undefined, keywords), undefined);
});

test('userTextOf concatenates text blocks only', () => {
	const message = {
		id: 'm1',
		content: [
			{ type: 'text', text: 'hello ' },
			{ type: 'image', image: 'x' },
			{ type: 'text', text: 'world' },
		],
	};
	assert.equal(userTextOf(message), 'hello \nworld');
	assert.equal(userTextOf({ id: 'm2', content: [] }), '');
	assert.equal(userTextOf(undefined), '');
});

test('keywordHit matches keywords whose edges are punctuation', () => {
	// `\b` cannot hold next to a non-word character, so a bare \b…\b pattern
	// made every one of these a silent no-op
	for (const word of ['c++', '.net', 'C#', '@scope/pkg', '-v']) {
		assert.equal(keywordHit(`please handle ${word} now`, [word]), word, `${word} must match`);
	}
	assert.equal(keywordHit('the hardware is broken', ['hard']), undefined);
	assert.equal(keywordHit('a hard task', ['hard']), 'hard');
	// regex metacharacters stay literal
	assert.equal(keywordHit('use a+b here', ['a+b']), 'a+b');
	assert.equal(keywordHit('nothing', ['a+b']), undefined);
});

test('keywordHit tolerates untrusted keyword lists and text', () => {
	assert.equal(keywordHit('x', undefined), undefined);
	assert.equal(keywordHit('x', 5), undefined);
	assert.equal(keywordHit('x', 'hard'), undefined, 'a bare string is not a keyword list');
	assert.equal(keywordHit(undefined, ['hard']), undefined);
	assert.equal(keywordHit('hard', [null, undefined, '  ', 'hard']), 'hard');
});

test('pickTarget tolerates a missing config', () => {
	assert.deepEqual(pickTarget('complex', undefined), {});
	assert.deepEqual(pickTarget('simple', {}), {});
	assert.deepEqual(pickTarget('complex', { primary: { provider: 'p', model: '' } }), {});
});

test('isHumanPrompt tolerates a null source and keeps the owner-only rule', () => {
	assert.equal(isHumanPrompt({ role: 'user', source: null }), true);
	assert.equal(isHumanPrompt({ role: 'user' }), true);
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'goal' } }), false);
	// a non-owner caller is tagged with a principal and never re-decides the mode
	assert.equal(isHumanPrompt({ role: 'user', source: { kind: 'user', principal: { kind: 'user' } } }), false);
});

test('parseDifficulty is not inverted by case or negation', () => {
	// the JSON field is authoritative even when prose contradicts it, and it is
	// case-insensitive like the bare-token fallback
	assert.equal(parseDifficulty('{"difficulty": "Simple"} (not complex)'), 'simple');
	assert.equal(parseDifficulty('{"difficulty":"COMPLEX"} but simple really'), 'complex');
	assert.equal(parseDifficulty('这个不复杂，很简单'), 'simple');
	assert.equal(parseDifficulty('这个比较复杂'), 'complex');
	assert.equal(parseDifficulty('没有难度'), 'simple');
});

test('classifyTaskText never throws on an untrusted config', async () => {
	const noConfig = await classifyTaskText(fakeLlm('{"difficulty":"complex"}'), undefined, 'hi');
	assert.equal(noConfig.mode, 'simple');
	assert.equal(noConfig.failed, true);
	assert.equal((await classifyTaskText(fakeLlm('x'), {}, 'hi')).mode, 'simple');
	assert.equal((await classifyTaskText(fakeLlm('x'), { aux: {} }, 'hi')).mode, 'simple');
	assert.equal((await classifyTaskText(undefined, CONFIG, 'hi')).mode, 'simple');
});

test('classifyTaskText honours an external cancellation signal', async () => {
	const controller = new AbortController();
	controller.abort();
	let streamed = 0;
	const llm = {
		stream() {
			streamed += 1;
			return (async function* emit() {})();
		},
	};
	const verdict = await classifyTaskText(llm, CONFIG, 'some task', { signal: controller.signal });
	assert.equal(verdict.mode, 'simple');
	assert.equal(verdict.failed, true);
	assert.equal(streamed, 0, 'an already-aborted call must not reach the model');
});
