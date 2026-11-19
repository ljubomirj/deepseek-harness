/**
 * Composition tests: the plugin mounted beside the real command registry, the
 * real session store, and a session-history reader, driven through
 * `commands.execute()` — the same call the terminal UI makes, with the same
 * `/end-of-turn …` lines a user types.
 *
 * The reader is a live-only `SessionQueryEngine`: history is read from the
 * session store exactly as the shipped service reads it, while the abstract
 * full-text search methods stay unimplemented because the command never uses
 * them.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { afterEach, describe, expect, it } from 'vitest'
import * as endOfTurn from '../src/index.ts'

/** Live-only history reader: the concrete service minus full-text search. */
class LiveHistory extends SessionQueryEngine {
  searchSessions(): Promise<never> {
    return Promise.reject(new Error('searchSessions is unused by /end-of-turn'))
  }

  searchEvents(): Promise<never> {
    return Promise.reject(new Error('searchEvents is unused by /end-of-turn'))
  }
}

let ctx: Context | undefined

afterEach(() => {
  ctx?.fiber.dispose()
  ctx = undefined
})

interface Mounted {
  readonly session: Session
  readonly run: (line: string) => Promise<{ kind: string; text?: string }>
}

/** Mount the plugin in a real harness context and return one command driver. */
async function mount(): Promise<Mounted> {
  const context = new Context()
  ctx = context
  await context.plugin(SessionStore)
  await context.plugin(LiveHistory)
  await context.plugin(CommandRuntime)
  await context.plugin(endOfTurn)

  const session = context.sessions.create(brandString<SessionId>('end-of-turn-test'))
  // The command handler reads `agent.session.id` and nothing else from the agent.
  const agent = { session } as unknown as Agent
  return {
    session,
    run: async (line: string) => {
      const execution = await context.commands.execute(agent, line, [], new AbortController().signal)
      if (execution === undefined) throw new Error(`command did not resolve: ${line}`)
      return execution.result
    },
  }
}

/** Record one complete turn: request, answer, and its close. */
function appendTurn(session: Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `request ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('/end-of-turn', () => {
  it('reports the newest answer for a bare invocation', async () => {
    const mounted = await mount()
    appendTurn(mounted.session, 1, 'first answer')
    appendTurn(mounted.session, 2, 'second answer')

    const result = await mounted.run('/end-of-turn')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('newest of 2 turns')
    expect(result.text).toContain('second answer')
    expect(result.text).not.toContain('first answer')
  })

  it('walks back with -N and with the same positive distance', async () => {
    const mounted = await mount()
    appendTurn(mounted.session, 1, 'first answer')
    appendTurn(mounted.session, 2, 'second answer')
    appendTurn(mounted.session, 3, 'third answer')

    for (const line of ['/end-of-turn -1', '/end-of-turn 1']) {
      const result = await mounted.run(line)
      expect(result.text).toContain('1 back of 3 turns')
      expect(result.text).toContain('second answer')
    }
    const twoBack = await mounted.run('/end-of-turn -2')
    expect(twoBack.text).toContain('2 back of 3 turns')
    expect(twoBack.text).toContain('first answer')
  })

  it('refuses an offset past the first answer and names the range', async () => {
    const mounted = await mount()
    appendTurn(mounted.session, 1, 'only answer')

    const result = await mounted.run('/end-of-turn -4')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('it has 1 answered turn(s)')
    expect(result.text).toContain('0…0 is the range')
  })

  it('reports an unusable argument', async () => {
    const mounted = await mount()
    const result = await mounted.run('/end-of-turn soon')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('"soon" is not a turn offset')
  })

  it('reports a session with no answer yet', async () => {
    const mounted = await mount()
    const result = await mounted.run('/end-of-turn')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('no turn of this session has ended with an answer')
  })
})
