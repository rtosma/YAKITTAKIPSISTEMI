import { describe, it, expect } from 'vitest';
import {
  classifyTable, getPurgeableSpec, getConfigurableSpec, PURGEABLE_CLASSES, ANONYMIZABLE_CLASSES, COLD_ARCHIVE_CLASS, PROTECTED_TABLES, MANAGED_TABLES, MASTER_TABLES, MAX_RETENTION_DAYS
} from '../../src/retention/retentionCatalog';

describe('retentionCatalog (ARCH-107 / COMP-606)', () => {
  it('tablo sınıflandırması: purge / korumalı / yönetilen / ana veri / bilinmeyen (null → CI hatası)', () => {
    expect(classifyTable('audit_logs')).toBe('PURGEABLE');
    expect(classifyTable('transactions')).toBe('PROTECTED');
    expect(classifyTable('tenant_archives')).toBe('MANAGED');
    expect(classifyTable('vehicles')).toBe('MASTER');
    expect(classifyTable('monthly_management_reports')).toBe('MASTER');
    expect(classifyTable('bilinmeyen_tablo')).toBeNull();
  });
  it('hiçbir tablo iki sınıfta birden değildir (silinebilir ↔ korumalı çakışması = veri kaybı riski)', () => {
    const all = [...PURGEABLE_CLASSES.map((c) => c.table), ...Object.keys(PROTECTED_TABLES), ...Object.keys(MANAGED_TABLES), ...MASTER_TABLES];
    const dup = all.filter((t, i) => all.indexOf(t) !== i);
    expect(dup).toEqual([]);
  });
  it('purge sınıflarının varsayılanı tabanın altına ve üst sınırın üstüne çıkmaz; mali kayıt tabloları hiçbir purge sınıfında yok', () => {
    for (const c of [...PURGEABLE_CLASSES, ...ANONYMIZABLE_CLASSES, COLD_ARCHIVE_CLASS]) {
      expect(c.defaultDays).toBeGreaterThanOrEqual(c.minDays);
      expect(c.defaultDays).toBeLessThanOrEqual(MAX_RETENTION_DAYS);
    }
    const purgeTables = PURGEABLE_CLASSES.map((c) => c.table);
    for (const t of ['transactions', 'despatch_advice_documents', 'fuel_intake_receipts', 'inventory_movements']) expect(purgeTables).not.toContain(t);
  });
  it('sınıf araması: purge, anonimleştirme ve soğuk arşiv sınıfları bulunur; bilinmeyen undefined', () => {
    expect(getPurgeableSpec('AUDIT_LOG')?.table).toBe('audit_logs');
    expect(getPurgeableSpec('DRIVER_PII')).toBeUndefined();
    expect(getConfigurableSpec('AUDIT_LOG')).toMatchObject({ kind: 'PURGE', table: 'audit_logs', defaultDays: 1825, minDays: 730 });
    expect(getConfigurableSpec('DRIVER_PII')).toMatchObject({ kind: 'ANONYMIZE', table: 'drivers' });
    expect(getConfigurableSpec('COLD_ARCHIVE')).toBe(COLD_ARCHIVE_CLASS);
    expect(getConfigurableSpec('YOK')).toBeUndefined();
  });
});
