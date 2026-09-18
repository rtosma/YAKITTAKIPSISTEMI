import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-711 (#168) — İkmal Hareket Raporu. REP-703 çatısının İLK kayıtlı
 * raporu: "yeni bir rapor yalnızca tanım eklenerek üretilebilmeli" AC'sinin
 * kanıtı — burada hiçbir yeni route/SQL/pagination kodu YOK, sadece bir
 * tanım. `transactions` tablosu ve filtre kümesi REP-701'in
 * `buildTransactionFilterClause`'ıyla (tenantDb.ts) BİLİNÇLİ olarak aynı
 * alanları kapsar — iki farklı raporun aynı veriye farklı sunumlarla
 * (REP-701: tam Excel dökümü + GENEL TOPLAM; REP-711: sayfalı/filtrelenmiş
 * + CSV/PDF) erişmesi beklenen bir durumdur.
 *
 * REP-711'in KENDİ AC'si için genişletme notları:
 *
 * "Pompa" sütunu: `transactions`'ta ayrı bir pompa kimliği (pump_id/name)
 * YOK — en yakın karşılığı, ikmali TETİKLEYEN donanım cihazının kimliği
 * olan `device_id` (FUEL-407). Manuel kayıtlarda cihaz yok, bu yüzden NULL
 * (bu da AYRICA "manuel" ayrımına katkıda bulunur).
 *
 * "Birim fiyat"/"Tutar" sütunları + GENEL TOPLAM: INV-1503'ün her ikmalde
 * BİR KEZ hesaplayıp yazdığı `unit_cost_liters`/`total_cost` (ağırlıklı
 * ortalama/FIFO) — rapor bunları OLDUĞU GİBİ okur, yeniden hesaplamaz. O
 * tankın hiç fiyatlı alım geçmişi yoksa bu ikisi NULL'dur; SQL SUM() NULL
 * değerleri 0 gibi (katkısız) işler — bu satırlar GENEL TOPLAM'dan
 * DIŞLANMAZ, sadece 0 katkı yapar (reportEngine.ts'in COALESCE(SUM(...),0)
 * sarmalayıcısıyla AYNI ruh).
 *
 * "Yetki tipi" (RFID/manuel/çevrimdışı): AYRI bir sütun/kolon EKLENMEDİ —
 * var olan `type` sütunu ZATEN bu ayrımı taşıyor (bkz. tenantDb.ts: 'Manuel'
 * = elle giriş, 'Otomatik' = RFID/cihaz tetiklemeli, 'Çevrimdışı Senkron' =
 * offline senkron) — sadece başlık/etiket "Yetki Tipi" olarak
 * AÇIKLIĞA kavuşturuldu. `rfid_auth` GÜVENİLİR bir ayrım değildir (manuel
 * girişlerde de varsayılan `true` kalabilir, bkz. routes.ts /dispense) —
 * bu yüzden filtre/sütun KASITLI olarak `type`'a dayanır, `rfid_auth`'a değil.
 *
 * KAPSAM UYARLAMASI — "Excel çıktısı da CSV/PDF ile tutarlı olmalı": REP-703
 * ortak çatısı (bu raporun dayandığı altyapı) yalnızca CSV+PDF export
 * ÜRETİR, Excel ÜRETMEZ (bkz. reports/index.ts). REP-701'in AYRI, ÖNCEDEN
 * KAPANMIŞ .xlsx endpoint'i (`/transactions/export`) KENDİ sabit sütun
 * kümesiyle çalışır ve bu ticket'ın kapsamında GENİŞLETİLMEDİ (Teknik Not:
 * "bu issue yalnızca rapora özgü sorgu/sütun/doğrulama kapsamındadır").
 * AC'nin gerçekçi karşılanan kısmı: `/reports/rep-711/export?format=csv`
 * ile `format=pdf` AYNI veriyi tutarlı üretir (REP-703'ün genel garantisi).
 */
export const rep711DispenseMovement: ReportDefinition = {
  id: 'rep-711',
  title: 'İkmal Hareket Raporu',
  description: 'Tarih, şantiye, araç, sürücü, tank, birim fiyat/tutar ve yetki tipi filtreleriyle ikmal hareketleri.',
  table: 'transactions',
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Tarih', width: 20, format: (v) => new Date(v as string).toLocaleString('tr-TR') },
    { key: 'site_name', header: 'Şantiye', width: 22 },
    { key: 'tank_name', header: 'Tank', width: 16 },
    { key: 'device_id', header: 'Pompa/Cihaz', width: 18, format: (v) => (v ? String(v) : '-') },
    { key: 'vehicle_plate', header: 'Araç Plakası', width: 14 },
    { key: 'driver_name', header: 'Sürücü', width: 20 },
    { key: 'amount_liters', header: 'Alınan Miktar (Litre)', width: 18, format: (v) => Number(v).toFixed(2) },
    { key: 'unit_cost_liters', header: 'Birim Fiyat', width: 14, format: (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(4)) },
    { key: 'total_cost', header: 'Tutar', width: 14, format: (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2)) },
    { key: 'pump_status', header: 'Pompa Durumu', width: 16 },
    { key: 'type', header: 'Yetki Tipi', width: 18 }
  ],
  filters: [
    { key: 'startDate', column: 'created_at', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'created_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'vehiclePlate', column: 'vehicle_plate', type: 'ilike', label: 'Araç Plakası' },
    { key: 'driverName', column: 'driver_name', type: 'exact', label: 'Sürücü' },
    { key: 'tankName', column: 'tank_name', type: 'exact', label: 'Tank' },
    { key: 'fuelType', column: 'fuel_type', type: 'exact', label: 'Yakıt Tipi' },
    { key: 'pumpStatus', column: 'pump_status', type: 'exact', label: 'Pompa Durumu' },
    { key: 'type', column: 'type', type: 'exact', label: 'Yetki Tipi' }
  ],
  aggregates: [
    { key: 'total_liters', column: 'amount_liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_amount', column: 'total_cost', fn: 'SUM', label: 'Toplam Tutar' }
  ],
  allowedRoles: ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep711DispenseMovement);
