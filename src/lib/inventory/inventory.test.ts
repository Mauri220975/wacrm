import { describe, it, expect } from 'vitest'
import { parseInventoryCsv, extractColor } from './csv'
import {
  detectFabrics,
  detectColors,
  matchInventory,
  formatInventoryMatch,
  type InventoryStockRow,
} from './lookup'
import { buildSystemPrompt } from '@/lib/ai/defaults'

const SAMPLE = `PARTIDA,TEJIDO,TEJIDO Y COLOR,SALDO KG,PRECIO,INICIO,ULTIMO MOVIMIENTO,OBSERVACION
2677G,J20,J20 NEGRO,18.2,32,2026-01-05,2026-02-10,0
32229MT,J30,J30 ROJO,21.35,0,2026-01-05,2026-01-05,0
R32229,R30,R30 ROJO,0.8,0,2026-01-05,2026-01-05,0
2169C,J30,J30 PLOMO PLATA,19.216667,32,2026-01-07,2026-02-24,0
R2170,R30,R30 PLOMO PLATA,3.05,32,2026-01-07,2026-02-24,0
7024A,J30,J30 BLANCO,2236,28,2026-01-08,2026-01-26,0
R2881,R20,R20 PLOMO HUMO,2.8,32,2026-01-08,2026-06-23,0
R2678,R20,R20 NEGRO,3.2,32,2026-01-08,2026-01-30,0
R7024,R30,R30 BLANCO,116.8,0,2026-01-08,2026-01-15,0
7024G,J30,J30 BLANCO EXP,754.15,0,2026-01-09,2026-01-09,0
R3065,R30,R30 PINK,1.25,32,2026-01-09,2026-03-12,0
6972K,J30,J30 ROJO,42.83,30.5,2026-01-12,2026-01-13,0
3426J,J30,J30 TOPO,17.15,31,2026-01-14,2026-03-16,0
R2896,TR20,TR20 2X1 PLOMO HUMO,3.65,32,2026-01-14,2026-10-15,0
11770C,J30,J30 BLANCO,166.5,27,2026-01-20,2026-01-22,0
`

describe('parseInventoryCsv', () => {
  it('parses the exported sheet', () => {
    const r = parseInventoryCsv(SAMPLE)
    expect(r.error).toBeNull()
    expect(r.rows).toHaveLength(15)
    expect(r.rows[3]).toMatchObject({
      partida: '2169C',
      tejido: 'J30',
      color: 'PLOMO PLATA',
      saldo_kg: 19.216667,
      fecha_inicio: '2026-01-07',
      observacion: null,
    })
    expect(r.rows[13].color).toBe('PLOMO HUMO')
  })

  it('handles semicolons, decimal commas, dd/mm/yyyy and accented headers', () => {
    const csv =
      'Partida;Tejido;Tejido y color;Saldo Kg;Precio;Inicio;Último movimiento;Observación\r\n' +
      '2677G;J20;J20 NEGRO;1.218,5;32;05/01/2026;10/02/2026;0\r\n'
    const r = parseInventoryCsv(csv)
    expect(r.error).toBeNull()
    expect(r.rows[0]).toMatchObject({ saldo_kg: 1218.5, fecha_inicio: '2026-01-05' })
  })

  it('reports missing columns and skips bad rows', () => {
    expect(parseInventoryCsv('A,B\n1,2\n').error).toMatch(/^missing_columns:/)
    const r = parseInventoryCsv(
      'PARTIDA,TEJIDO,TEJIDO Y COLOR,SALDO KG\nX1,J30,J30 ROJO,abc\nX2,J30,J30 ROJO,5\n',
    )
    expect(r.rows).toHaveLength(1)
    expect(r.skipped).toEqual([2])
  })

  it('keeps one row per partida + tejido (last wins)', () => {
    const r = parseInventoryCsv(
      'PARTIDA,TEJIDO,TEJIDO Y COLOR,SALDO KG\nX1,J30,J30 ROJO,5\nX1,J30,J30 ROJO,7\nX1,R30,R30 ROJO,2\n',
    )
    expect(r.rows.map((x) => [x.tejido, x.saldo_kg])).toEqual([
      ['J30', 7],
      ['R30', 2],
    ])
  })

  it('extracts the colour from the description', () => {
    expect(extractColor('J30 BLANCO EXP', 'J30')).toBe('BLANCO EXP')
    expect(extractColor('TR20 2X1 PLOMO HUMO', 'TR20')).toBe('PLOMO HUMO')
  })
})

const rows: InventoryStockRow[] = parseInventoryCsv(SAMPLE).rows

describe('detectFabrics', () => {
  it('recognises codes and names', () => {
    expect(detectFabrics('tienen jersey 30/1?').fabrics).toEqual(['J30'])
    expect(detectFabrics('busco J20 negro').fabrics).toEqual(['J20'])
    expect(detectFabrics('rib 1x1 en jersey 30/1 rojo').fabrics).toEqual(['R30'])
    expect(detectFabrics('terry 2x1').fabrics).toEqual(['TR20'])
    expect(detectFabrics('tienen jersey?').fabrics).toEqual(['J20', 'J30'])
    expect(detectFabrics('hola buenas').fabrics).toEqual([])
  })
})

describe('detectColors', () => {
  const colors = Array.from(new Set(rows.map((r) => r.color)))
  it('prefers the full phrase over partial words', () => {
    expect(detectColors('plomo humo', colors)).toEqual(['PLOMO HUMO'])
    expect(detectColors('blanco', colors)).toEqual(['BLANCO'])
  })
  it('keeps all variants for a generic word, and maps synonyms', () => {
    expect(detectColors('algo en plomo', colors).sort()).toEqual(['PLOMO HUMO', 'PLOMO PLATA'])
    expect(detectColors('en gris', colors).sort()).toEqual(['PLOMO HUMO', 'PLOMO PLATA'])
    expect(detectColors('negra', colors)).toEqual(['NEGRO'])
  })
})

describe('matchInventory', () => {
  it('fabric + colour → level per lot', () => {
    const m = matchInventory('tienen jersey 30 rojo?', rows)!
    expect(m.entries).toEqual([{ tejido: 'J30', color: 'ROJO', level: 'available', lots: 2 }])
  })

  it('small lots are low stock; remnants under 1 kg are out', () => {
    const m = matchInventory('rib 30 en rojo y plomo plata', rows)!
    expect(m.entries).toContainEqual({ tejido: 'R30', color: 'PLOMO PLATA', level: 'low', lots: 1 })
    expect(m.entries).toContainEqual({ tejido: 'R30', color: 'ROJO', level: 'out', lots: 0 })
  })

  it('colour only → every fabric with that colour', () => {
    const m = matchInventory('tienen negro?', rows)!
    expect(m.entries.map((e) => e.tejido).sort()).toEqual(['J20', 'R20'])
  })

  it('fabric + colour not in the file → not_listed', () => {
    const m = matchInventory('j20 rojo', rows)!
    expect(m.entries).toEqual([{ tejido: 'J20', color: 'ROJO', level: 'not_listed', lots: 0 }])
  })

  it('fabric only → colours with stock', () => {
    const m = matchInventory('que colores tienen en j30', rows)!
    expect(m.colorsByFabric.J30).toEqual(['BLANCO', 'BLANCO EXP', 'PLOMO PLATA', 'ROJO', 'TOPO'])
  })

  it('nothing relevant → null', () => {
    expect(matchInventory('hola, cuál es su horario?', rows)).toBeNull()
  })

  it('formats without quantities', () => {
    const text = formatInventoryMatch(matchInventory('jersey 30 blanco', rows)!, '2026-11-07')
    expect(text).toContain('JERSEY 30/1 (J30) · BLANCO: AVAILABLE')
    expect(text).not.toMatch(/2236|166/)
  })
})

describe('buildSystemPrompt inventory', () => {
  it('adds the hedged inventory block only when present', () => {
    const without = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(without).not.toContain('Inventory hint')
    const withInv = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      inventory: '- JERSEY 30/1 (J30) · ROJO: AVAILABLE',
    })
    expect(withInv).toContain('Inventory hint')
    expect(withInv).toContain('never state that something is definitely in stock')
    expect(withInv).toContain('J30) · ROJO')
  })
})
