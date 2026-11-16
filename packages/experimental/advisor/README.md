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
        provider: opencode-go
        model: gpt-6-luna
```

Or install the package patch:

```sh
pnpm dsh plugin --profile dsh-tui add ./packages/experimental/advisor
```

Commands:

```
/advisor            status
/advisor on|off     toggle (persisted in $DSH_HOME/advisor/state.json)
/advisor test       queue a test note
```

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
