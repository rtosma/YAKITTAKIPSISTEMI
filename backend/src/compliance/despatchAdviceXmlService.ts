import { create } from 'xmlbuilder2';
import { parseXml, type Document as XmlDocument } from 'libxmljs2';
import fs from 'node:fs';
import path from 'node:path';

/**
 * COMP-601 — UBL 2.1 DespatchAdvice (e-İrsaliye taslağı) XML üretimi + XSD
 * doğrulaması.
 *
 * Bilinçli kapsam sınırı: bu, GİB'in tam UBL-TR 1.2 e-İrsaliye profilinin
 * DEĞİL, o profilin temelini oluşturan GERÇEK, kamuya açık OASIS UBL 2.1
 * standardının (DespatchAdvice-2) doğrulamasıdır. Gerçek bir GİB gönderimi
 * ayrıca şunları gerektirir: UBL-TR'nin GİB'e özgü ek alanları/kod listeleri,
 * XAdES-BES dijital imza ve sertifikalı bir entegratör bağlantısı (COMP-602,
 * bu ticket'ın kapsamı dışında) — bunların hiçbiri bu ortamda test
 * edilebilir/genuine biçimde üretilemez. Bu implementasyon AC'nin istediği
 * TÜM iş alanlarını (belge no, ETTN, VKN, firma adı/adres, Plaka, Şoför TC,
 * Sevk Tarihi, yakıt tipine göre çözülen GTIP, miktar) doğru UBL elemanlarına
 * basıyor, boşluksuz sıralı belge numarası + kalıcı ETTN üretiyor ve gerçek
 * bir XSD şemasına karşı %100 doğrulanıyor. EKSİK (COMP-602): GİB'in
 * Türkiye'ye özgü UBL-TR profil genişletmesi, Schematron kuralları ve
 * XAdES-BES imza.
 *
 * ./ubl-xsd altındaki 14 dosya, docs.oasis-open.org/ubl/os-UBL-2.1/xsd'den
 * ALINDI (OASIS Open, 2013 — açık standart, yeniden dağıtıma serbest).
 * Yalnızca `<xsd:annotation>` blokları (UN/CEFACT "Core Component" sözlük
 * girdileri — XML Schema doğrulamasını ETKİLEMEZ, saf dokümantasyon) metin
 * tabanlı regex ile çıkarıldı (bkz. git geçmişindeki vendoring script'i);
 * orijinal 2.8 MB → 640 KB. DENENDİ AMA TERK EDİLDİ: Python ElementTree ile
 * parse+re-serialize — XSD dosyaları `type=`/`base=`/`ref=` gibi öznitelik
 * DEĞERİ içindeki QName'lere (örn. `base="ccts-cct:AmountType"`) bel bağlar;
 * ElementTree yalnızca gerçek eleman/öznitelik ADLARINDA kullanılan
 * namespace'leri yeniden yazar, bu QName DEĞERLERİNİ fark etmez ve kök
 * elemandaki "kullanılmayan" xmlns bildirimlerini SESSİZCE düşürür — sonuç
 * yapısal olarak bozuk bir şema (libxmljs2 "Invalid XSD schema" ile
 * reddetti). Regex tabanlı çıkarma orijinal metni (namespace bildirimleri
 * dahil) olduğu gibi bıraktığı için bu sorunu yaşamıyor.
 */

// index.ts'teki swagger-jsdoc `apis: ['./src/routes/*.ts']` İLE AYNI desen:
// esbuild `npm run build` sırasında bu dosyayı TEK bir dist/server.cjs
// içine gömer — o zaman `import.meta.url`/`__dirname` bu kaynak dosyanın
// DEĞİL, derlenmiş bundle'ın konumunu (dist/) verir. Bu yüzden yol,
// __dirname yerine process.cwd()'ye (Dockerfile'da WORKDIR /app, container
// hep oradan başlatılır) göre kuruluyor; Dockerfile buna uygun olarak
// src/compliance'ı ./src/compliance olarak (src/routes ile AYNI şekilde) kopyalar.
const XSD_PATH = path.join(process.cwd(), 'src', 'compliance', 'ubl-xsd', 'maindoc', 'UBL-DespatchAdvice-2.1.xsd');

const NS = {
  root: 'urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'
};

// COMP-601.1 AC: "GTIP kodu yakıt tipine göre değişir ve sabit kodlanmamalı."
// tanks.fuel_type serbest metindir ("Motorin (Euro Diesel)", "Kurşunsuz 95",
// "LPG (Otogaz)"...) — anahtar kelime eşleşmesiyle Türkiye Gümrük Tarife
// Cetveli (GTIP) koduna çeviriyoruz. Eşleşme yoksa motorin varsayılanına
// düşülür (platformun baskın yakıt tipi).
const FUEL_TYPE_GTIP: Array<{ match: RegExp; gtip: string; label: string }> = [
  { match: /motorin|diesel|dizel/i, gtip: '2710194300', label: 'Motorin (kükürt ≤ 10 ppm)' },
  { match: /kur[şs]uns?uz\s*9[5]|benzin\s*9[5]|unleaded\s*9[5]/i, gtip: '2710124500', label: 'Kurşunsuz benzin 95 oktan' },
  { match: /kur[şs]uns?uz\s*98|benzin\s*98|unleaded\s*98/i, gtip: '2710124900', label: 'Kurşunsuz benzin 98 oktan' },
  { match: /lpg|otogaz|otogas/i, gtip: '2711129700', label: 'LPG (otogaz)' },
  { match: /gaz\s*ya[ğg]|kerosene|jet\s*a1?/i, gtip: '2710192100', label: 'Gazyağı / jet yakıtı' },
  { match: /fuel[\s-]*oil|kalorifer/i, gtip: '2710196400', label: 'Fuel oil / kalorifer yakıtı' },
  { match: /adblue|üre\s*çöz|urea/i, gtip: '3808940000', label: 'AdBlue (üre çözeltisi)' }
];
const DEFAULT_GTIP = { gtip: '2710194300', label: 'Motorin (varsayılan)' };

export function resolveGtip(fuelType: string | null | undefined): { gtip: string; label: string } {
  if (fuelType) {
    const hit = FUEL_TYPE_GTIP.find((e) => e.match.test(fuelType));
    if (hit) return { gtip: hit.gtip, label: hit.label };
  }
  return DEFAULT_GTIP;
}

// XSD dosyaları process ömrü boyunca değişmez — her istekte diskten
// okuyup yeniden derlemek yerine bir kez yükleyip önbelleğe alınır.
let cachedXsdDoc: XmlDocument | undefined;
function loadXsd(): XmlDocument {
  if (!cachedXsdDoc) {
    cachedXsdDoc = parseXml(fs.readFileSync(XSD_PATH, 'utf-8'), { baseUrl: XSD_PATH });
  }
  return cachedXsdDoc;
}

export interface DespatchAdviceInput {
  /** COMP-601.1: boşluksuz sıralı belge numarası — cbc:ID olur. */
  documentNumber: string;
  /** COMP-601.1: ETTN (Evrensel Tekil Tanımlama No) — cbc:UUID olur, UUID formatında. */
  ettn: string;
  /** İç ikmal kaydının id'si — cac:OrderReference ile belgeye bağlanır. */
  transactionId: string;
  /** YYYY-MM-DD */
  issueDate: string;
  /** 10 haneli Vergi Kimlik Numarası */
  supplierVkn: string;
  supplierName: string;
  supplierCity: string | null;
  vehiclePlate: string;
  /** 11 haneli TC Kimlik Numarası */
  driverTcNo: string;
  /** tanks.fuel_type serbest metni — GTIP resolveGtip() ile çözülür. */
  fuelType: string;
  amountLiters: number;
}

/**
 * Saf fonksiyon — hiçbir I/O yapmaz, XSD'ye karşı DOĞRULAMAZ (bkz.
 * validateDespatchAdviceXml). AC alanlarının UBL 2.1'deki gerçek karşılıkları:
 *   Belge No    → cbc:ID
 *   ETTN        → cbc:UUID
 *   VKN         → DespatchSupplierParty/Party/PartyTaxScheme/CompanyID
 *   Firma Adı   → DespatchSupplierParty/Party/PartyName/Name
 *   Adres       → DespatchSupplierParty/Party/PostalAddress/CityName
 *   Plaka       → Shipment/TransportHandlingUnit/TransportMeans/RoadTransport/LicensePlateID
 *   Şoför TC    → Shipment/Consignment/CarrierParty/Person/ID
 *   Sevk Tarihi → IssueDate
 *   Yakıt/GTIP  → DespatchLine/Item/Name + Item/CommodityClassification/ItemClassificationCode[listID=GTIP]
 *   Miktar      → DespatchLine/DeliveredQuantity[unitCode=LTR]
 */
export function buildDespatchAdviceXml(input: DespatchAdviceInput): string {
  const { gtip } = resolveGtip(input.fuelType);
  return create({ version: '1.0', encoding: 'UTF-8' })
    .ele(NS.root, 'DespatchAdvice', { 'xmlns:cac': NS.cac, 'xmlns:cbc': NS.cbc })
      .ele(NS.cbc, 'ID').txt(input.documentNumber).up()
      .ele(NS.cbc, 'UUID').txt(input.ettn).up()
      .ele(NS.cbc, 'IssueDate').txt(input.issueDate).up()
      .ele(NS.cac, 'OrderReference')
        .ele(NS.cbc, 'ID').txt(input.transactionId).up()
      .up()
      .ele(NS.cac, 'DespatchSupplierParty')
        .ele(NS.cac, 'Party')
          .ele(NS.cac, 'PartyName')
            .ele(NS.cbc, 'Name').txt(input.supplierName).up()
          .up()
          .ele(NS.cac, 'PostalAddress')
            .ele(NS.cbc, 'CityName').txt(input.supplierCity ?? 'Türkiye').up()
            .ele(NS.cac, 'Country')
              .ele(NS.cbc, 'Name').txt('Türkiye').up()
            .up()
          .up()
          .ele(NS.cac, 'PartyTaxScheme')
            .ele(NS.cbc, 'CompanyID').txt(input.supplierVkn).up()
            .ele(NS.cac, 'TaxScheme').up()
          .up()
        .up()
      .up()
      .ele(NS.cac, 'DeliveryCustomerParty')
        .ele(NS.cac, 'Party').up()
      .up()
      .ele(NS.cac, 'Shipment')
        .ele(NS.cbc, 'ID').txt(`SEVK-${input.documentNumber}`).up()
        .ele(NS.cac, 'Consignment')
          .ele(NS.cbc, 'ID').txt(`CONS-${input.documentNumber}`).up()
          .ele(NS.cac, 'CarrierParty')
            .ele(NS.cac, 'Person')
              .ele(NS.cbc, 'ID').txt(input.driverTcNo).up()
            .up()
          .up()
        .up()
        .ele(NS.cac, 'TransportHandlingUnit')
          .ele(NS.cac, 'TransportMeans')
            .ele(NS.cac, 'RoadTransport')
              .ele(NS.cbc, 'LicensePlateID').txt(input.vehiclePlate).up()
            .up()
          .up()
        .up()
      .up()
      .ele(NS.cac, 'DespatchLine')
        .ele(NS.cbc, 'ID').txt('1').up()
        .ele(NS.cbc, 'DeliveredQuantity', { unitCode: 'LTR' }).txt(input.amountLiters.toFixed(2)).up()
        .ele(NS.cac, 'OrderLineReference')
          .ele(NS.cbc, 'LineID').txt('1').up()
        .up()
        .ele(NS.cac, 'Item')
          .ele(NS.cbc, 'Name').txt(input.fuelType).up()
          .ele(NS.cac, 'CommodityClassification')
            .ele(NS.cbc, 'ItemClassificationCode', { listID: 'GTIP' }).txt(gtip).up()
          .up()
        .up()
      .up()
    .end({ prettyPrint: true });
}

export interface XsdValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * AC: "XSD şema doğrulamasından %100 hatasız geçmelidir." Gerçek libxml2
 * (native binding) ile, gerçek OASIS UBL 2.1 DespatchAdvice şema zincirine
 * karşı doğrular — sahte/basitleştirilmiş bir şema DEĞİL.
 */
export function validateDespatchAdviceXml(xmlString: string): XsdValidationResult {
  const xmlDoc = parseXml(xmlString);
  const valid = xmlDoc.validate(loadXsd());
  return { valid, errors: xmlDoc.validationErrors.map((e) => e.message.trim()) };
}

/**
 * Üretir VE doğrular. Doğrulama başarısız olursa (bu asla olmamalı — builder
 * kendi ürettiği yapının şemaya uyduğu bilinen bir şekilde yazıldı; bu
 * yalnızca ileride builder'a yapılacak bir değişikliğin şemayı bozması
 * ihtimaline karşı bir güvenlik ağı) sessizce geçersiz bir dosya döndürmek
 * yerine erken ve gürültülü şekilde patlar.
 */
export function generateDespatchAdviceXml(input: DespatchAdviceInput): string {
  const xml = buildDespatchAdviceXml(input);
  const { valid, errors } = validateDespatchAdviceXml(xml);
  if (!valid) {
    throw new Error(`Üretilen UBL XML, UBL 2.1 DespatchAdvice şemasına uymuyor: ${errors.join('; ')}`);
  }
  return xml;
}
