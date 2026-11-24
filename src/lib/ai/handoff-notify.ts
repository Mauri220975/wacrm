import {
  sendTemplateMessage,
  sendTextMessage,
} from '@/lib/whatsapp/meta-api'

/**
 * "Soft" handoff helpers for the AI auto-reply bot.
 *
 * When the model can't answer (e.g. a price question with no prices in
 * the knowledge base) the bot no longer goes silent: it tells the
 * customer an advisor will reply shortly, keeps the conversation going,
 * and pings a human advisor on WhatsApp.
 *
 * Configuration (env, all optional):
 *   AI_HANDOFF_MESSAGES            courtesy messages, separated by "||"
 *                                  (one is picked at random)
 *   AI_HANDOFF_NOTIFY_PHONE        advisor's WhatsApp number, digits with
 *                                  country code (e.g. 393756770291)
 *   AI_HANDOFF_NOTIFY_TEMPLATE     approved template name for the advisor
 *                                  alert; body {{1}} = customer, {{2}} = last
 *                                  message. Without it a free-form text is
 *                                  sent, which Meta only delivers when the
 *                                  advisor wrote to the business number in
 *                                  the last 24 h.
 *   AI_HANDOFF_NOTIFY_TEMPLATE_LANG template language code (default "es")
 */

export const DEFAULT_HANDOFF_MESSAGES = [
  '¡Gracias por tu consulta! 😊 Un asesor te responderá en unos 20 minutos con los precios. Mientras tanto, ¿tienes alguna otra consulta en la que te pueda ayudar?',
  '¡Excelente elección! 🙌 Ya le pasé tu consulta a un asesor y en aproximadamente 20 minutos te escribe con los precios. ¿Hay algo más que quieras saber de nuestras telas?',
  '¡Gracias por escribirnos! Un asesor revisará tu pedido y te enviará los precios en unos 20 minutos ⏱️. ¿Te puedo ayudar con alguna otra duda mientras tanto?',
  '¡Con gusto! 😊 Un asesor te confirmará los precios en unos 20 minutos. Mientras esperas, cuéntame: ¿tienes alguna otra consulta sobre colores o tipos de tela?',
]

/** Short nudge for when the customer pushes again while an advisor is
 *  already on the way — keeps the thread warm without re-alerting. */
export const DEFAULT_REMINDER_MESSAGES = [
  'Ya avisé a un asesor y en breve te escribe 🙏. ¿Hay algo más en lo que te pueda ayudar mientras tanto?',
  'Tu consulta ya está con un asesor, te responderá en unos minutos 😊. ¿Tienes alguna otra pregunta?',
]

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function handoffMessages(): string[] {
  const fromEnv = splitList(process.env.AI_HANDOFF_MESSAGES)
  return fromEnv.length > 0 ? fromEnv : DEFAULT_HANDOFF_MESSAGES
}

export function pickRandom<T>(items: T[], rand: () => number = Math.random): T {
  return items[Math.floor(rand() * items.length) % items.length]
}

/** Digits-only advisor number, or null when no alert is configured. */
export function handoffNotifyPhone(): string | null {
  const digits = (process.env.AI_HANDOFF_NOTIFY_PHONE ?? '').replace(/\D/g, '')
  return digits.length >= 8 ? digits : null
}

/** True when `phone` is the advisor's own number — the bot must never
 *  auto-reply to the advisor's chat with the business number. */
export function isAdvisorPhone(phone: string | null | undefined): boolean {
  const advisor = handoffNotifyPhone()
  if (!advisor || !phone) return false
  return phone.replace(/\D/g, '') === advisor
}

/**
 * Best-effort WhatsApp alert to the advisor. Never throws — a failed
 * alert must not break the customer-facing handoff.
 */
export async function notifyAdvisor(args: {
  phoneNumberId: string
  accessToken: string
  customerLabel: string
  lastMessage: string
}): Promise<void> {
  const to = handoffNotifyPhone()
  if (!to) return
  const { phoneNumberId, accessToken, customerLabel } = args
  const lastMessage = args.lastMessage.replace(/\s+/g, ' ').trim().slice(0, 300)
  const template = (process.env.AI_HANDOFF_NOTIFY_TEMPLATE ?? '').trim()
  try {
    if (template) {
      await sendTemplateMessage({
        phoneNumberId,
        accessToken,
        to,
        templateName: template,
        language: (process.env.AI_HANDOFF_NOTIFY_TEMPLATE_LANG ?? 'es').trim() || 'es',
        params: [customerLabel, lastMessage || '-'],
      })
    } else {
      await sendTextMessage({
        phoneNumberId,
        accessToken,
        to,
        text:
          `🔔 Cliente esperando asesor\n` +
          `Cliente: ${customerLabel}\n` +
          `Mensaje: "${lastMessage || '-'}"\n` +
          `El bot le dijo que un asesor responde en ~20 min. Atiéndelo desde el Inbox del CRM.`,
      })
    }
  } catch (err) {
    console.warn('[ai auto-reply] advisor WhatsApp alert failed:', err)
  }
}
