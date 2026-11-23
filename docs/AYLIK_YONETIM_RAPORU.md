# AI destekli aylık yönetim raporu (REP-724)

Her ay, yöneticiye **okunabilir bir özet** üretir ve e-postayla gönderir: o ayın **ölçülen verisi** ile bunun üzerine **yapay zekâ (Gemini) yorumu**. İki katman her çıktıda **ayrı** gösterilir; okuyucu neyin ölçüm, neyin yorum olduğunu bilir.

| | Ölçülen veri | Yapay zekâ yorumu |
|---|---|---|
| Kaynağı | Sistem kayıtları (SQL) — `rep-724` raporu | Gemini (`gemini-2.0-flash`, AI-502 ile aynı SDK/anahtar) |
| Kim üretir | Sistem; model bu sayıları **üretmez** | Model; **her iddiası doğrulanır** |
| PDF'te | **A.** koyu şerit "ÖLÇÜLEN VERİ" | **B.** amber şerit "YAPAY ZEKÂ YORUMU — ölçüm değildir", krem zeminli bloklar, her blokta "MODEL YORUMU" |
| API'de | `measured` (`origin: MEASURED`) | `aiCommentary` (`origin: MODEL`) |
| Yoksa | Hiç yoksa sayılmaz: her rapor bunu içerir | Model erişilemezse rapor **yine üretilir**, B bölümü nedenini söyler |

## Uçlar

| Uç | Rol | Ne yapar |
|---|---|---|
| `GET /reports/rep-724?month=YYYY-MM` | SA · CO · SM | Ölçülen veri (şantiye satırları + toplamlar; sayfalı JSON) |
| `GET /reports/rep-724/export?format=csv\|xlsx\|pdf&month=…` | SA · CO · SM | Aynı verinin CSV / **Excel** / PDF tablosu (REP-703 çatısı; `xlsx` bu ticketle **tüm raporlara** eklendi) |
| `POST /management-reports` `{month?, regenerate?, sendEmail?}` | SA · CO | Şimdi üretir (varsayılan ay: önceki ay). Aynı ay tekrar çağrılırsa mevcut raporu döner, model **yeniden çağrılmaz** |
| `GET /management-reports` | SA · CO | Üretilmiş aylar + yapay zekâ durumu + e-posta durumu |
| `GET /management-reports/{ay}` | SA · CO · SM | `measured` ve `aiCommentary` **ayrı alanlarda** |
| `GET /management-reports/{ay}/pdf` | SA · CO · SM | Tam rapor PDF'i (A + B) |

SA = SUPER_ADMIN, CO = COMPANY_OWNER, SM = SITE_MANAGER. Diğer roller 403.

## Rol bazlı görünürlük

- **Firma yöneticisi (CO/SA):** firma geneli ölçülen veri + model yorumu.
- **Şantiye yöneticisi (SM):** yalnızca **kendi şantiyesinin** ölçülen verisi (JSON, CSV, XLSX, PDF, e-posta). Model yorumu **gösterilmez** (`SITE_SCOPE_RESTRICTED`): yorum firma geneli veriyle yazıldığından başka şantiyeleri de anar. Şantiyesi tanımsız bir SM 403 alır (firma geneli sızmaz).
- Tüm sorgular tenant izolasyonuna (RLS) tabidir; başka firmanın raporu 404.

## Model çıktısının çapraz doğrulanması

Model, sistemin verdiği **ölçüm listesini** (`total_liters = 675.4`, `site:<şantiye>:liters = …`, `vehicle:<plaka>:liters = …`) yorumlar. Cevabı `summary`, `findings`, `risks`, `recommendations` olarak **JSON** verir (Zod ile biçim doğrulanır). Ardından `verifyNarrative` her ifadeyi sistem verisiyle karşılaştırır; **geçemeyen ifade rapordan çıkarılır** ve nedenle `ai_rejected`'a yazılır:

| Kural | Red nedeni |
|---|---|
| Bulgu ve risk **dayanak ölçüm** (`evidence: {metric, value}`) göstermeli | `NO_EVIDENCE` |
| Dayanak ölçüm listede var olmalı | `UNKNOWN_METRIC:<ad>` |
| Dayanak değeri gerçek ölçümle eşleşmeli (± 0,01) | `EVIDENCE_MISMATCH:<ad> (iddia …, gerçek …)` |
| Metindeki **birimli** her sayı (L, ₺, %, ikmal, alarm…) gerçek bir ölçümün, yazıldığı ondalık basamağa **yuvarlanmışı** olmalı (`675 L` ✓ `675,4 L` ✓ `676 L` ✗) | `TEXT_NUMBER_UNVERIFIED:<sayı>` |
| Metinde geçen plaka, ölçülen en çok tüketen araçlardan biri olmalı | `UNKNOWN_VEHICLE:<plaka>` |

Öneriler dayanak istemez ama metinlerindeki birimli sayı ve plaka kuralları geçerlidir. Sonuç durumu (`ai_status`):

| Durum | Anlamı |
|---|---|
| `URETILDI` | Tüm ifadeler doğrulandı |
| `KISMEN_DOGRULANDI` | Bazıları çıkarıldı; PDF "N ifade doğrulanamadığı için çıkarıldı" der |
| `DOGRULANAMADI` | Hiçbiri doğrulanamadı → B bölümü boş, uydurma metin rapora **girmez** |
| `MODEL_ERISILEMEDI` | Anahtar yok / çağrı hatası / 45 sn zaman aşımı → rapor yalnızca ölçülen veriyle |
| `GECERSIZ_CIKTI` | JSON değil ya da şemaya uymuyor |
| `MODUL_KAPALI` | Firmanın paketinde `aiAnomaly` modülü kapalı (model hiç çağrılmaz) |
| `VERI_YOK` | Ayda ikmal/alarm yok (model çağrılmaz, e-posta atlanır) |

**Sınır (bilinçli):** birimsiz sayılar ("3 şantiye") ve nitel yargılar ("tüketim makul") doğrulanamaz; bu yüzden rapor B bölümünü "model çıktısıdır, ölçüm değildir" diye etiketler ve önerileri "modelin görüşü" olarak sunar.

## Kişisel veri

Modele **sürücü/personel adı hiç gitmez** — yalnızca şantiye adları, araç plakaları (kurumsal varlık tanımlayıcısı) ve toplamlar (COMP-606, [KVKK_ENVANTER.md](KVKK_ENVANTER.md)).

## Otomatik üretim ve gönderim

- Saatlik süpürücü (`index.ts`, REP-705/AI-502 ile aynı düz `setInterval` deseni — BullMQ yok) her ayın **1'inde 08:00'dan** (Europe/Istanbul, sabit UTC+3) itibaren **önceki ayın** raporunu üretir ve gönderir.
- Firma × ay için **tek satır** (`UNIQUE(tenant_id, period_month)`): sonraki turlar yeni rapor üretmez.
- **Alıcılar:** e-postası olan COMPANY_OWNER'lar (firma geneli PDF) ve SITE_MANAGER'lar (yalnızca kendi şantiyesinin PDF'i, yorumsuz). PDF ektir.
- **Hata → yeniden deneme:** teslim edilen alıcılar `emailed_user_ids`'te tutulur; sonraki turlar **yalnızca teslim edilemeyenlere** dener (çift e-posta yok). En çok 3 deneme; sonra `KALICI_BAŞARISIZ`.
- SMTP yapılandırması NOTIF-1602 ile aynıdır (`SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM`); `GEMINI_API_KEY` yoksa rapor yorumsuz üretilir.

## Tanımlar (ölçülen veri)

- **Ay:** `month=YYYY-MM`, varsayılan bir önceki takvim ayı; gün sınırı rep-711'le aynı (`::date`, sunucu saat dilimi) — aynı tarihlerle rep-711'i açan aynı ikmalleri görür.
- **Tutar:** INV-1503'ün dondurulmuş `total_cost`'u (fiyatsız ikmal 0 katkı).
- **Önceki aya göre değişim:** önceki ay 0 ise **tanımsız** (boş) — sonsuz yüzde uydurulmaz.
- **Alarm:** ay içinde **ilk görülen** alarm sayısı; şantiyesiz alarmlar `-` satırındadır ve yalnızca firma geneli görüntüleyene görünür.

## KAPSAM UYARLAMASI (ticket'tan bilinçli sapmalar)

- **pdfmake yerine pdfkit:** REP-703 çatısının PDF motoru pdfkit'tir ve Türkçe karakterli Roboto fontu onunla vendored; ikinci bir PDF kütüphanesi eklenmedi.
- **BullMQ/REP-705 zamanlaması yerine saatlik süpürücü:** kod tabanında BullMQ yok; REP-705 zamanlamaları yalnızca CSV ekler (bu raporun PDF'i kendi süpürücüsünden gider).
- **Excel:** REP-703 çatısı Excel üretmiyordu; `format=xlsx` bu ticketle **tüm raporlar için** eklendi (`reports/xlsxExport.ts`; aynı satırlar, sayı sütunları Excel'de sayı hücresi).

## Testler

`backend/test/test_rep724_monthly_management_report.ts` (21 test; el hesabı sabit veri seti, gerçek Postgres + gerçek yerel SMTP, model test çifti): ay sınırları, XLSX = CSV = JSON hücre hücre, rol görünürlüğü, çapraz doğrulama (yanlış toplam, uydurma yüzde, olmayan ölçüm/plaka), model erişilemezse üretim, modül kapalı/veri yok, e-posta içeriği (rol bazlı) ve yeniden deneme, idempotency, tenant izolasyonu, PDF katman ayrımı.
