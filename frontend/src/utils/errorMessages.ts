/**
 * FE-817 — "Ağ hatası, yetki hatası ve sunucu hatası için ayrı kullanıcı
 * mesajları." Önceden (bkz. commit mesajı: grep `status === 403|401|500`
 * frontend/src/pages → sıfır sonuç) HİÇBİR sayfa `err.status`'a göre
 * ayrım yapmıyordu — her catch bloğu `err.message`'ı olduğu gibi
 * gösteriyordu (backend'in 400 doğrulama mesajları için doğru olan bu
 * davranış, bağlantısı kopan/403/500 durumlarında kullanıcıya ham/teknik
 * bir metin bırakıyordu).
 *
 * `apiFetch` (utils/api.ts) her zaman `Error & {traceId?, status?, details?}`
 * fırlatır (ağ hatası HARİÇ — bkz. orada `networkError`'ın `.traceId` TAŞIMADIĞI
 * notu) — `status` YOKSA bu bir ağ hatasıdır.
 */
export interface ClassifiedError {
  title: string;
  message: string;
  traceId?: string;
  /** 400 gibi doğrulama hataları backend'in KENDİ mesajı zaten anlamlı — genericize ETMEZ. */
  isGenericized: boolean;
}

export function classifyError(err: unknown): ClassifiedError {
  const e = err as { message?: string; status?: number; traceId?: string } | null | undefined;
  const status = e?.status;
  const traceId = e?.traceId;
  const rawMessage = e?.message || 'Bilinmeyen bir hata oluştu.';

  if (status === undefined) {
    return { title: 'Bağlantı Hatası', message: 'Sunucuya bağlanılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.', traceId, isGenericized: true };
  }
  if (status === 401) {
    return { title: 'Oturum Sona Erdi', message: 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.', traceId, isGenericized: true };
  }
  if (status === 403) {
    return { title: 'Yetkiniz Yok', message: 'Bu işlemi gerçekleştirmek için yetkiniz bulunmuyor.', traceId, isGenericized: true };
  }
  if (status >= 500) {
    return { title: 'Sunucu Hatası', message: 'Sunucuda beklenmeyen bir hata oluştu. Lütfen daha sonra tekrar deneyin.', traceId, isGenericized: true };
  }
  // 400/404/409 vb. — backend'in kendi Türkçe doğrulama/iş mantığı mesajı zaten kullanıcıya anlamlı, OLDUĞU GİBİ gösterilir.
  return { title: 'İşlem Başarısız', message: rawMessage, traceId, isGenericized: false };
}
