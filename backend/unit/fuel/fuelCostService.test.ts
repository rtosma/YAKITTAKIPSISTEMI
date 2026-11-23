import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { computeFuelCost } from '../../src/fuel/fuelCostService';

/** DB'ye gitmeyen sahte istemci: sıradaki sorgular için hazır satırlar döner, çağrıları kaydeder. */
function fakeClient(...results: Array<Record<string, unknown>>) {
  const query = vi.fn();
  results.forEach((row) => query.mockResolvedValueOnce({ rows: [row] }));
  return { client: { query } as unknown as PoolClient, query };
}
const AT = new Date('2026-03-15T10:30:00.000Z');

describe('computeFuelCost — genel', () => {
  it('miktar ≤ 0 → null ve HİÇ sorgu yapılmaz', async () => {
    const { client, query } = fakeClient();
    expect(await computeFuelCost(client, 'AGIRLIKLI_ORTALAMA', 't1', 'Tank', 'Site', 0, AT)).toBeNull();
    expect(await computeFuelCost(client, 'FIFO', 't1', 'Tank', 'Site', -5, AT)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('computeFuelCost — ağırlıklı ortalama', () => {
  it('birim = Σ(litre×fiyat)/Σlitre (4 basamak), toplam = birim × miktar (2 basamak): 1234.5/300 = 4.115 ₺/L × 20 L = 82.30 ₺', async () => {
    const { client, query } = fakeClient({ weighted_sum: '1234.5', total_liters: '300' });
    expect(await computeFuelCost(client, 'AGIRLIKLI_ORTALAMA', 'tank-1', 'Tank', 'Site', 20, AT)).toEqual({ unitCostLiters: 4.115, totalCost: 82.3 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['tank-1', '2026-03-15']); // ikmalin GERÇEK tarihi, "şimdi" değil
  });
  it('4 basamak yuvarlama: 1000/300 = 3.3333 (3.33333…)', async () => {
    const { client } = fakeClient({ weighted_sum: '1000', total_liters: '300' });
    const r = await computeFuelCost(client, 'AGIRLIKLI_ORTALAMA', 't', 'T', 'S', 30, AT);
    expect(r?.unitCostLiters).toBe(3.3333);
    expect(r?.totalCost).toBe(100);
  });
  it('fiyatlı dolum yoksa null (sessizce 0 sayılmaz)', async () => {
    const { client } = fakeClient({ weighted_sum: '0', total_liters: '0' });
    expect(await computeFuelCost(client, 'AGIRLIKLI_ORTALAMA', 't', 'T', 'S', 50, AT)).toBeNull();
  });
});

describe('computeFuelCost — FIFO', () => {
  it('önce tankın önceki kümülatif tüketimi, sonra lot kesişimi sorgulanır: parametreler [tank, tarih, önceki, önceki+miktar]', async () => {
    const { client, query } = fakeClient({ c: '120' }, { weighted_sum: '900', matched_liters: '60' });
    const r = await computeFuelCost(client, 'FIFO', 'tank-9', 'Ana Tank', 'Gebze', 60, AT);
    expect(r).toEqual({ unitCostLiters: 15, totalCost: 900 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual(['Ana Tank', 'Gebze', '2026-03-15T10:30:00.000Z']);
    expect(query.mock.calls[1][1]).toEqual(['tank-9', '2026-03-15', 120, 180]);
  });
  it('eşleşen lot azsa maliyet EŞLEŞEN kısma göre normalize edilir: 40 L eşleşti (600 ₺) → 15 ₺/L × 60 L = 900 ₺', async () => {
    const { client } = fakeClient({ c: '0' }, { weighted_sum: '600', matched_liters: '40' });
    expect(await computeFuelCost(client, 'FIFO', 't', 'T', 'S', 60, AT)).toEqual({ unitCostLiters: 15, totalCost: 900 });
  });
  it('hiç eşleşme yoksa null', async () => {
    const { client } = fakeClient({ c: '500' }, { weighted_sum: '0', matched_liters: '0' });
    expect(await computeFuelCost(client, 'FIFO', 't', 'T', 'S', 60, AT)).toBeNull();
  });
});
