# dsh-dual-model-router

Dual-model auto routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

A fast **auxiliary model** and a strong **primary model** are configured on the
plugin's Settings page. When enabled:

1. A human **send** is held for one classification round trip: the browser half
   asks the host (`POST /api/dual-model-router/route`) to decide and record the
   route *before* the prompt is admitted. The decision is keyword-first
   (`complexKeywords`, default `hard`; ASCII keywords match whole words, others
   match as substrings — a hit is always complex, no LLM call), then one cheap
   auxiliary-model call that reads the recent conversation (up to twelve
   human/assistant messages, 6000 characters) together with the current message
   and the session's current mode. A short follow-up ("继续", "跑一下测试")
   therefore inherits the difficulty of the task it continues instead of being
   judged in isolation.
2. **Simple tasks** run entirely on the auxiliary model.
3. **Complex tasks** run on the primary model, which receives a planner-guidance
   system-prompt section telling it to plan first and delegate every execution
   step to subagents; **subagents are always routed to the auxiliary model**, so
   execution is fast and cheap — including a subagent whose call site requested
   another provider/model explicitly.

The conversation window is bounded and clipped from the middle, so
classification cost stays flat as a session grows. Machine-generated user
messages are excluded from it by the same `isHumanPrompt` rule that decides
which prompts may re-decide the mode; tool output is never sent. The current
mode is a hint for continuity, not a command — a clearly new, self-contained
simple request can still downgrade the session.

Step 1 matters because of the harness's step-selection contract: a step's
provider/model is captured *before* `agent/pre-step` runs, and the deprecated
`agent/request` waterfall now rejects a listener that changes it. The only way
to run the **first** step of a turn on a routed model is therefore to select it
before the prompt is admitted — hence the pre-send round trip. The round trip is
bounded by the host's own classifier budget (`classifierTimeoutMs`, default
`15000`, clamped to `1000`–`120000`); the browser half holds the send for that
budget plus 2s, clamped to 2–30s, and aborts the classification when the send is
released. So a slow classifier delays the message instead of losing the route,
and the composer never parks longer than 30s. If the round trip is refused,
times out, or the router is off, the send proceeds untouched.

The host route is written with `agent.model.select()` — the harness's own
durable selection — and applies from the next step boundary. So after any miss
(an offline browser, a host without the route, a send that outran its
classification) the *same* decision still lands one step later: `agent/pre-step`
keeps classifying human prompts and selecting the route, which covers warm
sessions, subagents and non-browser clients.

Only a human prompt re-decides the mode, and it is judged with the recent
conversation rather than in isolation. `agent/pre-step` also claims
machine-generated user-role messages — goal auto-continuation rounds (`goal`),
scheduled reminders (`schedule`), runtime-context snapshots
(`runtime-context`), model-switch notices (`model-selection`), the answer the
user gave to an `ask_user_question` (`user-question-reply`) and agent-to-agent
relays including a subagent reporting back to its parent (`agent-message`) —
and those never re-classify, so a terse "done" from a subagent cannot drop a
complex task back to the cheap model mid-flight. A human prompt with no text
(an attachment-only send) keeps the current mode too.

"Human" here means the **owner**: DSH tags a `user`-kind message with a
`principal` for any caller other than the owner, and such a prompt keeps the
session's current route instead of re-deciding it (matching the owner-gated
prompt-time route below).

`POST /api/dual-model-router/debug-classify {"text": "...", "sessionId"?: "..."}`
runs the exact decision pipeline (keyword first, then the LLM). With a live
`sessionId` it sends that session's recent conversation and current mode, so the
diagnostic matches a real send; it answers `{ok, mode, source, raw, history}`.

`POST /api/dual-model-router/route {sessionId, text}` is the prompt-time
endpoint the browser half calls: it resolves that session's live agent,
classifies, applies the route, and answers
`{ok, kind, route?, mode?, applied, verdict}` — `kind` is `auto`, `subagent`,
`off` (the router is disabled or the chosen target route is incomplete) or
`idle` (no live agent yet, e.g. a session that has none); `applied` is true
only for `auto` and `subagent`; `verdict` is the classifier's `{mode, source,
raw}` (`source` is `keyword`, `llm`, `failed` or `cancelled`), or `null` when
nothing was classified. A refusal is never fatal to the send, and the endpoint
refuses nothing on account of the session's current model: while the router is
on it routes every prompt.

`POST /api/dual-model-router/toggle` flips `enabled` in the plugin row and
answers `{ok, enabled}` — the one path the composer switch and the keyboard
shortcut share. Turning the router on refuses `409` (`unknown model — …`) when a
configured route does not resolve against the live provider catalog, so a typo
cannot silently break routing. The settings page's Save applies the same check,
but only when the save leaves the router on and either switches it on or edits a
route — an unrelated field can still be edited while a route is broken.

All six `/api/dual-model-router/*` routes gate themselves through the host
`connection` service and fail closed: they need the same authenticated browser
session or API token as every other `/api` route, and answer `503` when no auth
service is available. Plugin routes are registered as `exact` paths, which
shadow the `/api` auth prefix — the gate is what keeps `settings/save` and
`toggle` from being unauthenticated config writes. The four routes that mutate
state or spend a model call (`settings/save`, `toggle`, `route`,
`debug-classify`) additionally require an **owner** Peer and answer `403`
otherwise: authentication alone would let a shared or remote caller rewrite the
profile or pin another session's model, because these handlers run outside any
Remote invocation and so bypass `remoteAccess`'s policy. The two read routes
(`settings`, the SSE stream) accept any authenticated caller. All of them are
method-checked (`405`).

While the router is on it owns the session's model: a model chosen by hand
(through `/model`, or by a client that pins one) is replaced by the router's own
route at the next step boundary, so the on/off switch is the only way to drive a
conversation with a model of your own. Classifier failures and timeouts keep the
session's current mode: a new session stays `simple`, but an ongoing complex
task is never dropped to the cheap route mid-task by a transient failure.

## Composer surfaces

Two surfaces sit in the composer tool row, under the input box:

- **On/off switch** (`conversation.input.right`, immediately left of the model
  seat): always present while a conversation is live. The label stays a
  constant `自动路由` — the dot alone carries the state (green = on,
  grey = off, red = the last toggle failed; the tooltip says which). Clicking
  it toggles, and the tooltip names the current shortcut — omitted on a profile
  where the command is unbound (`web:linux`), so the sentence never breaks. It
  reads the applied config over the status stream, so a change made anywhere —
  shortcut, settings page, another tab — shows up here.
- **Model seat** (`conversation.input.model`): **while the router is on, the
  plugin shadows the shipped model selector** with a read-only display of the
  model this conversation actually runs on. The label is the model catalog's
  display name, resolved from the same per-session directory the shipped
  selector reads, so it matches the name in the `/model` menu; a route the
  catalog does not know yet falls back to the provider-owned id. The bare model
  name is the normal case — every route is router-chosen, so no badge is shown.
  Manual selection in the composer is impossible while the router is on, and a
  pick made through `/model` is taken over the same way; turning the router off
  restores the shipped selector, with no reload.

Every surface that names a model — this seat and the routing line below the
composer card, in every conversation including a subagent view — resolves it the
same way, so they never disagree. Two details of that lookup are worth knowing:

- The client half declares `slots`, `sessions`, `remote` and `remote.session`.
  The directory service `ctx.get('modelDirectories')` hands back is bound to the
  *calling* context, so `directoryFor()` resolves the provider catalog through
  this plugin's own tracker proxy: an undeclared `remote.session` throws
  (`cannot get property "remote.session" without inject`), and the lookup then
  silently prints the provider-owned id on every surface. Declare the services a
  label needs, or the fallback becomes the label.
- A composer with no session directory — the new-conversation hero, or a session
  the host has not scoped yet — falls back to `remote.session.modelCatalog()`, a
  session-less call fetched at most once per page and shared by every surface.
  The per-session directory stays the primary source, since it carries the
  shipped selector's own invalidation; the page catalog only fills the gap where
  the alternative is printing a raw id.

A `single` slot refuses a second entry at the *same* priority ("register at a
different priority to shadow it (lowest renders)"), and the shipped selector
holds priority `0` on this slot, so the seat registers below it. For a *dynamic*
client bundle that is doubly guaranteed: the runtime's `guardedSlots`
**overwrites** the priority of every non-`chain` registration with its own
descending allocation (`-1, -2, …`), so the plugin's `-1` is a request rather
than what actually lands. The takeover still walks a short list of falling
priorities (`-1, -2, -4, -8`) because a static registration could already hold
one of them. The shipped entry stays registered but renders `active: false`;
dropping the seat entry on the way off makes it the rendered entry again. The
takeover is driven by the applied switch, so it follows a toggle from any
surface and any tab.

If the seat cannot attach while the router is on (a composer that arrives after
the retry window, or an occupied priority), the plugin leaves an invisible
diagnostic entry in `conversation.composer.dock` whose id carries the reason —
`dual-model-router-seat-probe[waiting live=0 attempts=N]`,
`[…failed <message>]` (every priority refused) or `[…watch-failed <message>]`
(the slot declaration watch itself could not attach) — visible to Slot
inspection and to nothing else. It disappears as soon as the takeover is in
place.

## Keyboard shortcut

| Profile | Default |
|---|---|
| `desktop:macos` / `desktop:windows` / `desktop:linux` | `primary` + `alt` + `M` |
| `web:macos` / `web:windows` | `primary` + `alt` + `M` |
| `web:linux` | unbound (no legal free default; assign one yourself) |

The command is `dual-model-router.toggle` ("Toggle dual-model routing" /
"切换双模型路由"), works on the page and inside the composer, and is blocked
while a modal is open. Like every editable command it appears in
**Settings → General → Shortcuts**, where the combination can be changed and
conflicts are reported; the plugin's own settings page shows the effective
keycaps.

## Routing indicator

While enabled, a status pill renders below the composer card (right-aligned) for
every live conversation, pushed over SSE from the router (`agent/pre-step`
decisions and the prompt-time route alike):

- `辅助模型判别任务难度…` — the auxiliary model is classifying the new message
- `简单任务 · 辅助模型 <model>` — the whole task runs on the auxiliary model
- `复杂任务 · 主模型 <model> 规划，辅助模型执行` — primary plans, subagents execute
- `子代理 · 辅助模型 <model>` — shown inside subagent conversation views

`<model>` is the model catalog's display name — the same name the `/model` menu
and the seat print — not the provider-owned id (see Composer surfaces above for
the two ways that lookup is sourced).

Each line carries a coloured dot: amber while classifying, green for an auto
simple route or a subagent, blue for an auto complex route.

## Settings page

Settings → **Dual-Model Router** (双模型路由): enable toggle, the effective
toggle shortcut, primary/auxiliary model pickers with per-model
reasoning-effort pickers (from the live provider catalog), complex keywords,
classifier timeout, the planner-guidance switch, and the extra-instructions
box. Saving goes through `ctx.configEditor` and hot-applies via HMR.

**Extra instructions** (`extraPrompt`, up to 8000 characters, trimmed) is a
free-text box for your own guidance to the planning model — the typical use is
telling it how to delegate, e.g. that a subtask which builds on conclusions
already reached in this conversation should be dispatched to the
context-inheriting subagent tool, while an independent subtask needs a fresh
one. It is injected **only while the router is on and the task is classified as
complex**, and **only into a root agent's system prompt** — as its own section
immediately after the planner guidance, never into the user message, so the
conversation log, the classifier's context window, and the routing indicator
are untouched. It is independent of the planner-guidance switch (that switch
owns the built-in text), and an empty box injects nothing.

Each route's `reasoningEffort` is optional (`off/low/medium/high/max` where the
model supports it); unset means the model's own default. The classifier call
always uses the auxiliary model's **lowest** supported effort.

**Classifier timeout** is shared: the host spends at most that long classifying
a prompt (clamped to 1–120s), and the composer holds a send for at most that
long plus 2s — clamped to 2–30s — before letting it through unrouted (the next
step boundary then picks the route up). Lower it for a snappier composer, raise
it if your auxiliary model is slow to warm up — a local model busy with another
turn can queue the classifier call.

## Install

```bash
dsh plugin --profile web add /Users/kido/.dsh/plugins/dsh-dual-model-router
```

or from a DSH agent: install the bundle at the absolute path above.

## Configuration

Row `dual-model-router` in the profile's `cordis.patch.yml`:

```yaml
- id: dual-model-router
  name: dsh-dual-model-router
  config:
    enabled: false
    primary: { provider: zai-coding-cn, model: glm-5.3 }
    aux: { provider: giends4f-remote, model: DeepSeek-V4-Flash }
    classifierTimeoutMs: 15000
    plannerGuidance: true
    # free text injected into the primary model's system prompt for complex
    # tasks (root agent only); empty means inject nothing
    extraPrompt: ""
    complexKeywords:
      - hard
```

## Test

```bash
cd /Users/kido/.dsh/plugins/dsh-dual-model-router && npm test
```

MIT License.
