// ============================================================
// Inventory CSV → rows for `replace_inventory`.
//
// Expected columns (header names are matched loosely — case, accents,
// extra spaces and a trailing "KG" don't matter):
//   PARTIDA | TEJIDO | TEJIDO Y COLOR | SALDO KG | PRECIO | INICIO |
//   ULTIMO MOVIMIENTO | OBSERVACION
//
// Handles comma / semicolon / tab delimiters (Excel in Spanish locales
// exports ";" with decimal commas), quoted fields, ISO or dd/mm/yyyy
// dates. Pure and unit-tested.
// ============================================================

export interface InventoryRow {
  partida: string
  tejido: string
  descripcion: string
  color: string
  saldo_kg: number
  precio: number | null
  fecha_inicio: string | null
  ultimo_movimiento: string | null
  observacion: string | null
}

export interface ParseInventoryResult {
  rows: InventoryRow[]
  /** 1-based line numbers (including header) of rows that were skipped. */
  skipped: number[]
  /** Fatal problem with the file as a whole (missing columns, empty). */
  error: string | null
}

export const MAX_INVENTORY_ROWS = 20_000

type Field =
  | 'partida'
  | 'tejido'
  | 'descripcion'
  | 'saldo_kg'
  | 'precio'
  | 'fecha_inicio'
  | 'ultimo_movimiento'
  | 'observacion'

const HEADER_ALIASES: Record<Field, string[]> = {
  partida: ['partida', 'lote'],
  tejido: ['tejido', 'codigo tejido'],
  descripcion: ['tejido y color', 'descripcion', 'tejido color'],
  saldo_kg: ['saldo kg', 'saldo', 'saldo kgs', 'stock', 'kg', 'kilos'],
  precio: ['precio'],
  fecha_inicio: ['inicio', 'fecha inicio', 'ingreso', 'fecha ingreso'],
  ultimo_movimiento: ['ultimo movimiento', 'fecha ultimo movimiento'],
  observacion: ['observacion', 'observaciones'],
}

const REQUIRED: Field[] = ['partida', 'tejido', 'descripcion', 'saldo_kg']

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function detectDelimiter(headerLine: string): string {
  const counts = [',', ';', '\t'].map((d) => ({
    d,
    n: headerLine.split(d).length - 1,
  }))
  counts.sort((a, b) => b.n - a.n)
  return counts[0].n > 0 ? counts[0].d : ','
}

/** RFC-4180-ish split of the whole text into records. */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === delimiter) {
      record.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else field += c
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

function parseNumber(raw: string, decimalComma: boolean): number | null {
  let s = raw.trim().replace(/\s/g, '')
  if (!s) return null
  if (decimalComma) s = s.replace(/\./g, '').replace(',', '.')
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function parseDate(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return toIso(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    return toIso(year, +m[2], +m[1]) // dd/mm/yyyy (Latin American format)
  }
  return null
}

function toIso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Colour = description minus the fabric code, and minus a leading rib
 * spec ("2X1", "1X1") that's already implied by the fabric code.
 * "TR20 2X1 PLOMO HUMO" (TR20) → "PLOMO HUMO".
 */
export function extractColor(descripcion: string, tejido: string): string {
  let rest = descripcion.trim().replace(/\s+/g, ' ')
  const code = tejido.trim()
  if (code && rest.toUpperCase().startsWith(code.toUpperCase())) {
    rest = rest.slice(code.length).trim()
  }
  rest = rest.replace(/^\d\s*x\s*\d\s+/i, '').trim()
  return rest.toUpperCase() || descripcion.trim().toUpperCase()
}

export function parseInventoryCsv(text: string): ParseInventoryResult {
  const clean = text.replace(/^﻿/, '')
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = detectDelimiter(firstLine)
  const records = splitRecords(clean, delimiter).filter((r) =>
    r.some((f) => f.trim() !== ''),
  )
  if (records.length < 2) {
    return { rows: [], skipped: [], error: 'empty' }
  }

  const header = records[0].map(normalizeText)
  const index: Partial<Record<Field, number>> = {}
  for (const field of Object.keys(HEADER_ALIASES) as Field[]) {
    const i = header.findIndex((h) => HEADER_ALIASES[field].includes(h))
    if (i >= 0) index[field] = i
  }
  const missing = REQUIRED.filter((f) => index[f] === undefined)
  if (missing.length > 0) {
    return { rows: [], skipped: [], error: `missing_columns:${missing.join(',')}` }
  }
  if (records.length - 1 > MAX_INVENTORY_ROWS) {
    return { rows: [], skipped: [], error: 'too_many_rows' }
  }

  const decimalComma = delimiter === ';'
  const get = (r: string[], f: Field) =>
    index[f] === undefined ? '' : (r[index[f]!] ?? '').trim()

  const rows: InventoryRow[] = []
  const skipped: number[] = []
  records.slice(1).forEach((r, i) => {
    const partida = get(r, 'partida')
    const tejido = get(r, 'tejido').toUpperCase()
    const descripcion = get(r, 'descripcion')
    const saldo = parseNumber(get(r, 'saldo_kg'), decimalComma)
    if (!partida || !tejido || !descripcion || saldo === null) {
      skipped.push(i + 2)
      return
    }
    const obs = get(r, 'observacion')
    rows.push({
      partida,
      tejido,
      descripcion: descripcion.toUpperCase(),
      color: extractColor(descripcion, tejido),
      saldo_kg: saldo,
      precio: parseNumber(get(r, 'precio'), decimalComma),
      fecha_inicio: parseDate(get(r, 'fecha_inicio')),
      ultimo_movimiento: parseDate(get(r, 'ultimo_movimiento')),
      observacion: obs && obs !== '0' ? obs : null,
    })
  })

  // One row per (partida, tejido) — the DB upserts on that key and a
  // single statement can't touch the same row twice. Last one wins.
  const byKey = new Map<string, InventoryRow>()
  for (const row of rows) byKey.set(`${row.partida}\u0000${row.tejido}`, row)

  return { rows: Array.from(byKey.values()), skipped, error: null }
}
