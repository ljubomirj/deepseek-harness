/**
 * Pure rules behind `/end-of-turn`: which turns of a session ended with an
 * answer, how a numeric argument counts back from the newest one, and how the
 * chosen answer reads. No Cordis services and no I/O, so the rules that decide
 * what the command shows are testable on their own.
 *
 * @module @deepseek-ai/dsh-end-of-turn/logic
 */

import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** One turn that ended with visible text: its number, its start time, and the text. */
export interface TurnAnswer {
  /** Turn number as `turn/start` recorded it. */
  readonly turn: number
  /** Turn start in Unix epoch milliseconds; the answer's own time when the log holds no `turn/start`. */
  readonly at: number
  /** Visible text of the turn's last answer: text parts only, trimmed, joined by one blank line. */
  readonly text: string
}

/** A parsed argument: how many turns back to read, or why the argument is unusable. */
export type OffsetArgument =
  | { readonly kind: 'offset'; readonly offset: number }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Offsets are small by nature; five digits keeps the parse finite and the range check explicit. */
const OFFSET_ARGUMENT = /^[+-]?\d{1,5}$/u

/**
 * Read the optional argument: nothing selects the newest answered turn, and
 * `-N` and `N` both count `N` turns back, so `-1` and `1` name the same turn.
 * @param rawInput - exact text after the command name, separator whitespace included.
 * @returns the offset to read, or the reason the argument names no offset.
 */
export function parseOffset(rawInput: string): OffsetArgument {
  const trimmed = rawInput.trim()
  if (trimmed === '') return { kind: 'offset', offset: 0 }
  if (!OFFSET_ARGUMENT.test(trimmed)) {
    return {
      kind: 'invalid',
      reason: `"${trimmed}" is not a turn offset — use 0 or nothing for the newest turn, 1 or -1 for the one before it, and so on`,
    }
  }
  return { kind: 'offset', offset: Math.abs(Number.parseInt(trimmed, 10)) }
}

/**
 * Visible text of one assistant message: text parts only, so reasoning and tool
 * calls never reach the report.
 * @param message - one assistant message as the session recorded it.
 * @returns the trimmed text parts joined by one blank line; `''` when the message carries none.
 */
function visibleText(message: AssistantMessage): string {
  const parts: string[] = []
  for (const part of message.content) {
    if (part.type !== 'text') continue
    const text = part.text.trim()
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * Fold a session log into the turns that ended with an answer, oldest first.
 *
 * A turn's answer is the visible text of its **last** `assistant/message`; that
 * is the message the turn ended with. A turn whose assistant messages carry no
 * text (reasoning and tool calls only) has no answer and is absent from the
 * result, so offsets count answered turns rather than every turn the log opened.
 * The same rule produces the entries of `agent-turns.md`.
 * @param events - the session's raw events in log order.
 * @returns one record per answered turn, ordered by turn number.
 */
export function foldAnswers(events: readonly SessionEvent[]): TurnAnswer[] {
  const answers = new Map<number, { turn: number; at: number; text: string }>()
  for (const event of events) {
    if (event.type === 'turn/start') {
      const { turn } = event.data
      answers.set(turn, { turn, at: event.time, text: answers.get(turn)?.text ?? '' })
      continue
    }
    if (event.type !== 'assistant/message') continue
    const { turn, message } = event.data
    const text = visibleText(message)
    if (text === '') continue          // a reasoning or tool step, not an answer
    answers.set(turn, { turn, at: answers.get(turn)?.at ?? event.time, text })
  }
  return [...answers.values()]
    .filter(answer => answer.text !== '')
    .sort((left, right) => left.turn - right.turn)
}

/**
 * The answer `offset` turns back from the newest one.
 * @param answers - answered turns in ascending turn order, as {@link foldAnswers} returns them.
 * @param offset - zero for the newest answer, one for the one before it, and so on.
 * @returns the selected answer, or `undefined` when the session has fewer answers than that.
 */
export function selectAnswer(answers: readonly TurnAnswer[], offset: number): TurnAnswer | undefined {
  return answers[answers.length - 1 - offset]
}

/**
 * Render one answer as the command's report: one line identifying the turn,
 * then the answer text.
 * @param answer - the selected answer.
 * @param offset - the offset it was selected with, echoed so the reader can tell repeated invocations apart.
 * @param total - how many turns of the session ended with an answer.
 * @returns the report text, ending without a trailing newline.
 */
export function renderAnswer(answer: TurnAnswer, offset: number, total: number): string {
  const position = offset === 0 ? `newest of ${total} turns` : `${offset} back of ${total} turns`
  return [`turn ${answer.turn} · ${stamp(answer.at)} UTC · ${position}`, '', answer.text].join('\n')
}

/**
 * Format one instant as `YYYY-MM-DD HH:MM` in UTC.
 * @param at - Unix epoch milliseconds.
 * @returns the UTC stamp.
 */
function stamp(at: number): string {
  const when = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`
  return `${date} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`
}
