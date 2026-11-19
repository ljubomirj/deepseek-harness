/**
 * Behaviour tests for the rules the report rests on: which turn's text counts as
 * the answer, how an offset selects one, and how the selection renders.
 */

import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { foldAnswers, parseOffset, renderAnswer, selectAnswer } from '../src/logic.ts'

const T0 = Date.UTC(2026, 10, 19, 9, 20)

function turnStart(turn: number, time: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: SessionSeq(0), time, data: { turn } }
}

function step(turn: number, time: number, content: readonly ContentBlock[]): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: SessionSeq(0),
    time,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: createAssistantMessage({ content, source: { provider: 'test', model: 'test' } }),
      stream: [],
    },
  }
}

function answer(turn: number, time: number, ...texts: string[]): SessionEvent<'assistant/message'> {
  return step(turn, time, texts.map(text => ({ type: 'text', text })))
}

const reasoning = (turn: number, time: number): SessionEvent<'assistant/message'> =>
  step(turn, time, [{ type: 'reasoning', text: 'weighing the options' }])

describe('parseOffset', () => {
  it('treats an absent argument as the newest turn', () => {
    expect(parseOffset('')).toEqual({ kind: 'offset', offset: 0 })
    expect(parseOffset('   ')).toEqual({ kind: 'offset', offset: 0 })
    expect(parseOffset('0')).toEqual({ kind: 'offset', offset: 0 })
  })

  it('reads a negative offset and its positive twin as the same distance back', () => {
    expect(parseOffset('-1')).toEqual({ kind: 'offset', offset: 1 })
    expect(parseOffset('1')).toEqual({ kind: 'offset', offset: 1 })
    expect(parseOffset(' -2 ')).toEqual({ kind: 'offset', offset: 2 })
    expect(parseOffset('+3')).toEqual({ kind: 'offset', offset: 3 })
  })

  it('rejects arguments that name no offset, quoting what it read', () => {
    for (const input of ['abc', '1.5', '-', '1 2', '999999']) {
      const parsed = parseOffset(input)
      expect(parsed.kind).toBe('invalid')
      if (parsed.kind === 'invalid') expect(parsed.reason).toContain(input.trim())
    }
  })
})

describe('foldAnswers', () => {
  it('answers with the text of the turn, timestamped by its start', () => {
    expect(foldAnswers([turnStart(1, T0), answer(1, T0 + 5_000, 'the answer')]))
      .toEqual([{ turn: 1, at: T0, text: 'the answer' }])
  })

  it('keeps the last answer of a turn and drops its earlier steps', () => {
    const answers = foldAnswers([
      turnStart(1, T0),
      answer(1, T0 + 1_000, 'draft while working'),
      answer(1, T0 + 2_000, 'the final answer'),
    ])
    expect(answers.map(entry => entry.text)).toEqual(['the final answer'])
  })

  it('ignores a turn whose messages carry no text', () => {
    expect(foldAnswers([turnStart(1, T0), reasoning(1, T0 + 1_000)])).toEqual([])
  })

  it('keeps the turn absent when an answer is followed only by reasoning', () => {
    const answers = foldAnswers([
      turnStart(1, T0),
      answer(1, T0 + 1_000, 'the answer'),
      reasoning(1, T0 + 2_000),
    ])
    expect(answers.map(entry => entry.text)).toEqual(['the answer'])
  })

  it('joins the text parts of one message with a blank line and trims them', () => {
    const answers = foldAnswers([turnStart(1, T0), answer(1, T0 + 1_000, 'one\n', '  two  ')])
    expect(answers[0]?.text).toBe('one\n\ntwo')
  })

  it('orders turns oldest first regardless of log order of their answers', () => {
    const answers = foldAnswers([
      turnStart(1, T0),
      turnStart(2, T0 + 60_000),
      answer(2, T0 + 61_000, 'second'),
      answer(1, T0 + 1_000, 'first'),
    ])
    expect(answers.map(entry => entry.turn)).toEqual([1, 2])
  })

  it('falls back to the answer time when the log holds no turn start', () => {
    const answers = foldAnswers([answer(7, T0 + 3_000, 'orphaned answer')])
    expect(answers).toEqual([{ turn: 7, at: T0 + 3_000, text: 'orphaned answer' }])
  })
})

describe('selectAnswer', () => {
  const answers = foldAnswers([
    turnStart(1, T0),
    answer(1, T0 + 1_000, 'first'),
    turnStart(2, T0 + 60_000),
    answer(2, T0 + 61_000, 'second'),
  ])

  it('reads zero as the newest answer and one as the one before it', () => {
    expect(selectAnswer(answers, 0)?.text).toBe('second')
    expect(selectAnswer(answers, 1)?.text).toBe('first')
  })

  it('reports no selection past the first answer of the session', () => {
    expect(selectAnswer(answers, 2)).toBeUndefined()
  })
})

describe('renderAnswer', () => {
  const answerRecord = { turn: 8, at: T0, text: 'the answer' }

  it('heads the report with the turn, its UTC start, and its position', () => {
    expect(renderAnswer(answerRecord, 0, 12).split('\n')[0])
      .toBe('turn 8 · 2026-11-19 09:20 UTC · newest of 12 turns')
    expect(renderAnswer(answerRecord, 2, 12).split('\n')[0])
      .toBe('turn 8 · 2026-11-19 09:20 UTC · 2 back of 12 turns')
  })

  it('leaves the answer text unchanged below the heading', () => {
    expect(renderAnswer({ ...answerRecord, text: '## a heading of its own\n\nbody' }, 1, 3))
      .toBe('turn 8 · 2026-11-19 09:20 UTC · 1 back of 3 turns\n\n## a heading of its own\n\nbody')
  })
})
