import { describe, it, expect } from 'vitest';
import { resolveGtip } from '../../src/compliance/gtip';

describe('resolveGtip (COMP-601.1: GTIP yakıt tipine göre, sabit kodlu değil)', () => {
  it.each([
    ['Motorin (Euro Diesel)', '2710194300'], ['dizel', '2710194300'],
    ['Kurşunsuz 95', '2710124500'], ['unleaded 95', '2710124500'], ['Kursunsuz 98', '2710124900'],
    ['LPG (Otogaz)', '2711129700'], ['Gazyağı', '2710192100'], ['Jet A1', '2710192100'],
    ['Fuel Oil', '2710196400'], ['kalorifer yakıtı', '2710196400'], ['AdBlue', '3808940000'], ['Üre çözeltisi', '3808940000']
  ])('%s → %s', (raw, gtip) => expect(resolveGtip(raw).gtip).toBe(gtip));
  it('eşleşme yoksa/boşsa motorin varsayılanı (açıkça etiketli)', () => {
    for (const raw of ['Hidrojen', '', null, undefined]) expect(resolveGtip(raw as string)).toEqual({ gtip: '2710194300', label: 'Motorin (varsayılan)' });
  });
});
