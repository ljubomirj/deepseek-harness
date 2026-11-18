/**
 * Experimental per-turn advisor: after a turn stops, a second model reviews the
 * turn and, when it has something actionable, delivers one note into the same
 * session via `agent.followup`. The reviewer never runs tools, never edits
 * files and never changes session state.
 *
 * Unlike the skill prototype, this needs no packet assembly by the primary
 * agent: the transcript comes from `session.deriveMessages()`.
 *
 * @module @deepseek-ai/dsh-experimental-advisor
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { MARKER, buildPacket, effectiveRoute, isAdvisorTurn, parseAdvice, splitProviderModel } from './logic.ts'
import type { AdvisorRoute, AdvisorState } from './logic.ts'

export const name = 'experimental-advisor'
export const inject = ['commands', 'llm']

/** Advisor configuration; all fields optional, defaults are conservative. */
export interface AdvisorConfig {
  /** Master switch; also toggled at runtime with `/advisor on|off`. */
  enabled: boolean
  /** Provider route for the reviewer. */
  provider: string
  /** Reviewer model. Keep it a different family from the primary where possible. */
  model: string
  /** Reasoning effort for the reviewer; empty keeps the route default. */
  effort: string
  /** Only review turns with at least this many tool calls. */
  minTools: number
  /** Soft cap on the rendered transcript. */
  maxChars: number
  /** Hard timeout for the reviewer call. */
  timeoutMs: number
  /** Delivery mode: async (followup after the turn) is the only one implemented. */
  mode: 'async'
}

export const Config: z<AdvisorConfig> = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().default('opencode-go'),
  model: z.string().default('gpt-6-luna'),
  effort: z.string().default(''),
  minTools: z.number().default(2),
  maxChars: z.number().default(20000),
  timeoutMs: z.number().default(60000),
  mode: z.const('async').default('async'),
})

const SYSTEM = `You are a peer programmer reviewing a coding agent's work. You bring a different angle, and advocate for the user and for code quality and robustness.

You critique the agent's work; you never do it yourself. You are not a participant in the conversation and never address the user. If the agent is sound, stay SILENT. Never try to fulfil the user's request yourself.

You receive the transcript of the most recent turn: user messages, the agent's text, tool calls and tool results. Judge only from that transcript.

Rules:
- Prefix every piece of advice with exactly one severity tag: [NIT], [CONCERN], or [BLOCKER].
- At most one piece of advice per turn. Most turns should produce no advice at all.
- Prefer SILENCE. If you have nothing for the agent to DO, emit exactly: nothing to flag
- NEVER restate information the agent already has, including errors they already saw (build output, test failures, lint diagnostics).
- NEVER repeat advice. NEVER nitpick things the user accepted.
- Before answering, ask: would I ask the author to change this diff before merging? If no, emit exactly: nothing to flag
- Hypothetical misconfigurations, defensive-programming preferences and behaviour the work does not change are not actionable.
- A change that satisfies the stated request without adding a concrete risk is silent, even when another implementation would be marginally more defensive. Trace shell expansions and failure modes step by step; do not invent failure modes the shown work does not produce.
- Your lane: correctness, edge cases, design, robustness. Not intent, not process, not style preferences.

[NIT] non-urgent cleanup or a missed minor opportunity.
[CONCERN] the agent may be heading the wrong way or missed something material.
[BLOCKER] continuing would clearly waste the user's time or produce something fundamentally unsound.`



function statePath(): string {
  const root = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(root, 'advisor', 'state.json')
}

function readState(fallback: boolean): AdvisorState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<AdvisorState>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : fallback,
      ...typeof parsed.effort === 'string' ? { effort: parsed.effort } : {},
      ...typeof parsed.provider === 'string' && parsed.provider !== '' ? { provider: parsed.provider } : {},
      ...typeof parsed.model === 'string' && parsed.model !== '' ? { model: parsed.model } : {},
    }
  } catch (error) {
    // Unreadable or absent state falls back to the configured default.
    void error
    return { enabled: fallback }
  }
}

function writeState(state: AdvisorState): void {
  const path = statePath()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** Collect the visible text of a reviewer stream; reasoning blocks are ignored. */
async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  const assembler = new BlockAssembler()
  let finished = false
  for await (const chunk of stream) {
    assembler.push(chunk)
    if (chunk.type === 'finish') {
      finished = true
      if (chunk.reason.kind !== 'stop') return ''
    }
  }
  if (!finished) return ''
  return assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Run one detached review; failures are swallowed so a turn is never blocked. */
async function review(
  ctx: Context,
  agent: Agent,
  config: AdvisorConfig,
  state: AdvisorState,
  signal: AbortSignal,
): Promise<void> {
  let messages: readonly Message[]
  try {
    messages = agent.session.deriveMessages()
  } catch (error) {
    // A session that cannot derive messages is not reviewable.
    void error
    return
  }
  if (isAdvisorTurn(messages)) return
  const packet = buildPacket(messages, config.maxChars)
  if (packet.toolCalls < config.minTools) return

  const route = effectiveRoute(config.provider, config.model, config.effort, state)
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, config.timeoutMs)
  const abort = (): void => { controller.abort() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      ...route.effort === '' ? {} : { reasoningEffort: ReasoningEffortId(route.effort) },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `TRANSCRIPT\n----------\n${packet.text}` }],
      }],
      temperature: 0,
      maxTokens: 400,
      sessionId: agent.session.id,
      signal: controller.signal,
    }
    const raw = await collectText(ctx.llm.stream(options))
    const advice = parseAdvice(raw)
    if (advice.kind !== 'note') return
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `${MARKER} ${advice.text}` }],
      source: { kind: 'user' },
    }))
  } catch (error) {
    // A reviewer failure must never surface as a turn failure.
    void error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

function status(config: AdvisorConfig, state: AdvisorState): string {
  const route = effectiveRoute(config.provider, config.model, config.effort, state)
  const overridden = state.provider !== undefined || state.model !== undefined
    ? ' (runtime override)' : ''
  return [
    `advisor: ${state.enabled ? 'on' : 'off'}`,
    `model: ${route.provider}/${route.model}${overridden}`,
    `effort: ${route.effort === '' ? '(none)' : route.effort}`,
    `gate: >=${config.minTools} tool calls, <=${config.maxChars} chars, ${config.timeoutMs} ms`,
  ].join('\n')
}

/** Model ids one provider route offers; empty when the route cannot be listed. */
async function offeredModels(ctx: Context, provider: string): Promise<readonly string[]> {
  try {
    return (await ctx.llm.listModels(provider)).map(info => info.id)
  } catch (error) {
    // An unlistable route leaves the offered set unknown.
    void error
    return []
  }
}

/** Reasoning efforts one provider/model route offers; empty when unresolvable. */
async function offeredEfforts(ctx: Context, provider: string, model: string): Promise<readonly string[]> {
  try {
    const resolved = await ctx.llm.resolveModelInfo(provider, model)
    return resolved.reasoning?.efforts.map(level => level.id) ?? []
  } catch (error) {
    // An unresolvable route leaves the offered set unknown.
    void error
    return []
  }
}

/** Validate that the effective effort is offered; clear it when the route lacks it. */
async function reconcileEffort(
  ctx: Context,
  route: AdvisorRoute,
  state: AdvisorState,
): Promise<string | undefined> {
  if (route.effort === '') return undefined
  const efforts = await offeredEfforts(ctx, route.provider, route.model)
  if (efforts.length === 0 || efforts.includes(route.effort)) return undefined
  const dropped = route.effort
  state.effort = ''
  return `effort "${dropped}" is not offered by ${route.provider}/${route.model}; cleared — set one with /advisor effort`
}

/** Plugin entry: command plus detached turn-stop listener. */
export function apply(ctx: Context, config: AdvisorConfig): void {
  const state = readState(config.enabled)

  ctx.commands.register({
    name: 'advisor',
    description: 'Second-model review of the last turn (on|off|status|model <id>|provider <name>|effort <id>|test)',
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const input = invocation.rawInput.trim().toLowerCase()
      if (input === '' || input === 'status') return { kind: 'success', text: status(config, state) }
      if (input === 'on') {
        state.enabled = true
        writeState(state)
        return { kind: 'success', text: status(config, state) }
      }
      if (input === 'off') {
        state.enabled = false
        writeState(state)
        return { kind: 'success', text: status(config, state) }
      }
      if (input === 'effort' || input.startsWith('effort ')) {
        const arg = invocation.rawInput.trim().slice('effort'.length).trim()
        const route = effectiveRoute(config.provider, config.model, config.effort, state)
        const available = await offeredEfforts(ctx, route.provider, route.model)
        if (arg === '') {
          return {
            kind: 'success',
            text: `advisor effort: ${route.effort === '' ? '(none)' : route.effort}\noffered by ${route.provider}/${route.model}: ${available.join(', ') || 'none'}`,
          }
        }
        if (available.length > 0 && !available.includes(arg)) {
          return {
            kind: 'error',
            text: `advisor: "${arg}" is not offered for ${config.provider}/${config.model}; offered: ${available.join(', ')}`,
          }
        }
        state.effort = arg
        writeState(state)
        return { kind: 'success', text: status(config, state) }
      }
      if (input === 'model' || input.startsWith('model ')) {
        const arg = invocation.rawInput.trim().slice('model'.length).trim()
        const current = effectiveRoute(config.provider, config.model, config.effort, state)
        if (arg === '') {
          const ids = await offeredModels(ctx, current.provider)
          return {
            kind: 'success',
            text: `advisor model: ${current.provider}/${current.model}\noffered on ${current.provider}: ${ids.join(', ') || 'none'}`,
          }
        }
        const split = splitProviderModel(arg)
        let provider = current.provider
        let model = split.model
        if (split.provider !== undefined) {
          const known = ctx.llm.listProviders().some(info => info.id === split.provider)
          if (known) provider = split.provider
          else model = arg
        }
        const ids = await offeredModels(ctx, provider)
        if (ids.length > 0 && !ids.includes(model)) {
          return {
            kind: 'error',
            text: `advisor: model "${model}" is not offered on ${provider}; offered: ${ids.join(', ')}`,
          }
        }
        state.provider = provider
        state.model = model
        const route = effectiveRoute(config.provider, config.model, config.effort, state)
        const effortNote = await reconcileEffort(ctx, route, state)
        writeState(state)
        return { kind: 'success', text: [status(config, state), ...effortNote === undefined ? [] : [effortNote]].join('\n') }
      }
      if (input === 'provider' || input.startsWith('provider ')) {
        const arg = invocation.rawInput.trim().slice('provider'.length).trim()
        const current = effectiveRoute(config.provider, config.model, config.effort, state)
        const providerIds = ctx.llm.listProviders().map(info => info.id)
        if (arg === '') {
          return {
            kind: 'success',
            text: `advisor provider: ${current.provider}\noffered: ${providerIds.join(', ') || 'none'}`,
          }
        }
        if (!providerIds.includes(arg)) {
          return {
            kind: 'error',
            text: `advisor: provider "${arg}" is not configured; offered: ${providerIds.join(', ') || 'none'}`,
          }
        }
        const ids = await offeredModels(ctx, arg)
        if (ids.length > 0 && !ids.includes(current.model)) {
          return {
            kind: 'error',
            text: `advisor: model "${current.model}" is not offered on ${arg}; pick one first: ${ids.join(', ')}`,
          }
        }
        state.provider = arg
        const route = effectiveRoute(config.provider, config.model, config.effort, state)
        const effortNote = await reconcileEffort(ctx, route, state)
        writeState(state)
        return { kind: 'success', text: [status(config, state), ...effortNote === undefined ? [] : [effortNote]].join('\n') }
      }
      if (input === 'test') {
        invocation.agent.followup(createUserMessage({
          content: [{ type: 'text', text: `${MARKER} [NIT] advisor test note — delivery works; ignore it.` }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: 'advisor: test note queued' }
      }
      return { kind: 'error', text: `Usage: /advisor [on|off|status|model <id>|provider <name>|effort <id>|test]\n${status(config, state)}` }
    },
  })

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (!state.enabled) return
    // Detached on purpose: the turn must not wait for the reviewer.
    void review(ctx, agent, config, state, signal)
  })
}
