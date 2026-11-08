import type { SupabaseClient } from '@supabase/supabase-js'
import { parseInventoryCsv } from './csv'

export type ImportInventoryResult =
  | { ok: true; imported: number; skipped: number[] }
  | { ok: false; error: string }

/** Max CSV size accepted (bytes). ~20k rows fit comfortably. */
export const MAX_INVENTORY_CSV_BYTES = 5 * 1024 * 1024

/**
 * Parse a CSV and atomically replace the account's whole inventory
 * snapshot. `adminDb` must be the service-role client (the RPC is not
 * executable by `authenticated`); callers authorize first.
 */
export type ImportMode = 'replace' | 'merge'

export function parseImportMode(value: unknown): ImportMode {
  return value === 'merge' ? 'merge' : 'replace'
}

/**
 * Parse a CSV and load it in one transaction.
 *   'replace' — wipe the account's inventory first (full daily file)
 *   'merge'   — only add new partidas / update the ones in the file
 */
export async function importInventoryCsv(
  adminDb: SupabaseClient,
  accountId: string,
  csvText: string,
  mode: ImportMode = 'replace',
): Promise<ImportInventoryResult> {
  const parsed = parseInventoryCsv(csvText)
  if (parsed.error) return { ok: false, error: parsed.error }
  if (parsed.rows.length === 0) return { ok: false, error: 'no_valid_rows' }

  const { data, error } = await adminDb.rpc('replace_inventory', {
    p_account_id: accountId,
    p_rows: parsed.rows,
    p_mode: mode,
  })
  if (error) {
    console.error('[inventory] replace_inventory failed:', error)
    return { ok: false, error: 'save_failed' }
  }
  return { ok: true, imported: Number(data) || parsed.rows.length, skipped: parsed.skipped }
}

/**
 * Read the CSV + mode from a request: multipart (`file`, optional
 * `mode` field) or raw text body (mode from `?mode=`). Mode defaults to
 * 'replace'.
 */
export async function readCsvFromRequest(
  request: Request,
): Promise<{ csv: string | null; mode: ImportMode }> {
  const queryMode = new URL(request.url).searchParams.get('mode')
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const mode = parseImportMode(form?.get('mode') ?? queryMode)
    const file = form?.get('file')
    if (!file || typeof file === 'string') return { csv: null, mode }
    if (file.size > MAX_INVENTORY_CSV_BYTES) return { csv: null, mode }
    return { csv: decodeCsv(new Uint8Array(await file.arrayBuffer())), mode }
  }
  const mode = parseImportMode(queryMode)
  const buf = new Uint8Array(await request.arrayBuffer())
  if (buf.byteLength === 0 || buf.byteLength > MAX_INVENTORY_CSV_BYTES) {
    return { csv: null, mode }
  }
  return { csv: decodeCsv(buf), mode }
}

/** UTF-8, falling back to Windows-1252 (Excel's default "CSV" export). */
function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}
