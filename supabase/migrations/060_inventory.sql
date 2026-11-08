-- ============================================================
-- Inventory (fabric stock) — loaded from a daily CSV.
--
-- One row per PARTIDA (dye lot) + TEJIDO. The AI auto-reply looks up
-- the fabric + colour the customer mentions and gets an availability
-- level (never exact kilos) so it can say "very likely in stock".
--
-- Writes go only through `replace_inventory` (service role), in one
-- transaction, with two modes:
--   'replace' — delete the whole account snapshot, load the CSV
--   'merge'   — upsert the CSV rows by (partida, tejido); rows not in
--               the file are left untouched
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  partida            text NOT NULL,
  tejido             text NOT NULL,           -- fabric code, e.g. J30
  descripcion        text NOT NULL,           -- "TEJIDO Y COLOR", e.g. J30 PLOMO PLATA
  color              text NOT NULL,           -- colour part, e.g. PLOMO PLATA
  saldo_kg           numeric NOT NULL DEFAULT 0,
  precio             numeric,
  fecha_inicio       date,
  ultimo_movimiento  date,
  observacion        text,
  imported_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_account_partida_tejido_key
  ON inventory_items (account_id, partida, tejido);

CREATE INDEX IF NOT EXISTS inventory_items_account_tejido_idx
  ON inventory_items (account_id, tejido);

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_items_select ON inventory_items;
CREATE POLICY inventory_items_select ON inventory_items FOR SELECT
  USING (is_account_member(account_id));

-- No INSERT/UPDATE/DELETE policies: members can't write directly.

CREATE OR REPLACE FUNCTION public.replace_inventory(
  p_account_id uuid,
  p_rows jsonb,
  p_mode text DEFAULT 'replace'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF p_mode NOT IN ('replace', 'merge') THEN
    RAISE EXCEPTION 'p_mode must be replace or merge' USING ERRCODE = '22023';
  END IF;

  IF p_mode = 'replace' THEN
    DELETE FROM inventory_items WHERE account_id = p_account_id;
  END IF;

  INSERT INTO inventory_items (
    account_id, partida, tejido, descripcion, color, saldo_kg, precio,
    fecha_inicio, ultimo_movimiento, observacion, imported_at
  )
  SELECT
    p_account_id,
    r->>'partida',
    r->>'tejido',
    r->>'descripcion',
    r->>'color',
    COALESCE((r->>'saldo_kg')::numeric, 0),
    (r->>'precio')::numeric,
    (r->>'fecha_inicio')::date,
    (r->>'ultimo_movimiento')::date,
    NULLIF(r->>'observacion', ''),
    now()
  FROM jsonb_array_elements(p_rows) AS r
  ON CONFLICT (account_id, partida, tejido) DO UPDATE SET
    descripcion       = EXCLUDED.descripcion,
    color             = EXCLUDED.color,
    saldo_kg          = EXCLUDED.saldo_kg,
    precio            = EXCLUDED.precio,
    fecha_inicio      = EXCLUDED.fecha_inicio,
    ultimo_movimiento = EXCLUDED.ultimo_movimiento,
    observacion       = EXCLUDED.observacion,
    imported_at       = EXCLUDED.imported_at;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_inventory(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_inventory(uuid, jsonb, text) TO service_role;
