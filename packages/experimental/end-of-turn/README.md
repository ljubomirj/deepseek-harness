# @deepseek-ai/dsh-end-of-turn

Read back the answer a previous turn ended with, without scrolling through the
reasoning and the tool traffic in between.

`/end-of-turn` shows the newest answered turn; `-1` or `1` the one before it,
`-2` or `2` the one before that. Experimental; a command only, no model call.

## Use this package

Add it to a profile and enable it in that profile's patch:

```yaml
- insert:
    - id: end-of-turn
      name: '@deepseek-ai/dsh-end-of-turn'
```

Or install the package patch:

```sh
pnpm dsh plugin --profile dsh-tui add ./packages/experimental/end-of-turn
```

Commands:

```
/end-of-turn                the newest turn that ended with an answer
/end-of-turn 0              the same
/end-of-turn -1 | 1         the turn before it
/end-of-turn -2 | 2         two turns back
```

The report is one orientation line plus the answer:

```
turn 8 · 2026-11-19 09:20 UTC · 1 back of 3 turns

The build passes; I left the flaky test alone because …
```

## How it works

A turn's answer is the visible text of its **last** `assistant/message` — the
same rule that produces the entries of `agent-turns.md`. Text parts are joined
with one blank line; reasoning blocks and tool calls never appear. A turn whose
assistant messages carry no text has no answer and is not counted, so an offset
indexes answers rather than every turn in the log.

History comes from `ctx.sessionQuery.readSession()`, so a live session and a
resumed one report the same answer, and nothing is re-read from the zstd
archives. Offsets count back from the newest answered turn of the **current**
session only; they stop at its first answer and report the valid range.

The command registry logs `command/run` and `command/done` in the session, so
the invocation itself is visible in a resumed transcript even though the report
text is a client-side row.

## Model Experience

- No model call, no tokens, no context: the handler reads the session log and
  renders text for the user.
- The report is not appended to the session surface, so the model never sees it
  and no summary can grow the context.

## Known Limitations and Deferred Work

- Current session only: there is no form that reads an earlier session of the
  same workspace, so `/end-of-turn -1` at the first answer stops instead of
  continuing into the previous session.
- No option to write the report to a file; `scripts/turn_summaries.py` in
  LJ's workspace owns the append-only `agent-turns.md`.
- A report rendered by a client that truncates command output is truncated by
  that client, not here.
