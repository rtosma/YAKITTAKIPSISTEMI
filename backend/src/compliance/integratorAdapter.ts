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

export interface IEInvoiceIntegrator {
  readonly providerName: string;
  send(input: IntegratorSendInput): Promise<IntegratorSendResult>;
}

/**
 * Test/geliştirme sentinel'i: adaptör, plaka TAM OLARAK bu değere eşitse
 * gönderimi bilerek reddeder — böylece entegrasyon testleri gerçek bir ağ
 * arızası simüle etmeden FAILED/yeniden-deneme yolunu tetikleyebilir.
 */
export const MOCK_INTEGRATOR_FORCE_FAIL_PLATE = 'TEST-FAIL-0000';

export class MockGibIntegrator implements IEInvoiceIntegrator {
  readonly providerName = 'MOCK_GIB';

  async send(input: IntegratorSendInput): Promise<IntegratorSendResult> {
    if (input.vehiclePlate === MOCK_INTEGRATOR_FORCE_FAIL_PLATE) {
      return { success: false, errorMessage: 'Simüle edilmiş entegratör reddi (test sentinel plaka).' };
    }
    if (!input.xml || input.xml.length === 0) {
      return { success: false, errorMessage: 'Boş belge içeriği entegratöre gönderilemez.' };
    }
    return { success: true, providerReference: `MOCKREF-${input.ettn}` };
  }
}

let integratorSingleton: IEInvoiceIntegrator | undefined;

export function getIntegratorAdapter(): IEInvoiceIntegrator {
  if (!integratorSingleton) integratorSingleton = new MockGibIntegrator();
  return integratorSingleton;
}
