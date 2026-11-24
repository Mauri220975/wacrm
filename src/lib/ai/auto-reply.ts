import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt, QUOTE_SENTINEL } from './defaults'
import { buildHandoffSummary } from './handoff'
import {
  CHOICE_REPLIES,
  DEFAULT_REMINDER_MESSAGES,
  HANDOFF_BUTTONS,
  MENU_FREE_REPLY_LIMIT,
  QUOTE_SENT_REPLY,
  handoffMessages,
  isAdvisorPhone,
  notifyAdvisor,
  pickRandom,
  type HandoffChoice,
} from './handoff-notify'
import type { ChatMessage } from './types'
import { logAiUsage } from './usage'
import { latestUserMessage, recentCustomerText } from './query'
import { lookupInventoryForPrompt } from '@/lib/inventory/lookup'
import {
  engineSendInteractiveButtons,
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
  /** Set when the inbound is a tap on one of the bot's handoff buttons
   *  (see HANDOFF_BUTTONS); the webhook parses it from the reply id. */
  handoffChoice?: HandoffChoice
}

type HandoffStage = 'menu' | 'waiting' | 'quote' | null

/** Silence after which a customer message starts a fresh bot
 *  conversation — same as WhatsApp's customer-service window. */
const NEW_CONVERSATION_GAP_MS = 24 * 60 * 60 * 1000

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Soft handoff: when the model can't answer, the bot alerts the advisor
 * (AI_HANDOFF_NOTIFY_PHONE) and sends three buttons. The conversation's
 * `ai_handoff_stage` then drives what happens:
 *   - 'menu'    typed text gets up to MENU_FREE_REPLY_LIMIT bot replies,
 *               then the buttons are shown again
 *   - 'waiting' ("Seguir esperando", or after a quote) — bot stays quiet
 *   - 'quote'   ("Pedir cotización") bot collects the details and sends
 *               the advisor a summary
 *   - "Nueva consulta" returns to a normal conversation (counter reset)
 * A customer message after more than 24 h of silence resets everything.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - the contact is the advisor's own number
 *   - auto-reply was disabled for this conversation (an agent replied,
 *     or someone paused it from the inbox)
 *   - a human agent is assigned and no soft handoff is open
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
    handoffChoice,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select(
        'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_handoff_summary, ai_handoff_stage, ai_handoff_free_replies',
      )
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      if (convErr) console.error('[ai auto-reply] conversation read failed:', convErr)
      return
    }

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    // Never let the bot chat with the advisor who receives the alerts.
    if (isAdvisorPhone(contact?.phone)) return

    // A customer coming back after a long silence starts over: bot
    // active again, counter at zero, no open handoff. A bot-made
    // assignment (to the handoff agent) is released too.
    if (
      (conv.ai_autoreply_disabled ||
        conv.ai_handoff_summary ||
        conv.ai_handoff_stage ||
        (conv.ai_reply_count ?? 0) > 0) &&
      (await isNewConversation(db, conversationId))
    ) {
      const reset: Record<string, unknown> = {
        ai_autoreply_disabled: false,
        ai_handoff_summary: null,
        ai_handoff_stage: null,
        ai_handoff_free_replies: 0,
        ai_reply_count: 0,
      }
      if (
        config.handoffAgentId &&
        conv.assigned_agent_id === config.handoffAgentId
      ) {
        reset.assigned_agent_id = null
      }
      await db.from('conversations').update(reset).eq('id', conversationId)
      Object.assign(conv, reset)
    }

    if (conv.ai_autoreply_disabled) return // agent replied / turned off here

    const send = (text: string) =>
      engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
        aiGenerated: true,
      })
    const setConv = async (patch: Record<string, unknown>) => {
      await db.from('conversations').update(patch).eq('id', conversationId)
    }
    const showMenu = async (bodyText: string) => {
      await engineSendInteractiveButtons({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        bodyText,
        buttons: HANDOFF_BUTTONS,
      })
      await setConv({ ai_handoff_stage: 'menu', ai_handoff_free_replies: 0 })
    }

    // ── Button taps: fixed replies, no LLM ──────────────────────────
    if (handoffChoice) {
      if (handoffChoice === 'new') {
        // Back to a normal conversation. The summary stays: the advisor
        // still owes an answer to the earlier question.
        await setConv({
          ai_handoff_stage: null,
          ai_handoff_free_replies: 0,
          ai_reply_count: 0,
        })
      } else {
        await setConv({
          ai_handoff_stage: handoffChoice === 'wait' ? 'waiting' : 'quote',
        })
      }
      await send(CHOICE_REPLIES[handoffChoice])
      return
    }

    const stage = (conv.ai_handoff_stage ?? null) as HandoffStage
    if (stage === 'waiting') return // customer chose to wait for the advisor
    // A human owns the thread — unless it's the bot's own soft handoff.
    if (conv.assigned_agent_id && !conv.ai_handoff_summary) return
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    // Menu open and the customer keeps typing instead of tapping: after
    // a couple of replies, put the buttons in front of them again.
    if (
      stage === 'menu' &&
      (conv.ai_handoff_free_replies ?? 0) >= MENU_FREE_REPLY_LIMIT
    ) {
      await showMenu(pickRandom(DEFAULT_REMINDER_MESSAGES))
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Every gate has passed — we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    if (inboundMessageId) {
      await showTypingIndicator(db, accountId, inboundMessageId)
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const [knowledge, inventory] = await Promise.all([
      retrieveKnowledge(db, accountId, config, latestUserMessage(messages)),
      lookupInventoryForPrompt(db, accountId, recentCustomerText(messages)),
    ])

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      inventory,
      advisorNotified: !!conv.ai_handoff_summary,
      quoteMode: stage === 'quote',
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (
      inboundMessageId &&
      (await hasNewerInbound(db, conversationId, inboundMessageId))
    ) {
      return
    }

    const customerLabel =
      [
        contact?.name,
        contact?.phone ? `+${String(contact.phone).replace(/\D/g, '')}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'Cliente'

    // ── Quote complete: hand the summary to the advisor ─────────────
    if (stage === 'quote' && text.includes(QUOTE_SENTINEL)) {
      const summary = text.split(QUOTE_SENTINEL).join(' ').trim()
      await setConv({ ai_handoff_stage: 'waiting' })
      await send(QUOTE_SENT_REPLY)
      await alertAdvisor(db, accountId, {
        customerLabel,
        lastMessage: summary || lastCustomerText(messages),
        kind: 'quote',
      })
      return
    }

    // ── The model can't answer → soft handoff ───────────────────────
    if (handoff || !text) {
      if (stage === 'menu' || stage === 'quote') {
        // Advisor already alerted — just show the options again.
        await showMenu(pickRandom(DEFAULT_REMINDER_MESSAGES))
        return
      }

      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      // ai_autoreply_disabled stays false: the summary marks the open
      // handoff (inbox banner + dashboard) while the bot stays available.
      await setConv({ ai_handoff_summary: summary })
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      // Assigning fires `on_conversation_assigned`, notifying the agent.
      if (config.handoffAgentId) {
        await db
          .from('conversations')
          .update({ assigned_agent_id: config.handoffAgentId })
          .eq('id', conversationId)
          .is('assigned_agent_id', null)
      }
      // Sent even at the reply cap's edge — the customer must never be
      // left without an answer.
      await showMenu(pickRandom(handoffMessages()))
      await alertAdvisor(db, accountId, {
        customerLabel,
        lastMessage: lastCustomerText(messages),
        kind: 'handoff',
      })
      return
    }

    if (!(await claimSlot(db, conversationId, config))) return

    await send(text)

    if (stage === 'menu') {
      await setConv({
        ai_handoff_free_replies: (conv.ai_handoff_free_replies ?? 0) + 1,
      })
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

function lastCustomerText(messages: ChatMessage[]): string {
  return (
    [...messages].reverse().find((m) => m.role === 'user' && m.content.trim())
      ?.content ?? ''
  )
}

async function alertAdvisor(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  alert: { customerLabel: string; lastMessage: string; kind: 'handoff' | 'quote' },
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await notifyAdvisor({ phoneNumberId, accessToken, ...alert })
  } catch (err) {
    console.warn('[ai auto-reply] advisor alert skipped:', err)
  }
}

/**
 * True when the customer's previous message (before the one that just
 * arrived) is older than NEW_CONVERSATION_GAP_MS.
 */
async function isNewConversation(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('message_id, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(2)
  if (error || !data || data.length < 2) return false
  const previous = Date.parse(String(data[1].created_at ?? ''))
  if (!Number.isFinite(previous)) return false
  return Date.now() - previous > NEW_CONVERSATION_GAP_MS
}

/**
 * Atomically claim a reply slot: the cap check + increment happen in
 * one UPDATE, so concurrent inbounds can never overshoot the cap. If
 * another inbound just took the last slot this returns false and the
 * caller skips the send. (We consume a slot slightly before the send
 * lands — fail-safe: under-reply rather than over-reply.)
 */
async function claimSlot(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  config: { autoReplyMaxPerConversation: number },
): Promise<boolean> {
  const { data: claimed, error: claimErr } = await db.rpc(
    'claim_ai_reply_slot',
    {
      conversation_id: conversationId,
      max_replies: config.autoReplyMaxPerConversation,
    },
  )
  if (claimErr) {
    // A real error here (vs. losing the cap race) is almost always a
    // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
    // service role, or the migration not applied. Log it loudly: a
    // silent return makes "auto-reply never fires" undiagnosable.
    console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
    return false
  }
  return claimed === true
}

async function hasNewerInbound(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('message_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data || data.length === 0) return false
  return data[0].message_id !== inboundMessageId
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}
