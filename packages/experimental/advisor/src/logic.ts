/**
 * Pure helpers for the advisor plugin: transcript rendering, gating, and
 * advice parsing. Kept separate so they can be unit-tested without a live
 * Cordis context or model.
 *
 * @module @deepseek-ai/dsh-experimental-advisor/logic
 */

import type { Message } from '@deepseek-ai/dsh-llm'

/** One rendered review packet plus the facts the gate needs. */
export interface Packet {
  readonly text: string
  readonly toolCalls: number
  readonly messages: number
}

/** Advice extracted from the reviewer's answer. */
export type Advice =
  | { readonly kind: 'silence' }
  | { readonly kind: 'note'; readonly severity: 'NIT' | 'CONCERN' | 'BLOCKER'; readonly text: string }
  | { readonly kind: 'malformed'; readonly raw: string }

/** Marker put in front of advice injected into the session; used to avoid reviewing our own turns. */
export const MARKER = '[advisor]'

function blockText(block: Message['content'][number]): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'tool-call':
      return `[tool ${block.name}] ${block.arguments}`
    case 'reasoning':
      return ''
    case 'image':
      return '[image]'
    case 'file':
      return '[file]'
    default:
      return ''
  }
}

/**
 * Render the session's derived messages newest-last, keeping the tail that fits
 * the character budget. Tool calls are counted across the whole transcript.
 * @param messages - derived session messages.
 * @param maxChars - soft cap on the rendered packet.
 * @returns packet text plus gate facts.
 */
export function buildPacket(messages: readonly Message[], maxChars: number): Packet {
  let toolCalls = 0
  const rendered: string[] = []
  for (const message of messages) {
    const parts: string[] = []
    for (const block of message.content) {
      if (block.type === 'tool-call') toolCalls += 1
      const text = blockText(block).trim()
      if (text !== '') parts.push(text)
    }
    if (parts.length > 0) rendered.push(`${message.role}: ${parts.join(' ')}`)
  }
  let size = 0
  const kept: string[] = []
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const line = rendered[index]
    if (line === undefined) continue
    size += line.length + 1
    if (size > maxChars && kept.length > 0) break
    kept.unshift(line)
  }
  return { text: kept.join('\n'), toolCalls, messages: messages.length }
}

/**
 * Whether the latest user message is advice we injected ourselves. Reviewing
 * that turn would make the advisor talk to itself.
 * @param messages - derived session messages.
 * @returns true when the last user message carries the advisor marker.
 */
export function isAdvisorTurn(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    const text = message.content.map(blockText).join(' ').trim()
    return text.startsWith(MARKER)
  }
  return false
}

/**
 * Parse the reviewer's answer into silence, one tagged note, or malformed.
 * Accepts the tag anywhere at the start after stripping quotes/fences, plus the
 * common "Review result: nothing to flag" drift.
 * @param raw - model answer.
 * @returns parsed advice.
 */
export function parseAdvice(raw: string): Advice {
  const text = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim()
  if (/\bnothing to flag\b/i.test(text)) return { kind: 'silence' }
  const match = /^\[(NIT|CONCERN|BLOCKER)\]\s*(.+)$/is.exec(text.replace(/^["'`]+|["'`]+$/g, '').trim())
  if (match) {
    const rawSeverity = match[1]
    const rawRest = match[2]
    if (rawSeverity === undefined || rawRest === undefined) {
      return { kind: 'malformed', raw: text.slice(0, 400) }
    }
    const severity = rawSeverity.toUpperCase() as 'NIT' | 'CONCERN' | 'BLOCKER'
    const note = `[${severity}] ${rawRest.replace(/\s+/g, ' ').trim()}`
    return { kind: 'note', severity, text: note.slice(0, 400) }
  }
  return { kind: 'malformed', raw: text.slice(0, 400) }
}
