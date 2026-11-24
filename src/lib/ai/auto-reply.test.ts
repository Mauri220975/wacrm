import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  sendTypingIndicator: vi.fn(),
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  state: {
    contact: { name: 'Ana', phone: '51999888777' } as Record<string, unknown> | null,
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    updates: [] as { payload: Record<string, unknown>; isNull: string[] }[],
    rpcCalls: [] as { name: string; args: unknown }[],
    latestInbound: [] as { message_id: string; created_at?: string }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendInteractiveButtons: h.engineSendInteractiveButtons,
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
  sendTextMessage: h.sendTextMessage,
  sendTemplateMessage: h.sendTemplateMessage,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.latestInbound, error: null }),
        }
        return chain
      }
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: h.state.contact, error: null }),
            }),
          }),
        }
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = { ...h.state.updatePayload, ...payload }
          const record = { payload, isNull: [] as string[] }
          h.state.updates.push(record)
          const result = Promise.resolve({ error: null })
          const filter = Object.assign(result, {
            is: (column: string) => {
              record.isNull.push(column)
              return result
            },
          })
          return { eq: () => filter }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    baseUrl: null,
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.contact = { name: 'Ana', phone: '51999888777' }
  delete process.env.AI_HANDOFF_NOTIFY_PHONE
  delete process.env.AI_HANDOFF_NOTIFY_TEMPLATE
  delete process.env.AI_HANDOFF_MESSAGES
  h.sendTextMessage.mockReset().mockResolvedValue({ messageId: 'n1' })
  h.sendTemplateMessage.mockReset().mockResolvedValue({ messageId: 'n2' })
  h.state.claim = true
  h.state.updatePayload = null
  h.state.updates = []
  h.state.rpcCalls = []
  h.state.latestInbound = [{ message_id: 'wamid.inbound-1' }]
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.engineSendInteractiveButtons.mockResolvedValue({ whatsapp_message_id: 'b1' })
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the slot claim is refused after a human takeover', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('leaves the reply to the newer run when another inbound arrived', async () => {
    h.state.latestInbound = [{ message_id: 'wamid.inbound-2' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('replies when the triggering inbound is still the latest', async () => {
    h.state.latestInbound = [{ message_id: 'wamid.inbound-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — soft handoff with buttons', () => {
  const HANDED_OFF = '🤖 AI agent handed off'
  const menuButtons = () =>
    h.engineSendInteractiveButtons.mock.calls[0][0].buttons.map(
      (b: { id: string }) => b.id,
    )

  it('first handoff: writes a summary, shows the 3 buttons, keeps the bot active', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.engineSendInteractiveButtons).toHaveBeenCalledTimes(1)
    expect(h.engineSendInteractiveButtons.mock.calls[0][0].bodyText).toMatch(/asesor/)
    expect(menuButtons()).toEqual(['ai_ho:new', 'ai_ho:wait', 'ai_ho:quote'])
    expect(h.state.updatePayload).not.toHaveProperty('ai_autoreply_disabled')
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(HANDED_OFF)
    expect(h.state.updatePayload).toMatchObject({ ai_handoff_stage: 'menu' })
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
    // No advisor phone configured → no alert.
    expect(h.sendTextMessage).not.toHaveBeenCalled()
  })

  it('uses the configured courtesy messages as the menu body', async () => {
    process.env.AI_HANDOFF_MESSAGES = 'Uno || Dos'
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(['Uno', 'Dos']).toContain(
      h.engineSendInteractiveButtons.mock.calls[0][0].bodyText,
    )
  })

  it('alerts the advisor on WhatsApp (text, or template when configured)', async () => {
    process.env.AI_HANDOFF_NOTIFY_PHONE = '+39 375 677 0291'
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1)
    expect(h.sendTextMessage.mock.calls[0][0].to).toBe('393756770291')
    expect(h.sendTextMessage.mock.calls[0][0].text).toContain('Ana · +51999888777')

    process.env.AI_HANDOFF_NOTIFY_TEMPLATE = 'aviso_asesor'
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(h.sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      templateName: 'aviso_asesor',
      language: 'es',
      params: ['Ana · +51999888777', 'hi'],
    })
  })

  it('assigns the handoff agent only while the thread is still unassigned', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    const assign = h.state.updates.find((u) => 'assigned_agent_id' in u.payload)
    expect(assign?.payload).toEqual({ assigned_agent_id: 'agent-7' })
    expect(assign?.isNull).toEqual(['assigned_agent_id'])
  })

  it('menu open: answers typed text and counts it', async () => {
    h.state.conv = {
      ...h.state.conv,
      assigned_agent_id: 'agent-7',
      ai_handoff_summary: HANDED_OFF,
      ai_handoff_stage: 'menu',
      ai_handoff_free_replies: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('Hello!')
    expect(h.state.updatePayload).toMatchObject({ ai_handoff_free_replies: 1 })
  })

  it('menu open: shows the buttons again once the free replies are used', async () => {
    h.state.conv = {
      ...h.state.conv,
      ai_handoff_summary: HANDED_OFF,
      ai_handoff_stage: 'menu',
      ai_handoff_free_replies: 2,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendInteractiveButtons).toHaveBeenCalledTimes(1)
    expect(h.state.updatePayload).toMatchObject({
      ai_handoff_stage: 'menu',
      ai_handoff_free_replies: 0,
    })
  })

  it('menu open: a repeat handoff re-shows the buttons without a second alert', async () => {
    process.env.AI_HANDOFF_NOTIFY_PHONE = '393756770291'
    h.state.conv = {
      ...h.state.conv,
      ai_handoff_summary: HANDED_OFF,
      ai_handoff_stage: 'menu',
      ai_handoff_free_replies: 0,
    }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendInteractiveButtons).toHaveBeenCalledTimes(1)
    expect(h.sendTextMessage).not.toHaveBeenCalled()
  })

  it('"Nueva consulta" returns to a normal conversation with a fresh counter', async () => {
    h.state.conv = {
      ...h.state.conv,
      ai_handoff_summary: HANDED_OFF,
      ai_handoff_stage: 'menu',
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply({ ...ARGS, handoffChoice: 'new' })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_handoff_stage: null, ai_reply_count: 0 })
    expect(h.engineSendText.mock.calls[0][0].text).toMatch(/ayudar/)
  })

  it('"Seguir esperando" keeps the bot quiet afterwards', async () => {
    h.state.conv = { ...h.state.conv, ai_handoff_summary: HANDED_OFF, ai_handoff_stage: 'menu' }
    await dispatchInboundToAiReply({ ...ARGS, handoffChoice: 'wait' })
    expect(h.state.updatePayload).toMatchObject({ ai_handoff_stage: 'waiting' })
    expect(h.engineSendText).toHaveBeenCalledTimes(1)

    h.engineSendText.mockClear()
    h.state.conv = { ...h.state.conv, ai_handoff_stage: 'waiting' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('"Pedir cotización" collects details and sends the advisor a summary', async () => {
    process.env.AI_HANDOFF_NOTIFY_PHONE = '393756770291'
    h.state.conv = { ...h.state.conv, ai_handoff_summary: HANDED_OFF, ai_handoff_stage: 'menu' }
    await dispatchInboundToAiReply({ ...ARGS, handoffChoice: 'quote' })
    expect(h.state.updatePayload).toMatchObject({ ai_handoff_stage: 'quote' })
    expect(h.engineSendText.mock.calls[0][0].text).toMatch(/kilos/)

    // Still missing details → a normal collecting reply.
    h.engineSendText.mockClear()
    h.state.conv = { ...h.state.conv, ai_handoff_stage: 'quote' }
    h.generateReply.mockResolvedValue({ text: '¿Qué color?', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('¿Qué color?')
    expect(h.sendTextMessage).not.toHaveBeenCalled()

    // All details in → confirmation + advisor alert, then wait.
    h.engineSendText.mockClear()
    h.generateReply.mockResolvedValue({
      text: '[[QUOTE]] Jersey 30/1 · Rojo · 25 kg · Miraflores',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText.mock.calls[0][0].text).toMatch(/cotización/)
    expect(h.engineSendText.mock.calls[0][0].text).not.toContain('[[QUOTE]]')
    expect(h.state.updatePayload).toMatchObject({ ai_handoff_stage: 'waiting' })
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1)
    expect(h.sendTextMessage.mock.calls[0][0].text).toContain(
      'Jersey 30/1 · Rojo · 25 kg · Miraflores',
    )
  })

  it('a tap is ignored once a human replied', async () => {
    h.state.conv = { ...h.state.conv, ai_autoreply_disabled: true, ai_handoff_summary: HANDED_OFF }
    await dispatchInboundToAiReply({ ...ARGS, handoffChoice: 'new' })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('stops once a human replied (ai_autoreply_disabled)', async () => {
    h.state.conv = { ...h.state.conv, ai_autoreply_disabled: true, ai_handoff_summary: 'x' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('starts over when the customer writes after more than 24 h', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.conv = {
      assigned_agent_id: 'agent-7',
      ai_autoreply_disabled: true,
      ai_reply_count: 3,
      ai_handoff_summary: HANDED_OFF,
      ai_handoff_stage: 'waiting',
      ai_handoff_free_replies: 0,
    }
    h.state.latestInbound = [
      { message_id: 'wamid.inbound-1', created_at: new Date().toISOString() },
      {
        message_id: 'wamid.old',
        created_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      },
    ]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updates[0].payload).toMatchObject({
      ai_autoreply_disabled: false,
      ai_handoff_summary: null,
      ai_handoff_stage: null,
      ai_reply_count: 0,
      assigned_agent_id: null,
    })
    expect(h.engineSendText.mock.calls[0][0].text).toBe('Hello!')
  })

  it('does not reset within 24 h', async () => {
    h.state.conv = { ...h.state.conv, ai_autoreply_disabled: true }
    h.state.latestInbound = [
      { message_id: 'wamid.inbound-1', created_at: new Date().toISOString() },
      {
        message_id: 'wamid.prev',
        created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      },
    ]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updates).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('never auto-replies to the advisor number', async () => {
    process.env.AI_HANDOFF_NOTIFY_PHONE = '393756770291'
    h.state.contact = { name: 'Asesor', phone: '393756770291' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
  })
})
