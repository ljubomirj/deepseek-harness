/**
 * `/end-of-turn` — read back the answer a turn ended with, without scrolling
 * through the reasoning and tool traffic in between.
 *
 * `/end-of-turn` shows the newest answered turn; `-1` or `1` the one before it,
 * `-2` or `2` the one before that. History comes from `ctx.sessionQuery`, so the
 * same answer is shown for a live session and for a resumed one.
 *
 * @module @deepseek-ai/dsh-end-of-turn
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
// Loads the `sessionQuery` Context declaration this plugin injects.
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { foldAnswers, parseOffset, renderAnswer, selectAnswer } from './logic.ts'

/** Cordis plugin name, matching the loader row this bundle inserts. */
export const name = 'end-of-turn'

/** Services this plugin reads: the command registry and the session history reader. */
export const inject = ['commands', 'sessionQuery']

const USAGE = 'usage: /end-of-turn [n] — 0 or nothing for the newest turn, 1 or -1 for the one before it, and so on'

/**
 * Register the command. The handler reads the session log through
 * `ctx.sessionQuery` and reports the selected answer as the command's text.
 * @param ctx - the plugin's context, with `commands` and `sessionQuery` injected.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'end-of-turn',
    description: 'Show the answer a turn ended with: newest by default, -1/1 the one before it, and so on',
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const argument = parseOffset(invocation.rawInput)
      if (argument.kind === 'invalid') return { kind: 'error', text: argument.reason }

      let events: readonly SessionEvent[]
      try {
        events = (await ctx.sessionQuery.readSession(invocation.agent.session.id)).events
      } catch (error) {
        return { kind: 'error', text: `end-of-turn: this session's history cannot be read — ${describe(error)}` }
      }

      const answers = foldAnswers(events)
      if (answers.length === 0) {
        return { kind: 'error', text: 'end-of-turn: no turn of this session has ended with an answer yet' }
      }
      const answer = selectAnswer(answers, argument.offset)
      if (answer === undefined) {
        return {
          kind: 'error',
          text: `end-of-turn: ${argument.offset} turns back is before this session's first answer; `
            + `it has ${answers.length} answered turn(s), so 0…${answers.length - 1} is the range\n${USAGE}`,
        }
      }
      return { kind: 'success', text: renderAnswer(answer, argument.offset, answers.length) }
    },
  })
}

/**
 * One clause naming a thrown value.
 * @param error - the thrown value.
 * @returns the error's message, or the value's own text when it carries none.
 */
function describe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}
