import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { importInventoryCsv, readCsvFromRequest } from '@/lib/inventory/import'

/**
 * GET /api/ai/inventory — snapshot summary (any member): row count,
 * when it was imported, and the fabric codes present.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('inventory_items')
      .select('tejido, saldo_kg, imported_at')
      .eq('account_id', accountId)
      .limit(20000)
    if (error) {
      console.error('[ai/inventory GET] error:', error)
      return NextResponse.json({ error: 'load_failed' }, { status: 500 })
    }
    const rows = data ?? []
    const fabrics: Record<string, number> = {}
    let importedAt: string | null = null
    for (const r of rows) {
      if (Number(r.saldo_kg) > 0) fabrics[r.tejido] = (fabrics[r.tejido] ?? 0) + 1
      if (!importedAt || r.imported_at > importedAt) importedAt = r.imported_at
    }
    return NextResponse.json({
      rows: rows.length,
      imported_at: importedAt,
      fabrics,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/inventory  (admin+) — upload a CSV (multipart `file`
 * + `mode`, or raw text body + `?mode=`). mode=replace (default) wipes
 * the previous inventory; mode=merge only adds/updates its partidas.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`inventory:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { csv, mode } = await readCsvFromRequest(request)
    if (!csv) {
      return NextResponse.json({ error: 'file_required' }, { status: 400 })
    }
    const result = await importInventoryCsv(supabaseAdmin(), accountId, csv, mode)
    if (!result.ok) {
      const status = result.error === 'save_failed' ? 500 : 400
      return NextResponse.json({ error: result.error }, { status })
    }
    return NextResponse.json({
      success: true,
      mode,
      imported: result.imported,
      skipped: result.skipped,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
