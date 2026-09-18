/**
 * NOTIF-1601 AC: "Yeni bir bildirim tipi yalnızca şablon ve eşleme eklenerek
 * tanımlanabilmelidir." Ticket handlebars/eta öneriyor — bu kod tabanında
 * (ve hiçbir bağımlılığında) yok; basit bir `{{degisken}}` regex
 * değiştiricisi (bkz. notificationService.ts renderTemplate) YENİ bir npm
 * paketi eklemeden aynı AC'yi karşılıyor. Şablonlar kod içi (DB'de DEĞİL,
 * ticket'ın notu olan "tenant bazında özelleştirme" bu yüzden bu ticket'ın
 * kapsamında YOK) — yeni bir bildirim tipi eklemek bu objeye YENİ BİR SATIR
 * eklemek demektir, notifyEvent()'in KENDİSİNE dokunulmaz.
 */
export interface NotificationTemplate {
  titleTemplate: string;
  bodyTemplate: string;
  /**
   * NOTIF-1605 AC: "Güvenlik bildirimleri tamamen kapatılamamalıdır... en
   * azından bir kanal zorunlu kalmalıdır." `true` ise IN_APP kanalı
   * kullanıcı tercihi/sessize alma NE OLURSA OLSUN her zaman teslim edilir
   * (bkz. notificationService.ts isDeliveryAllowedByPreference) — SADECE
   * IN_APP için, diğer kanallar (EMAIL/SMS/...) hâlâ tercihe tabidir.
   */
  isSecurityCritical?: boolean;
}

export const NOTIFICATION_TEMPLATES: Record<string, NotificationTemplate> = {
  LICENSE_EXPIRY_WARNING: {
    titleTemplate: 'Lisans süresi {{daysRemaining}} gün içinde doluyor',
    bodyTemplate: '{{companyName}} firmasının lisansı {{licenseExpiry}} tarihinde sona erecek.'
  },
  TANK_LOW_STOCK_FORECAST: {
    titleTemplate: '{{tankName}} — stok uyarısı',
    bodyTemplate: 'Tahmini bitiş: {{estimatedDaysRemaining}} gün. Mevcut seviye: {{currentLevelLiters}} L.'
  },
  FIRE_RECORD_HIGH_VALUE: {
    titleTemplate: '{{tankName}} — onay bekleyen yüksek değerli fire kaydı',
    bodyTemplate: '{{quantityLiters}} L {{classification}} sınıflandırmasıyla onay bekliyor.'
  },
  // AI-501'in hırsızlık tespiti KENDİ alarm mekanizmasını kullanıyor
  // (notifyEvent'e henüz bağlanmadı) — bu tip, "güvenlik kritik" AC'sini
  // somut bir örnekle egzersiz etmek için burada TANIMLIDIR.
  THEFT_DETECTED: {
    titleTemplate: '🚨 Hırsızlık şüphesi: {{tankName}}',
    bodyTemplate: '{{siteName}} şantiyesinde yetkisiz akış tespit edildi.',
    isSecurityCritical: true
  }
};
