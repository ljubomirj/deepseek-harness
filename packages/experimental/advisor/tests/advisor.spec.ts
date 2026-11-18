/**
 * Behaviour tests for the advisor's pure logic: packet rendering, gating, and
 * advice parsing. The plugin's session/LLM wiring is covered by the profile
 * smoke test after the package is linked.
 */

import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import { buildPacket, effectiveRoute, isAdvisorTurn, parseAdvice, splitProviderModel, MARKER } from '../src/logic.ts'

function message(role: Message['role'], text: string): Message {
  // Message is a union: a tool-result member also needs source/toolCallId, so the
  // fixture asserts through unknown rather than claiming the whole union.
  return {
    id: `m-${text}`,
    role,
    content: [{ type: 'text', text }],
  } as unknown as Message
}

describe('parseAdvice', () => {
  it('treats the exact silence line as silence', () => {
    expect(parseAdvice('nothing to flag')).toEqual({ kind: 'silence' })
  })

  it('tolerates prose around the silence phrase', () => {
    expect(parseAdvice('Review result: nothing to flag. The guard does what was asked.')).toEqual({ kind: 'silence' })
  })

  it('extracts a tagged note and normalizes whitespace', () => {
    const advice = parseAdvice('  [CONCERN]  the\n  guard masks a missing directory ')
    expect(advice.kind).toBe('note')
    if (advice.kind === 'note') {
      expect(advice.severity).toBe('CONCERN')
      expect(advice.text).toBe('[CONCERN] the guard masks a missing directory')
    }
  })

  it('reports untagged prose as malformed', () => {
    expect(parseAdvice('I think this is fine').kind).toBe('malformed')
  })
})

describe('effectiveRoute', () => {
  it('uses configured values without overrides', () => {
    expect(effectiveRoute('opencode-go', 'gpt-6-luna', 'xhigh', { enabled: true }))
      .toEqual({ provider: 'opencode-go', model: 'gpt-6-luna', effort: 'xhigh' })
  })

  it('runtime provider, model and explicit-empty effort win', () => {
    const state: import('../src/logic.ts').AdvisorState = {
      enabled: true, provider: 'opencode-go', model: 'deepseek-v4.1-flash', effort: '',
    }
    expect(effectiveRoute('opencode-go', 'gpt-6-luna', 'xhigh', state))
      .toEqual({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', effort: '' })
  })
})

describe('splitProviderModel', () => {
  it('splits provider/model at the first slash', () => {
    expect(splitProviderModel('opencode-go/gpt-6-luna')).toEqual({ provider: 'opencode-go', model: 'gpt-6-luna' })
  })

  it('keeps a slashed model id whole when it has no provider prefix', () => {
    expect(splitProviderModel('anthropic/claude-sonnet-4.6')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4.6' })
    expect(splitProviderModel('gpt-6-luna')).toEqual({ model: 'gpt-6-luna' })
  })

  it('treats empty and malformed arguments as a bare model', () => {
    expect(splitProviderModel('  /leading')).toEqual({ model: '/leading' })
    expect(splitProviderModel('trailing/')).toEqual({ model: 'trailing/' })
  })
})

describe('buildPacket', () => {
  it('counts tool calls and keeps the transcript tail within budget', () => {
    const messages: Message[] = [
      message('user', 'a'.repeat(50)),
      message('assistant', 'b'.repeat(50)),
      message('user', 'c'.repeat(50)),
    ]
    const packet = buildPacket(messages, 120)
    expect(packet.toolCalls).toBe(0)
    expect(packet.text.length).toBeLessThanOrEqual(120)
    expect(packet.text.endsWith('c'.repeat(50))).toBe(true)
  })

  it('recognizes an advisor turn by its marker', () => {
    expect(isAdvisorTurn([message('user', `${MARKER} [NIT] x`)])).toBe(true)
    expect(isAdvisorTurn([message('user', 'please fix the test')])).toBe(false)
  })
})
