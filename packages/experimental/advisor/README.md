# @deepseek-ai/dsh-advisor

Per-turn second-model review: after a turn stops, a reviewer model reads the
turn transcript and, only when it has something actionable, delivers one
`[NIT]` / `[CONCERN]` / `[BLOCKER]` note into the same session. The reviewer
never runs tools, never edits files and never changes session state.

Experimental, off by default. Port of `pi-omplike-advisor` (Petr Baudis) via
LJ's Hermes advisor plugin.

## Use this package

Add it to a profile and enable it in that profile's patch:

```yaml
- insert:
    - id: advisor
      name: '@deepseek-ai/dsh-advisor'
      config:
        enabled: true
        provider: opencode-go-equal
        model: gpt-6-luna
        effort: xhigh
```

The provider is independent of the session's main model: point it at any
configured route (a second subscription keeps reviewer quota off the primary).
`effort` selects the reviewer's reasoning level; empty keeps the route default.
The level must be one the model entry declares (`reasoningEfforts` on its
`llm-pi-ai` models entry).

Or install the package patch:

```sh
pnpm dsh plugin --profile dsh-tui add ./packages/experimental/advisor
```

Commands:

```
/advisor                    status
/advisor on|off             toggle (persisted in $DSH_HOME/advisor/state.json)
/advisor model              show the reviewer model and the provider's offered models
/advisor model <id>         set the reviewer model, bare or `provider/model` (persisted)
/advisor provider           show the reviewer provider and configured providers
/advisor provider <name>    move the reviewer to another configured route (persisted)
/advisor effort             show the current and offered reasoning levels
/advisor effort <id>        set the reviewer's reasoning level (persisted; cleared when a model switch drops it)
/advisor test               queue a test note
```

`/advisor model` accepts `provider/model:effort` in one argument — the effort
is validated against the new route and applied together with it.

Runtime `model`/`provider`/`effort` choices are overrides: they win over the
profile config and persist in `$DSH_HOME/advisor/state.json` until cleared by
editing that file. A model switch without an effort re-validates the current
effort against the new route and clears it with a notice when the route does
not offer it. The state file also carries `effective` — the route a review
call uses right now — written at every boot and change, so status surfaces can
render the reviewer without reading the profile.

## How it works

`agent/turn-stopping` fires before a turn commits. The listener returns
immediately and runs the review detached, so a turn never waits for the
reviewer. The transcript comes from `agent.session.deriveMessages()`; turns with
fewer than `minTools` tool calls are skipped, as are turns whose last user
message is advisor advice (the `[advisor]` marker), which prevents a review
loop. Advice is delivered with `agent.followup(createUserMessage(...))`, i.e. as
a new user turn in the same session.

## Model Experience

- One extra completion per reviewed turn (skipped below the tool-call gate).
- The reviewer sees a clipped transcript (default 20 000 chars); reasoning
  blocks are dropped.
- Advice is one short line and stays in the session context, so the gate and the
  silence rule matter more than the prompt length.

## Known Limitations and Deferred Work

- Async delivery only; no blocking `agent.steer` mode.
- No hold-and-reconfirm across turns yet: notes are not persisted or
  deduplicated, so a repeated concern is repeated.
- The gate is a tool-call count only; no per-turn token budget or
  model-diversity check.
