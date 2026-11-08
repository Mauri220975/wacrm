import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeText } from './csv'

// ============================================================
// Inventory lookup for the AI reply.
//
// Detects the fabric(s) and colour(s) a customer mentions, aggregates
// the matching partidas into an availability LEVEL (never kilos), and
// formats a short block for the system prompt. Matching is pure and
// unit-tested; `lookupInventoryForPrompt` is the I/O wrapper.
// ============================================================

/** Fabric codes → customer-facing names. Unknown codes show as-is. */
export const FABRIC_NAMES: Record<string, string> = {
  J30: 'JERSEY 30/1',
  J20: 'JERSEY 20/1',
  TJ20: 'TERRY EN JERSEY 20/1',
  R30: 'RIB 1X1 EN JERSEY 30/1',
  R20: 'RIB 1X1 EN JERSEY 20/1',
  TR20: 'TERRY 2X1 EN JERSEY 20/1',
}

/**
 * Ordered fabric patterns, run against the normalized message. Each
 * match is blanked out before the next pattern runs, so the specific
 * "rib 1x1 en jersey 30/1" is consumed before the generic "jersey"
 * could also claim it.
 */
const FABRIC_PATTERNS: Array<{ re: RegExp; codes: (m: RegExpMatchArray) => string[] }> = [
  { re: /\b(tr|tj|r|j) ?(20|30)\b/g, codes: (m) => [`${m[1]}${m[2]}`.toUpperCase()] },
  { re: /\bterry ?2 ?x ?1(?: en)?(?: jersey)?(?: ?20(?:\/1)?)?/g, codes: () => ['TR20'] },
  { re: /\bterry(?: en)?(?: jersey)? ?20(?:\/1)?\b/g, codes: () => ['TJ20'] },
  { re: /\bterry\b/g, codes: () => ['TJ20', 'TR20'] },
  {
    re: /\bribb?(?:s|ete)?(?: ?1 ?x ?1)?(?: en)?(?: jersey)? ?(20|30)(?:\/1)?\b/g,
    codes: (m) => [`R${m[1]}`],
  },
  { re: /\bribb?(?:s|ete)?\b/g, codes: () => ['R20', 'R30'] },
  { re: /\bjersey ?(20|30)(?:\/1)?\b/g, codes: (m) => [`J${m[1]}`] },
  { re: /\bjersey\b/g, codes: () => ['J20', 'J30'] },
]

/** Words customers use → the colour word used in the inventory. */
const COLOR_SYNONYMS: Record<string, string> = {
  black: 'negro',
  negra: 'negro',
  white: 'blanco',
  blanca: 'blanco',
  red: 'rojo',
  roja: 'rojo',
  gris: 'plomo',
  grey: 'plomo',
  gray: 'plomo',
  plomito: 'plomo',
  rosa: 'pink',
  rosado: 'pink',
  rosada: 'pink',
  silver: 'silver',
  plateado: 'plata',
  morado: 'mora',
  marron: 'topo',
}

/** Colour words too generic to match on their own. */
const COLOR_STOPWORDS = new Set(['exp', 'claro', 'oscuro', 'mix', 'de', 'con', 'en', 'color'])

export type StockLevel = 'available' | 'low' | 'out' | 'not_listed'

/** Biggest single partida ≥ this → "available"; selling from one lot is preferred. */
export const AVAILABLE_MIN_LOT_KG = 20
/** Total across partidas below this → treated as out of stock (remnants). */
export const OUT_MAX_TOTAL_KG = 1

export interface InventoryStockRow {
  tejido: string
  color: string
  saldo_kg: number
}

export interface StockEntry {
  tejido: string
  color: string | null
  level: StockLevel
  /** Partidas (dye lots) with stock — only meaningful for available/low. */
  lots: number
}

export interface InventoryMatch {
  fabrics: string[]
  /** Specific (tejido, colour) results. */
  entries: StockEntry[]
  /** When only a fabric was mentioned: colours with stock, per fabric. */
  colorsByFabric: Record<string, string[]>
}

const wordRe = (w: string) =>
  new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`)

export function detectFabrics(text: string): { fabrics: string[]; rest: string } {
  let rest = normalizeText(text)
  const found: string[] = []
  for (const { re, codes } of FABRIC_PATTERNS) {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray
      for (const c of codes(m)) if (!found.includes(c)) found.push(c)
      return ' '
    })
  }
  return { fabrics: found, rest }
}

/** Expand synonyms so "gris" also finds PLOMO. */
function withSynonyms(text: string): string {
  const extra = text
    .split(/[^a-z0-9]+/)
    .map((w) => COLOR_SYNONYMS[w])
    .filter(Boolean)
  return extra.length ? `${text} ${extra.join(' ')}` : text
}

/**
 * Colours (as written in the inventory) the text refers to. A full
 * phrase match ("plomo humo") wins over partial word matches that it
 * covers ("plomo" → PLOMO PLATA is dropped), but a lone "plomo" keeps
 * every PLOMO variant.
 */
export function detectColors(text: string, colors: string[]): string[] {
  const msg = withSynonyms(text)
  const full: string[] = []
  const partial: Array<{ color: string; words: string[] }> = []
  for (const color of colors) {
    const norm = normalizeText(color)
    if (!norm) continue
    if (wordRe(norm).test(msg)) {
      full.push(color)
      continue
    }
    const words = norm
      .split(' ')
      .filter((w) => w.length >= 3 && !COLOR_STOPWORDS.has(w) && !/\d/.test(w))
      .filter((w) => wordRe(w).test(msg))
    if (words.length > 0) partial.push({ color, words })
  }
  const fullWords = new Set(full.flatMap((c) => normalizeText(c).split(' ')))
  const keptPartial = partial
    .filter((p) => !p.words.every((w) => fullWords.has(w)))
    .map((p) => p.color)
  return [...full, ...keptPartial]
}

function levelFor(saldos: number[]): { level: StockLevel; lots: number } {
  const positive = saldos.filter((s) => s > 0)
  const total = positive.reduce((a, b) => a + b, 0)
  if (total < OUT_MAX_TOTAL_KG) return { level: 'out', lots: 0 }
  const maxLot = Math.max(...positive)
  return {
    level: maxLot >= AVAILABLE_MIN_LOT_KG ? 'available' : 'low',
    lots: positive.length,
  }
}

const MAX_ENTRIES = 15
const MAX_COLORS_PER_FABRIC = 40

/** Pure: match the customer's text against the stock rows. */
export function matchInventory(
  text: string,
  rows: InventoryStockRow[],
): InventoryMatch | null {
  if (!text.trim() || rows.length === 0) return null
  const { fabrics, rest } = detectFabrics(text)
  const knownColors = Array.from(new Set(rows.map((r) => r.color)))
  const colors = detectColors(rest, knownColors)
  if (fabrics.length === 0 && colors.length === 0) return null

  const entries: StockEntry[] = []
  const colorsByFabric: Record<string, string[]> = {}

  if (colors.length > 0) {
    const groups = new Map<string, number[]>()
    for (const r of rows) {
      if (!colors.includes(r.color)) continue
      if (fabrics.length > 0 && !fabrics.includes(r.tejido)) continue
      const key = `${r.tejido}\u0000${r.color}`
      groups.set(key, [...(groups.get(key) ?? []), Number(r.saldo_kg) || 0])
    }
    for (const [key, saldos] of groups) {
      const [tejido, color] = key.split('\u0000')
      entries.push({ tejido, color, ...levelFor(saldos) })
    }
    // Fabric + colour the customer asked for that isn't in the file at all.
    const stockedFabrics = new Set(rows.map((r) => r.tejido))
    for (const f of fabrics) {
      if (!stockedFabrics.has(f) && !FABRIC_NAMES[f]) continue
      for (const c of colors) {
        if (!groups.has(`${f}\u0000${c}`)) {
          entries.push({ tejido: f, color: c, level: 'not_listed', lots: 0 })
        }
      }
    }
    const rank: Record<StockLevel, number> = { available: 0, low: 1, out: 2, not_listed: 3 }
    entries.sort((a, b) => rank[a.level] - rank[b.level])
  } else {
    for (const f of fabrics) {
      const groups = new Map<string, number[]>()
      for (const r of rows) {
        if (r.tejido !== f) continue
        groups.set(r.color, [...(groups.get(r.color) ?? []), Number(r.saldo_kg) || 0])
      }
      if (groups.size === 0) {
        entries.push({ tejido: f, color: null, level: 'not_listed', lots: 0 })
        continue
      }
      colorsByFabric[f] = Array.from(groups)
        .filter(([, s]) => levelFor(s).level !== 'out')
        .map(([c]) => c)
        .sort()
        .slice(0, MAX_COLORS_PER_FABRIC)
    }
  }

  return { fabrics, entries: entries.slice(0, MAX_ENTRIES), colorsByFabric }
}

const LEVEL_LABEL: Record<StockLevel, string> = {
  available: 'AVAILABLE (very likely in stock)',
  low: 'LOW STOCK (limited quantity, maybe only small lots)',
  out: 'NO STOCK in yesterday\'s list',
  not_listed: 'NOT IN THE LIST',
}

export function fabricLabel(code: string): string {
  return FABRIC_NAMES[code] ? `${FABRIC_NAMES[code]} (${code})` : code
}

/** Format a match as the plain-text block fed to the system prompt. */
export function formatInventoryMatch(match: InventoryMatch, snapshotDate: string | null): string {
  const lines: string[] = []
  if (snapshotDate) lines.push(`Stock list date: ${snapshotDate}`)
  for (const e of match.entries) {
    const what = e.color ? `${fabricLabel(e.tejido)} · ${e.color}` : fabricLabel(e.tejido)
    const lots = e.lots > 1 ? ` — ${e.lots} different dye lots` : ''
    lines.push(`- ${what}: ${LEVEL_LABEL[e.level]}${lots}`)
  }
  for (const [f, colors] of Object.entries(match.colorsByFabric)) {
    lines.push(
      colors.length > 0
        ? `- ${fabricLabel(f)} — colours with stock: ${colors.join(', ')}`
        : `- ${fabricLabel(f)}: ${LEVEL_LABEL.out}`,
    )
  }
  return lines.join('\n')
}

/**
 * Best-effort: load the account's stock, match it against the recent
 * customer text and return the prompt block, or null when the account
 * has no inventory / nothing relevant was mentioned / anything fails.
 */
export async function lookupInventoryForPrompt(
  db: SupabaseClient,
  accountId: string,
  customerText: string,
): Promise<string | null> {
  if (!customerText.trim()) return null
  try {
    const { data, error } = await db
      .from('inventory_items')
      .select('tejido, color, saldo_kg, imported_at')
      .eq('account_id', accountId)
      .limit(20000)
    if (error || !data || data.length === 0) return null
    const match = matchInventory(customerText, data as InventoryStockRow[])
    if (!match || (match.entries.length === 0 && Object.keys(match.colorsByFabric).length === 0)) {
      return null
    }
    // Latest load (merge mode leaves older rows with older timestamps).
    let importedAt: string | null = null
    for (const r of data as Array<{ imported_at?: string }>) {
      if (r.imported_at && (!importedAt || r.imported_at > importedAt)) importedAt = r.imported_at
    }
    const date = importedAt ? importedAt.slice(0, 10) : null
    return formatInventoryMatch(match, date)
  } catch (err) {
    console.error('[inventory] lookup failed:', err)
    return null
  }
}
