import {
  sendTemplateMessage,
  sendTextMessage,
  type InteractiveButton,
} from '@/lib/whatsapp/meta-api'

/**
 * "Soft" handoff helpers for the AI auto-reply bot.
 *
 * When the model can't answer (e.g. a price question with no prices in
 * the knowledge base) the bot no longer goes silent: it alerts a human
 * advisor on WhatsApp and sends the customer a message with three
 * buttons — new question / keep waiting / request a quote.
 *
 * Configuration (env, all optional):
 *   AI_HANDOFF_MESSAGES            body of the button message, several
 *                                  separated by "||" (one picked at random)
 *   AI_HANDOFF_NOTIFY_PHONE        advisor's WhatsApp number, digits with
 *                                  country code (e.g. 393756770291)
 *   AI_HANDOFF_NOTIFY_TEMPLATE     approved template name for the advisor
 *                                  alert; body {{1}} = customer, {{2}} = last
 *                                  message / quote. Without it a free-form
 *                                  text is sent, which Meta only delivers
 *                                  when the advisor wrote to the business
 *                                  number in the last 24 h.
 *   AI_HANDOFF_NOTIFY_TEMPLATE_LANG template language code (default "es")
 */

/** Button ids — the webhook routes taps with this prefix to the bot. */
export const HANDOFF_BUTTON_PREFIX = 'ai_ho:'
export type HandoffChoice = 'new' | 'wait' | 'quote'

export const HANDOFF_BUTTONS: InteractiveButton[] = [
  { id: `${HANDOFF_BUTTON_PREFIX}new`, title: '💬 Nueva consulta' },
  { id: `${HANDOFF_BUTTON_PREFIX}wait`, title: '⏳ Seguir esperando' },
  { id: `${HANDOFF_BUTTON_PREFIX}quote`, title: '📋 Pedir cotización' },
]

export function parseHandoffChoice(
  replyId: string | null | undefined,
): HandoffChoice | null {
  if (!replyId || !replyId.startsWith(HANDOFF_BUTTON_PREFIX)) return null
  const choice = replyId.slice(HANDOFF_BUTTON_PREFIX.length)
  return choice === 'new' || choice === 'wait' || choice === 'quote'
    ? choice
    : null
}

/** Typed-text replies the bot gives while the menu is open before it
 *  shows the buttons again. */
export const MENU_FREE_REPLY_LIMIT = 2

export const DEFAULT_HANDOFF_MESSAGES = [
  '¡Gracias por tu consulta! 😊 Un asesor te responderá en unos 20 minutos. Mientras tanto, ¿qué prefieres?',
  '¡Excelente elección! 🙌 Ya le pasé tu consulta a un asesor y en aproximadamente 20 minutos te escribe. Mientras tanto, ¿qué te gustaría hacer?',
  '¡Gracias por escribirnos! Un asesor revisará tu consulta y te responderá en unos 20 minutos ⏱️. ¿Cómo prefieres continuar?',
  '¡Con gusto! 😊 Un asesor te escribirá en unos 20 minutos. Mientras esperas, elige una opción:',
]

/** Body used when the menu is shown again (advisor already alerted). */
export const DEFAULT_REMINDER_MESSAGES = [
  'Tu consulta ya está con un asesor y te escribirá en breve 🙏. ¿Cómo prefieres continuar?',
  'El asesor ya está avisado 😊. Mientras tanto, ¿qué te gustaría hacer?',
]

export const CHOICE_REPLIES: Record<HandoffChoice, string> = {
  new: '¡Claro! 😊 ¿En qué más te puedo ayudar?',
  wait: 'Perfecto 👍 El asesor ya está avisado y te escribirá en breve. ¡Gracias por tu paciencia!',
  quote:
    '¡Genial! 📋 Para preparar tu cotización necesito: tipo de tela, color, cantidad en kilos y distrito de entrega. ¿Me los indicas?',
}

export const QUOTE_SENT_REPLY =
  '¡Listo! ✅ Envié tu solicitud de cotización al asesor. Te escribirá en breve con los precios. ¡Gracias por elegir Mpunto!'

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
  /** Last customer message (handoff) or the quote summary (quote). */
  lastMessage: string
  kind?: 'handoff' | 'quote'
}): Promise<void> {
  const to = handoffNotifyPhone()
  if (!to) return
  const { phoneNumberId, accessToken, customerLabel, kind = 'handoff' } = args
  const detail =
    args.lastMessage.replace(/\s+/g, ' ').trim().slice(0, 300) || '-'
  const template = (process.env.AI_HANDOFF_NOTIFY_TEMPLATE ?? '').trim()
  try {
    if (template) {
      await sendTemplateMessage({
        phoneNumberId,
        accessToken,
        to,
        templateName: template,
        language: (process.env.AI_HANDOFF_NOTIFY_TEMPLATE_LANG ?? 'es').trim() || 'es',
        params: [customerLabel, kind === 'quote' ? `COTIZACIÓN: ${detail}` : detail],
      })
    } else {
      await sendTextMessage({
        phoneNumberId,
        accessToken,
        to,
        text:
          kind === 'quote'
            ? `📋 Solicitud de cotización\nCliente: ${customerLabel}\nPedido: ${detail}\nRespóndele desde el Inbox del CRM.`
            : `🔔 Cliente esperando asesor\nCliente: ${customerLabel}\nMensaje: "${detail}"\nEl bot le dijo que un asesor responde en ~20 min. Atiéndelo desde el Inbox del CRM.`,
      })
    }
  } catch (err) {
    console.warn('[ai auto-reply] advisor WhatsApp alert failed:', err)
  }
}
