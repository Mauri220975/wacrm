// ============================================================
// PUT /api/v1/inventory — load the stock list from a CSV
// (scope: inventory:write). Meant for a scheduled daily upload:
//
//   # full file: deletes everything before loading
//   curl -X PUT "https://<crm>/api/v1/inventory?mode=replace" \
//     -H "Authorization: Bearer <api key>" \
//     -H "Content-Type: text/csv" --data-binary @inventario.csv
//
//   # only changes: adds new partidas / updates existing ones
//   curl -X PUT "https://<crm>/api/v1/inventory?mode=merge" ...
//
// Also accepts multipart/form-data with `file` (+ optional `mode`).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { importInventoryCsv, readCsvFromRequest } from '@/lib/inventory/import'

export async function PUT(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'inventory:write')
    const { csv, mode } = await readCsvFromRequest(request)
    if (!csv) return fail('bad_request', 'CSV body (max 5 MB) is required', 400)

    const result = await importInventoryCsv(ctx.supabase, ctx.accountId, csv, mode)
    if (!result.ok) {
      if (result.error === 'save_failed') {
        return fail('internal', 'Failed to save inventory', 500)
      }
      return fail('bad_request', `Invalid inventory CSV: ${result.error}`, 400)
    }
    return ok({ mode, imported: result.imported, skipped_lines: result.skipped })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

export const POST = PUT
