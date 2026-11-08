import type { ChatMessage } from './types'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/**
 * The last few customer turns joined, newest last — used for the
 * inventory lookup so "jersey 30" in one message and "¿en negro?" in
 * the next are read together.
 */
export function recentCustomerText(messages: ChatMessage[], turns = 3): string {
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < turns; i--) {
    if (messages[i].role === 'user') out.unshift(messages[i].content)
  }
  return out.join('\n')
}
