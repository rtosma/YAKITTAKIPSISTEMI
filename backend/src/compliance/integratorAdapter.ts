/**
 * COMP-602.1 — e-İrsaliye entegratör adaptör arayüzü.
 *
 * Ticket "provider switching through adapter class changes only" AC'sini
 * istiyor: gerçek bir GİB özel entegratörüne (Uyumsoft, Foriba, Logo vb.)
 * bu ortamda ne ağ erişimi ne de sertifika var — bu yüzden `IEInvoiceIntegrator`
 * sözleşmesini uygulayan tek somut sınıf `MockGibIntegrator`. Üretimde gerçek
 * bir sağlayıcıya geçiş, YENİ bir sınıf yazıp `getIntegratorAdapter()`
 * içindeki tek satırı değiştirmekten ibarettir — çağıran kod (tenantDb.ts)
 * hiç değişmez.
 *
 * Bu modül BİLEREK saf tutuldu (config/env veya db importu yok) — test
 * dosyaları diğer saf modüller (fuelTypes.ts, meterValidation.ts) ile AYNI
 * gerekçeyle bunu doğrudan import edebilir.
 */

export interface IntegratorSendInput {
  /** Üretilip XSD'ye karşı doğrulanmış UBL 2.1 DespatchAdvice XML'i. */
  xml: string;
  documentNumber: string;
  ettn: string;
  vehiclePlate: string;
}

export interface IntegratorSendResult {
  success: boolean;
  /** Sağlayıcının kendi izleme/referans numarası (başarılıysa). */
  providerReference?: string;
  errorMessage?: string;
}

/** COMP-602.2 — GİB'in bir belge için bildirdiği durum. */
export interface IntegratorStatusResult {
  code: string;
  description: string;
  /** true = GİB kararı kesin (başarı/red); false = hâlâ işleniyor, tekrar yoklanmalı. */
  final: boolean;
}

export interface IEInvoiceIntegrator {
  readonly providerName: string;
  send(input: IntegratorSendInput): Promise<IntegratorSendResult>;
  /** COMP-602.2 AC: "Gönderilmiş belgelerin durum yoklaması ve GİB durum kodlarının işlenmesi." */
  checkStatus(providerReference: string): Promise<IntegratorStatusResult>;
}

/**
 * Test/geliştirme sentinel'i: adaptör, plaka TAM OLARAK bu değere eşitse
 * gönderimi bilerek reddeder — böylece entegrasyon testleri gerçek bir ağ
 * arızası simüle etmeden FAILED/yeniden-deneme yolunu tetikleyebilir.
 */
export const MOCK_INTEGRATOR_FORCE_FAIL_PLATE = 'TEST-FAIL-0000';
// COMP-602.2: checkStatus'ün deterministik davranması için send() bu iki
// sentinel plakaya göre providerReference'a bir işaret gömer (aşağıda) —
// checkStatus dışarıdan hiçbir gizli duruma bakmadan, YALNIZCA kendisine
// verilen providerReference'tan karar verir (saf, testte kolay doğrulanır).
export const MOCK_INTEGRATOR_PENDING_STATUS_PLATE = 'TEST-PEND-0000';
export const MOCK_INTEGRATOR_REJECT_STATUS_PLATE = 'TEST-REJT-0000';

export class MockGibIntegrator implements IEInvoiceIntegrator {
  readonly providerName = 'MOCK_GIB';

  async send(input: IntegratorSendInput): Promise<IntegratorSendResult> {
    if (input.vehiclePlate === MOCK_INTEGRATOR_FORCE_FAIL_PLATE) {
      return { success: false, errorMessage: 'Simüle edilmiş entegratör reddi (test sentinel plaka).' };
    }
    if (!input.xml || input.xml.length === 0) {
      return { success: false, errorMessage: 'Boş belge içeriği entegratöre gönderilemez.' };
    }
    const marker =
      input.vehiclePlate === MOCK_INTEGRATOR_PENDING_STATUS_PLATE ? '-PENDING'
      : input.vehiclePlate === MOCK_INTEGRATOR_REJECT_STATUS_PLATE ? '-REJECT'
      : '';
    return { success: true, providerReference: `MOCKREF${marker}-${input.ettn}` };
  }

  async checkStatus(providerReference: string): Promise<IntegratorStatusResult> {
    if (providerReference.includes('-PENDING-')) {
      return { code: '1000', description: 'GİB tarafında işleniyor.', final: false };
    }
    if (providerReference.includes('-REJECT-')) {
      return { code: '1300', description: 'GİB tarafından reddedildi.', final: true };
    }
    return { code: '1200', description: 'GİB tarafından başarıyla işlendi.', final: true };
  }
}

let integratorSingleton: IEInvoiceIntegrator | undefined;

export function getIntegratorAdapter(): IEInvoiceIntegrator {
  if (!integratorSingleton) integratorSingleton = new MockGibIntegrator();
  return integratorSingleton;
}
