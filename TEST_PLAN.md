# TEST PLANI — YAKITTAKİPSİSTEMİ

> Bu doküman `ISSUES_ROADMAP.md` ile aynı çalışma biçimini izler: `- [ ]`
> maddeleri sırayla ele alınıp tamamlandıkça işaretlenir. Amaç, bu projenin
> **her katmanının** (backend, frontend, veritabanı, güvenlik, altyapı)
> gerçekten test edilmesini sağlamak, hiçbir güvenlik açığı bırakmamak ve
> bunu yaparken **kod karmaşası eklememek**.

---

## 0. Mevcut Durum (Baseline) — Bu Tarama Sırasında Tespit Edildi

Plan yazılmadan önce kod tabanı tarandı. Sıfırdan başlamıyoruz — mevcut
güçlü/zayıf noktalar şöyle:

| Katman | Durum |
|---|---|
| **Backend** | 59 adet `test/test_*.ts` entegrasyon testi (gerçek HTTP + gerçek Postgres + gerçek Redis, mock YOK). Neredeyse her `ISSUES_ROADMAP.md` maddesinin kendi testi var. |
| **Backend güvenlik** | RLS (46 tenant tablosu, `check-rls-coverage.mjs` ile mekanik doğrulama), `gitleaks`, `check-no-raw-pool-query.mjs`, `check-no-direct-process-env.mjs`, `check-env-example-sync.mjs`, HMAC+nonce donanım auth, hesap kilitleme, 2FA, rate limiting, RES-905 graceful-degradation. |
| **Frontend** | **SIFIR test.** Test framework kurulu değil (`package.json`'da vitest/jest/playwright/cypress yok). Tek kontrol `tsc --noEmit` (lint diye adlandırılmış). |
| **Veritabanı** | 48 tablo, 46'sı RLS'li ve statik script ile garanti altında. Çapraz-tenant izolasyonu `test_195_tenant_isolation.ts` (TEST-1003) ile aktif test ediliyor. |
| **CI** | 7 iş: `quality-and-tests`, `auth-integration-test`, `secret-scan`, `build-bundle`, `docker-security-scan` (Trivy), `deploy-zero-downtime`, `load-test` (yalnızca manuel, k6). |
| **Eksik** | `npm audit`/bağımlılık zafiyet taraması YOK (Trivy yalnızca imaj seviyesinde). ESLint YOK. Frontend build CI'da doğrulanıyor ama HİÇ test edilmiyor. |

### 0.1 Bu Taramada Bulunan Somut (Route Bazlı) Boşluklar

`routes.ts`'teki 207 endpoint, 59 test dosyasının içeriğiyle programatik
olarak karşılaştırıldı (path prefix eşleştirmesi — parametre içeren yollar
`:id`'den önceki sabit segment üzerinden eşleştirildi). Sonuç: **205/207
endpoint en az bir testte geçiyor.** Gerçekten hiç test edilmeyen yalnızca 2
endpoint bulundu:

- [x] **`GET /tenant-info`** — ✅ test edildi VE kimlik doğrulaması eklendi
      (ayrıntı: §2.2 GAP-2). Tarama sırasında auth`suz olduğu bulundu.
- [x] **`GET /policies/fail-open/offline-ratio-alerts`** — ✅ test edildi
      (ayrıntı: §2.2 GAP-1). Orta risk:
      `HARDWARE_DEVICE_MANAGER_ROLES` ile korunan, `getOfflineDispenseRatioAlerts()`
      çağıran bir RBAC'lı okuma ucu, **hiç test edilmemiş**. FUEL-410
      fail-open politika motorunun bir parçası; hem RBAC hem tenant-scoping
      açısından doğrulanmalı.

Bu ikisi dışında route-seviyesinde bir boşluk yok — bu, backend'in mevcut
test disiplininin gerçekten iyi durumda olduğunu doğruluyor. Asıl büyük
boşluklar **route sayısında değil**, aşağıdaki bölümlerde detaylandırılan
**test TÜRLERinde** (frontend, race-condition, dependency-audit, vb.).

### 0.2 Test Aşamasında Bulunan KRİTİK Sorun (planda yoktu)

- [x] **🚨 CI workflow dosyası GEÇERSİZ YAML'dı — hiçbir job çalışmıyordu.**
      `151881b` (2026-09-04, OPS-1105) commit'iyle giren
      `name: 🔑 OPS-1105: Gitleaks Secret Taraması` satırında, tırnaksız bir
      YAML skalarının içindeki `: ` bir mapping ayırıcısı olarak yorumlanıyor
      ve **dosyanın tamamını geçersiz** kılıyordu. İki bağımsız parser
      (PyYAML + js-yaml) doğruladı.
      **Etkisi:** GitHub Actions geçersiz bir workflow için "Invalid workflow
      file" der ve HİÇBİR job çalıştırmaz → RLS kapsama kontrolü, 51
      entegrasyon testi, gitleaks secret taraması, Trivy imaj taraması ve
      zero-downtime deploy'un tamamı ~1 haftadır **sessizce devre dışıydı.**
      **Bu, başarısız olan bir kontrolden daha tehlikelidir: başarısız
      kontrol kırmızı görünür, çalışmayan kontrol hiç görünmez.**
      Düzeltildi (başlık tırnaklandı) ve bir daha sessizce olmaması için
      `scripts/check-workflow-yaml.mjs` guard'ı eklendi.
      **DERS:** Bu plandaki tüm CI tabanlı güvenceler, CI'ın gerçekten
      çalıştığı varsayımına dayanıyordu. Bir güvenlik kontrolünün VAR olması
      ile ÇALIŞIYOR olması ayrı şeylerdir — plan bundan sonra "kontrol
      eklendi" değil, "kontrolün çalıştığı doğrulandı" ölçütünü kullanır.
      (Bu yüzden eklenen üç guard'ın da negatif testi yapıldı: kasıtlı bir
      ihlalde gerçekten exit 1 döndükleri doğrulandı.)

### 0.3 Test Aşamasında Öğrenilen Ortam/Süreç Dersleri

- [x] **Test paketi SIRAYLA koşarken login rate-limit'i yanlış başarısızlık
      üretiyor.** `loginRateLimiter` IP bazlı (10 deneme / 15 dk) ve tüm
      testler aynı IP'den geliyor. Yeni yazılan iki test (5 + 1 giriş)
      limiti tüketince `test_auth201` ve `test_195_tenant_isolation`
      kırıldı — oysa ikisi de TEK BAŞINA %100 geçiyordu. Bu, testin değil
      ORTAMIN hatası; mevcut testlerin (`test_fuel410`, `test_arch108`)
      kullandığı "girişten önce `rl:auth-login:*` anahtarlarını sil"
      deseni yeni testlere de eklendi. **KURAL: giriş yapan her yeni test
      bu temizliği yapmalıdır.**
- [x] **Sıfırdan `docker compose up` bu makinede şema yüklemiyor.**
      Postgres init script'leri (`docker-entrypoint-initdb.d`) konteynerdeki
      `postgres` kullanıcısı (uid 70) olarak çalışır; ancak
      `/sgoinfre/iekmen` dizini `drwx------` (700) olduğu için bind-mount'lu
      `schema.sql` okunamıyor → `psql: Permission denied` → şema hiç
      yüklenmiyor → backend `relation "hardware_devices" does not exist`
      ile restart döngüsüne giriyor. Bu ORTAMA ÖZGÜ bir izin sorunu
      (CI'da oluşmaz), projenin hatası değil. Geçici çözüm (ev dizini
      iznini değiştirmeden): şema ve seed'i stdin ile yükle —
      `docker exec -i yakittakip_postgres psql -U postgres -d yakittakip_db \
        -v ON_ERROR_STOP=1 < backend/src/db/schema.sql` (sonra seed dosyası).
      Kalıcı çözüm isteniyorsa `chmod o+x /sgoinfre/iekmen` yeterlidir
      (dizin listelemeyi açmaz, yalnızca geçiş izni verir) — bu bir
      kullanıcı kararı olduğu için uygulanmadı.

---

## 1. İlkeler (kod karmaşasından kaçınmak için)

1. **Yeni bir test framework/mocking katmanı EKLEMİYORUZ.** Backend'in
   mevcut "gerçek HTTP + gerçek Postgres/Redis + tek dosyalık `tsx` script"
   deseni korunacak. `ISSUES_ROADMAP.md`'deki `TEST-1001`'in önerdiği
   Testcontainers+vitest/jest yığını **bilinçli olarak atlanıyor** — zaten
   docker-compose ile AYNI garantiyi (gerçek Postgres+Redis) sağlıyoruz,
   ayrı bir soyutlama katmanı eklemek net bir kazanç getirmeden karmaşıklık
   ekler.
2. **Frontend için EN HAFİF setup:** Vitest (Vite projesine sıfır ek config
   ile entegre olur) + React Testing Library (component/unit) + Playwright
   (yalnızca az sayıda KRİTİK E2E akışı — 24 sayfanın hepsini değil).
   Cypress/Selenium gibi ağır/eski araçlar tercih edilmiyor.
3. **Mock yalnızca gerçek dış sınırda** (ör. Google Gemini API) kullanılır;
   iç modüller arası mock YOK — entegrasyon-testi felsefesi korunuyor.
4. Her yeni backend test dosyası mevcut `test_<ISSUE-KEY>_<konu>.ts`
   adlandırmasını ve ✅/❌ konsol check desenini izler.
5. **Test veri hijyeni:** seed/sabit kullanıcı state'ini KALICI DEĞİŞTİREN
   testler (aşağıda 4.3'te listelendi) ya kendi ürettiği tek-kullanımlık
   veriye taşınır ya da açıkça "reseed gerektirir" diye başlığında belirtilir.
6. Yeni bir guard script gerekiyorsa (ör. frontend'de
   `dangerouslySetInnerHTML` kullanımını yasaklamak), backend'deki
   `scripts/check-*.mjs` deseniyle AYNI basit, bağımlılıksız Node script
   yaklaşımı izlenir — ESLint gibi yeni bir araç zinciri kurulmaz.

---

## 2. Backend Test Planı

### 2.1 Zaten Kapsanan Alanlar (regresyon olarak korunacak — YENİDEN YAZILMAYACAK)

Aşağıdaki alanların her biri için ≥1 test dosyası mevcut ve CI'da çalışıyor;
bunlara dokunmuyoruz, yalnızca "her yeni özellik sonrası tekrar çalıştır"
listesine ekliyoruz:

- **Auth/Session:** login, refresh rotasyonu + reuse detection, RBAC matrisi,
  hesap kilitleme (AUTH-209), 2FA/TOTP (AUTH-207), aktif oturum listesi +
  uzaktan kapatma (AUTH-208), parola sıfırlama (AUTH-206), donanım HMAC+nonce
  (AUTH-202), donanım cihaz yaşam döngüsü (AUTH-202.3).
- **Tenant izolasyonu:** RLS statik kapsama + aktif çapraz-tenant sızıntı
  testi (#195/TEST-1003).
- **Fuel/Dispense:** ikmal oturumu state machine, çoklu yakıt tipi, manuel
  ikmal onayı, RFID kara liste, teklif/kota (quota), fail-open politika
  motoru (FUEL-401 → FUEL-410).
- **Fleet:** bakım kayıtları + TCO, muayene/lastik takibi (FLEET-1406→1409).
- **IoT:** MQTT dayanıklılığı, cihaz eşleştirme, cihaz shadow/komut kuyruğu,
  çevrimdışı toplu senkronizasyon, yetkisiz akış tespiti (IOT-301→305).
- **Envanter/Laboratuvar:** stok giriş-çıkış-sayım (INV-1506), numune/test
  sonucu takibi (INV-1507).
- **İK:** izin takibi (HR-1801).
- **Billing/Admin:** paket/lisans modeli, modül ek satışları, kullanım
  ölçümü, tenant dondurma/kalıcı silme/şifreli dışa aktarım (BILL-170x,
  ARCH-108).
- **Dayanıklılık:** Redis/DB kısmi arıza senaryoları (RES-905), readiness
  health-check (RES-906).
- **Yük/performans:** k6 ile 100 pompa @ 1000 rps (TEST-1002, manuel CI job).

### 2.2 Backend'de Eklenecek Yeni Testler

- [x] **GAP-1:** `GET /policies/fail-open/offline-ratio-alerts` — ✅ TAMAMLANDI
      (`test/test_gap_untested_endpoints.ts`, Test 1-14). Kapsam: kimlik
      doğrulama (token yok / bozuk token / "Bearer" öneksiz başlık), RBAC
      (PUMP_OPERATOR ve SITE_MANAGER → 403; COMPANY_OWNER ve SUPER_ADMIN →
      200), yanıt sözleşmesi, eşik mantığı (üstü → alarm, altı → yok, TAM
      eşik → yok, çünkü kod `> eşik` kullanıyor), 30 günlük zaman penceresi
      ve **çift yönlü tenant izolasyonu**. Sonuç: kod doğru davranıyordu,
      hiçbir hata bulunmadı — artık regresyona karşı kilitli.
- [x] **GAP-2:** `GET /tenant-info` — ✅ TAMAMLANDI, **gerçek bir bulgu çıktı**:
      uç `authenticateJWT` OLMADAN açıktı. Sızdırdığı veri yoktu (context
      yalnızca authenticateJWT içinde kurulduğundan kimlik doğrulamasız
      çağrıda boş dönüyordu) ama güvenlik, kodun başka bir yerindeki
      tesadüfe bağlıydı: context'i auth'tan önce dolduran bir ara katman
      eklendiği anda `tenantId`/`userId`/`traceId`/`ipAddress` sızardı.
      Kimlik doğrulaması arkasına alındı (kaldırılmadı — tanılama değeri
      var ve artık DOLU context döndürüyor). Test 15-17 ile kilitlendi.
- [x] **Race condition / eşzamanlılık testleri** — ✅ TAMAMLANDI
      (`test/test_race_conditions.ts`, 10/10). Mevcut 59 testin HEPSİ
      istekleri SIRAYLA atıyordu; sıralı bir test, `FOR UPDATE` kilitlerini
      tamamen kaldırsanız bile geçer. Kapsanan:
      - Envanter: eşzamanlı 2 çıkış (7+7 > stok 10) → tam biri 409;
        6 eşzamanlı çıkış (6×3, stok 10) → tam 3'ü kabul; stok asla negatif.
      - **Lost-update kanıtı:** eşzamanlı hareketlerin `balance_after`
        değerleri benzersiz bir zincir oluşturuyor (10→7→4→1). İki
        transaction aynı değeri okuyup üzerine yazsaydı aynı `balance_after`
        yazılırdı.
      - Tank: 8 eşzamanlı ikmal → hepsi işlendi, seviye tam 8×10 düştü,
        yazılan ikmal kayıtlarının toplamı tanktan düşenle mutabık.
      **Mutation ile doğrulandı:** `recordInventoryMovement`'taki
      `FOR UPDATE` kaldırılıp backend yeniden derlendiğinde 10 testten 5'i
      kırıldı (tank testleri geçmeye devam etti — onların kilidi yerindeydi),
      ardından kod geri yüklendi. Yani testler gerçekten kilitleri ölçüyor.
- [ ] Kota ve `tenant_deletion_approvals` eşzamanlılığı — aynı desenle
      eklenecek (bu turda envanter + tank kapsandı).
- [ ] **Pagination/filtreleme sınır-durum testleri** — `limit=0`,
      negatif `offset`, var olmayan `sort` alanı, çok büyük `limit` (DoS
      potansiyeli) gibi durumlar sistematik olarak taranmamış; mevcut
      testler çoğunlukla "mutlu yol" senaryosunu kapsıyor.
- [ ] **İdempotency/duplicate-request taraması** — `(device_id,
      localSequenceId)` gibi var olan desenler dışında, para/stok etkileyen
      TÜM POST uçlarının bir envanteri çıkarılıp hangilerinin idempotency
      garantisi olmadığı belgelenecek (yeni kod YAZMADAN önce bir envanter
      çalışması).
- [x] **Bağımlılık güvenlik taraması:** ✅ TAMAMLANDI —
      `scripts/check-dependency-audit.mjs` + CI adımı. Düz
      `npm audit --audit-level=high` YERİNE GHSA bazlı allowlist tercih
      edildi: düz eşik ya CI'ı sürekli kırmızı bırakır (bugün düzeltmesi
      OLMAYAN bulgular yüzünden) ya da eşik gevşetilince gerçek yeni bir
      bulguyu yutar. Bu script'te allowlist'te OLMAYAN her yeni advisory —
      severity'si ne olursa olsun — build'i kırar; stale girdiler de
      raporlanır. **Mevcut 5 bulgu** (xlsx×2 HIGH, qs×2, uuid×1) tek tek
      incelenip istismar edilebilirlik gerekçesiyle allowlist'e alındı.
- [x] **Test veri hijyeni:** ✅ İNCELENDİ — **bu tespit KISMEN YANLIŞTI.**
      `test_auth206_password_reset.ts` aslında `finally` bloğunda parolayı
      geri yazıyordu (canlı doğrulandı: test koştuktan sonra `orman-santiye`
      hâlâ `123456` ile giriyor). Gerçek kırılganlık başkaydı: geri yazma
      **sabit kodlu bir seed hash'inden** yapılıyordu — seed/algoritma
      değişirse test kobay kullanıcıyı SESSİZCE yanlış parolaya döndürüp
      `123456` ile giren tüm testleri kırardı. Düzeltildi: test artık
      bozduğu değeri BAŞINDA ölçüp sonunda onu geri yazıyor (sabit hash
      sabiti tamamen kaldırıldı — kod da azaldı). 12/12 geçiyor.

### 2.3 Backend Regresyon Çalıştırma Matrisi (mevcut, belgeleniyor)

Bu proje boyunca öğrenilen, testleri DOĞRU şekilde koşturmak için gereken üç
farklı çalıştırma bağlamı — ileride her yeni test bunlardan hangisine
girdiğini baştan netleştirmeli:

1. **`docker run --network container:backend`** (backend imajının `builder`
   aşaması + `test/` dizini bind-mount) — Redis/Postgres'e `REDIS_HOST=redis
   POSTGRES_HOST=postgres` ile, backend'e `localhost:5000` ile erişen testler.
   Çoğu mevcut test bu kategoride.
2. **Host'tan doğrudan (`localhost:3000`, nginx üzerinden)** — HEM gerçek
   HTTP (nginx) HEM host-seviyeli doğrudan Postgres (`localhost:5432`,
   published) erişimi gerektiren testler (ör. ARCH-108, BILL-1701, RES-905).
   Redis host'a PUBLISH edilmediği için bu testler Redis manipülasyonunu
   `docker exec yakittakip_redis redis-cli ...` ile yapmalı — DOĞRUDAN
   `new Redis({host:'localhost'})` KULLANMAMALI (host'ta ilgisiz bir yerel
   Redis süreci [`127.0.0.1:6379`] olduğu bu taramada DOĞRULANDI — bu,
   CI'da (host-Redis published) çalışıp yerelde YANLIŞ Redis'e bağlanan
   sinsi bir hata sınıfı).
3. **CI'ın `auth-integration-test` işi** — docker-compose YOK, backend
   `nohup npx tsx src/bootstrap.ts` ile çıplak, Postgres/Redis GH Actions
   `services:` (host'a published, gerçek `localhost`) — burada `localhost`
   HER ZAMAN doğrudur, nginx YOKTUR (port 3000 hardcoded testler CI'da
   ÇALIŞMAZ, `API_URL` env override şart).

---

## 3. Frontend Test Planı (şu an 0 → hedef: kritik yolların tamamı)

Frontend'de HİÇ test yok. Sıfırdan, hafif bir kurulumla başlanacak.

### 3.1 Kurulum (tek seferlik, düşük karmaşıklık)
- [x] ✅ TAMAMLANDI — `vitest` + `@testing-library/react` + `jest-dom` +
      `user-event` + `jsdom` kuruldu; `vitest.config.ts` (ayrı dosya: prod
      vite config'i saf kalsın diye) + `src/test/setup.ts` (her test öncesi
      localStorage temizliği — token sızıntısı false-positive üretmesin).
      `npm run test` / `test:watch` script'leri eklendi, CI'a bağlandı.
      **Yeni bağımlılıklar hiç yeni zafiyet getirmedi** (dependency-audit
      guard'ı otomatik doğruladı) ve prod build bozulmadı (4.19s, exit 0).
- [ ] `@playwright/test` — yalnızca **kritik E2E akışları** için
      (aşağıda 3.3), sayfa başına test YAZILMAYACAK.

### 3.2 Component/Unit Testleri (Vitest + RTL)
- [x] ✅ `utils/api.ts` — **17 test**. 401 → sessiz yenileme → oturum düşürme
      zincirinin TÜM yolları: token'sız 401 oturumu düşürmez (giriş öncesi
      çağrılar), refresh token yok / sunucu reddetti / ağ koptu / yanıtta
      accessToken yok, başarısız yenileme sonrası eski token'lar bozulmaz,
      **eşzamanlı iki 401 TEK yenileme çağrısını paylaşır** (aksi hâlde
      refresh-token rotasyonu "token reuse" sayılıp tüm oturumları iptal
      ettirirdi).
- [x] ✅ `AppContext.tsx` — **7 test**. Giriş (iki token da saklanır, rol
      JWT'den gelir, başarısız girişte token yazılmaz, sunucu erişilemezse
      çökmez), çıkış (kimlik bilgileri gerçekten silinir), UNAUTHORIZED
      olayında otomatik çıkış, provider söküldüğünde dinleyici sızıntısı yok.
      **Bulgu:** `logoutCompany()` içindeki `YAKIT_IS_AUTH`/`COMPANY_IDX`/
      `SITE_FILTER` için `removeItem` çağrıları fiilen ETKİSİZ — state'i
      izleyen `useEffect`'ler değeri hemen geri yazıyor. Güvenlik açığı
      değil (okuma tarafı `=== 'true'` karşılaştırdığı için `'false'` da
      "giriş yok" demek) ama kafa karıştırıcı ölü kod; temizliği ayrı bir
      iş olarak bırakıldı (AppContext ~1200 satır, test aşamasında
      dokunmak gereksiz risk).
- [x] **Testlerin kendisi doğrulandı (mutation testing):** api.ts'te 3,
      AppContext'te 3 olmak üzere 6 kasıtlı mutasyon uygulandı; her biri
      TAM olarak hedeflediği testi kırdı. Yani testler sahte güvence
      vermiyor (§0.2'deki "var olması ≠ çalışıyor olması" dersi).
- [ ] Rol bazlı UI koşulları — `customer`/`developer`/`santiye` sayfa
      gruplarının doğru role'e göre render edildiği/gizlendiği (backend
      RBAC'ın frontend yansıması — burada bir tutarsızlık olursa kullanıcı
      kafası karışır, güvenlik açığı DEĞİL ama UX/güven sorunu).
- [ ] Form doğrulama bileşenleri — backend Zod şemalarıyla PARALEL çalışan
      frontend doğrulamaların (varsa) tutarlılığı.
- [ ] Kritik hesaplama/gösterim bileşenleri (ör. kota bakiyesi, tank
      doluluk yüzdesi, TCO özet kartı) — yanlış birim/yuvarlama riski.

### 3.3 E2E Testleri (Playwright — YALNIZCA kritik akışlar, ~8-10 senaryo)
- [ ] Login → dashboard → logout (üç farklı rol: SUPER_ADMIN, COMPANY_OWNER,
      SITE_MANAGER/PUMP_OPERATOR).
- [ ] Yanlış şifre → hata mesajı → hesap kilitleme sonrası 423 mesajının
      UI'da doğru gösterilmesi.
- [ ] Manuel ikmal talebi oluşturma → onay akışı (iki farklı rol arasında).
- [ ] Araç/personel/site CRUD akışlarından en az biri uçtan uca.
- [ ] Lisansı süresi dolmuş/dondurulmuş bir tenant kullanıcısının UI'da
      doğru kısıtlama mesajını görmesi (BILL-1702/ARCH-108'in frontend
      yansıması — backend zaten test edildi, burada YALNIZCA UI davranışı
      doğrulanıyor).
- [ ] Oturum süresi dolduğunda (401) kullanıcının login sayfasına
      yönlendirildiği, hassas verinin ekranda KALMADIĞI.
- [ ] Responsive/mobil temel kontrol (en az 1 kritik sayfa, dar viewport).

### 3.4 Frontend Güvenlik Kontrolleri
- [x] **Guard script:** ✅ TAMAMLANDI — `scripts/check-frontend-security.mjs`
      (tek dosya, 4 kural): `no-dangerously-set-inner-html`, `no-xlsx-parse`,
      `no-eval`, `no-inner-html-assignment`. Backend'deki
      `check-no-raw-pool-query.mjs` ile aynı desen (bağımlılıksız, dosya+kural
      bazlı allowlist). Repo şu an 4 kuralın hepsinde temiz; **4 kuralın da
      negatif testi yapıldı** (kasıtlı ihlal → exit 1).
- [x] `localStorage`'daki access/refresh token'ların XSS'e karşı tek gerçek
      savunması "hiçbir yerde ham HTML render edilmemesi" — artık yukarıdaki
      guard bunu mekanik olarak garanti ediyor. (httpOnly cookie'ye geçiş,
      Bearer-token tabanlı SPA mimarisinin köklü bir değişikliği olur — bu
      planın kapsamı DEĞİL, ayrı bir mimari karar gerektirir, burada yalnızca
      NOT düşülüyor.)
- [x] **xlsx HIGH zafiyeti (GHSA-4r6h-8v6p-xvw6 / GHSA-5pgg-2g8v-p4x9)** —
      istismar edilebilirlik analizi yapıldı: zafiyetler YALNIZCA parse
      yolunda (`XLSX.read`/`readFile`); frontend xlsx'i sadece YAZMA için
      kullanıyor ve uygulamada hiç dosya yükleme ucu
      (`input[type=file]`/`FileReader`) yok → fiilen istismar edilemez.
      Bu varsayım artık `no-xlsx-parse` kuralıyla kalıcı: biri okuma yolu
      eklerse CI kırılır ve bağımlılık kararı yeniden ele alınır.
- [ ] Prod build'de kaynak haritası (`sourcemap`) / hassas ortam
      değişkeninin (`VITE_*`) bundle'a sızmadığının kontrolü.

---

## 4. Veritabanı Test Planı

- [ ] **RLS — statik kapsama (mevcut):** `check-rls-coverage.mjs` her yeni
      tenant tablosunun `ENABLE`+`FORCE`+`POLICY` üçlüsüne sahip olduğunu
      garanti ediyor. Korunacak.
- [ ] **RLS — dinamik sızıntı testi (mevcut):** `test_195_tenant_isolation.ts`
      gerçek iki tenant arasında çapraz okuma/yazma denemesi yapıyor.
      Korunacak; **her yeni tablo eklendiğinde bu testin de o tabloyu
      kapsayacak şekilde genişletilmesi** süreç kuralı olarak eklenmeli.
- [ ] **`platform_audit_log` ve diğer RLS'siz sistem tabloları** — bunların
      GERÇEKTEN yalnızca SUPER_ADMIN/sistem tarafından erişilebildiği (uygulama
      katmanında, RLS olmadığı için) ayrı bir testle doğrulanmalı — RLS'siz
      bir tablo, uygulama kodu değişirse sessizce sızdırabilir.
- [ ] **Foreign key / cascade davranışı** — özellikle `tenant_deletion_approvals`
      gibi CASCADE'li tabloların, bir tenant silindiğinde GERÇEKTEN tüm
      bağımlı satırları temizlediği (yetim kayıt kalmadığı) doğrulanmalı.
- [ ] **Migration/şema değişikliği güvenliği** — bu projede ayrı bir migration
      aracı yok (`schema.sql` doğrudan uygulanıyor); üretim ortamına
      GEÇİŞ senaryosu (var olan veriyle yeni kolon/tablo eklemenin veri
      kaybına yol açmadığı) için bir "staging'de schema.sql'i mevcut
      snapshot üzerine uygula" tatbikatı planlanmalı.
- [ ] **Yedekleme/geri yükleme tatbikatı** — `redisdata`/Postgres volume'larının
      gerçek bir `pg_dump`/`pg_restore` döngüsünden geçirilip veri
      bütünlüğünün korunduğu en az bir kez elle doğrulanmalı (otomasyon
      şart değil, ama en az bir tatbikat planlanmalı).
- [ ] **İndeks/performans regresyonu** — `pg_stat_statements` ile en sık
      çalışan sorguların (dashboard, telemetri ingest) `EXPLAIN ANALYZE`
      çıktısı bir kez alınıp temel bir referans olarak saklanmalı; gelecekte
      "neden yavaşladı" sorusuna hızlı cevap için.

---

## 5. Güvenlik Test Planı (OWASP Top 10 eşlemesi)

Her madde için: **zaten kapsanan mı, yoksa yeni mi.**

| OWASP kategorisi | Durum |
|---|---|
| **A01 Broken Access Control** | Büyük ölçüde kapsanan (167 route'ta `authorizeRoles`, RLS, 35 test dosyası 403 kontrolü yapıyor). **Yeni:** GAP-1 (offline-ratio-alerts RBAC testi). |
| **A02 Cryptographic Failures** | Argon2id, AES-256-GCM (donanım secret + tenant export), JWT ayrı access/refresh secret. Kapsanan. |
| **A03 Injection** | Parametreli sorgular `check-no-raw-pool-query.mjs` ile mekanik garanti altında. **Yeni:** frontend'de `dangerouslySetInnerHTML` guard script (bölüm 3.4). |
| **A04 Insecure Design** | RES-905 (graceful degradation), fail-open/fail-closed kararlarının dokümante matrisi (`redisPool.ts`). Kapsanan. |
| **A05 Security Misconfiguration** | `check-env-example-sync.mjs`, `.env` placeholder kontrolü, nginx/Express body-size limitleri. **Yeni:** CSP header'ının frontend'de var olup olmadığı kontrol edilecek (aşağıda). |
| **A06 Vulnerable Components** | **BOŞLUK:** `npm audit` CI'da yok (bölüm 2.2). Trivy yalnızca imaj/OS paketlerini tarıyor. |
| **A07 Auth Failures** | Rate limiting, hesap kilitleme, 2FA, HMAC+nonce donanım auth — kapsamlı. Kapsanan. |
| **A08 Software/Data Integrity** | HMAC imzalı donanım paketleri, idempotent batch-sync. Kısmen kapsanan — genel idempotency envanteri (bölüm 2.2) tamamlayıcı. |
| **A09 Logging/Monitoring Failures** | `audit_logs` (27 test dosyası kontrol ediyor), yapısal Pino logu, hassas alan redaksiyonu (RES-902). Kapsanan. |
| **A10 SSRF** | Dış URL'e istek atan tek nokta Google Gemini API (sabit endpoint) — kullanıcı girdisiyle URL oluşturan bir nokta YOK. Düşük risk, **yeni:** bunu doğrulayan tek bir grep taraması (kod incelemesi, otomatik test gerekmez). |

### 5.1 Ek Güvenlik Test Kalemleri
- [ ] **CSP header kontrolü** — frontend `index.html`/nginx yanıtlarında bir
      Content-Security-Policy header'ı var mı? Şu an muhtemelen YOK — eklenip
      eklenmeyeceği ayrı bir karar, ama en azından mevcut durumun test/rapor
      ile belgelenmesi bu planın parçası.
  - [ ] Sonuç bulunduğunda: header yoksa, en azından `default-src 'self'`
        gibi minimal bir politika önerisi hazırlanacak (uygulama KARARI
        kullanıcıya bırakılır, burada yalnızca tespit ve öneri).
- [ ] **Secrets taraması genişletme** — `gitleaks` mevcut commit geçmişini
      tarıyor; `.gitleaks.toml` allowlist'inin gereğinden geniş olmadığı
      (yanlışlıkla gerçek bir secret'ı maskelemediği) elle bir kez gözden
      geçirilecek.
- [ ] **Dependency confusion / supply-chain** — `package-lock.json`'ların
      (root, backend, frontend) HER ZAMAN commit'li ve `npm ci` (npm install
      DEĞİL) ile kurulduğu CI adımlarında doğrulanacak (mevcut CI script'i
      kontrol edilip gerekirse `npm ci`'ye çevrilecek).
- [ ] **Docker imaj sertleştirme regresyonu** — non-root user, minimal imaj
      boyutu (<150MB, OPS-1101 AC'si) hâlâ geçerli mi diye periyodik kontrol.

---

## 6. CI/CD ve Altyapı Test Planı

- [ ] `npm audit` adımı (backend + frontend) — bölüm 2.2/5.
- [ ] `npm ci` kullanımının tüm job'larda tutarlı olduğu doğrulanacak.
- [ ] `docker-security-scan` (Trivy) sonuçlarının GERÇEKTEN build'i kırdığı
      (CRITICAL/HIGH bulunduğunda) — bir kez KASITLI olarak bilinen zafiyetli
      bir base image ile tetiklenip doğrulanacak (tatbikat, otomatik test
      değil).
- [ ] `deploy-zero-downtime` job'ının GERÇEKTEN sıfır kesinti sağladığı —
      dağıtım sırasında sürekli health-check atan bir arka plan script'iyle
      (zaten `scripts/zero-downtime-deploy.sh` var) bir kez canlı doğrulama.
- [ ] CI'daki `test/*.ts` çağrılarının HEPSİNİN `API_URL`/port tutarlılığı
      (önceki oturumlarda bulunup düzeltilen 3000↔5000 karışıklığı) — yeni
      bir test dosyası eklendiğinde bunun bir PR checklist maddesi olarak
      hatırlatılması (bu dokümanın kendisi bu hatırlatıcı).

---

## 7. Performans / Yük Test Planı

- [ ] Mevcut `TEST-1002` (k6, 100 pompa @ 1000 rps, P95<200ms, event-loop
      lag<50ms) — düzenli aralıklarla (ör. her büyük özellik grubu sonrası)
      manuel tetiklenerek regresyon kontrolü.
- [ ] **Yeni:** Postgres connection-pool doygunluğu senaryosu — eşzamanlı
      istek sayısı `pool.max`'ı aştığında sistemin KUYRUKLANIP nazikçe
      yavaşladığı, ÇÖKMEDIĞI doğrulanacak (RES-905'in DB tarafı tamamlayıcısı).
- [ ] **Yeni:** Redis bellek baskısı senaryosu — `maxmemory-policy`
      ayarlanmamışsa (mevcut `docker-compose.yml`'de kontrol edilecek) OOM
      riski var mı diye bir kez incelenecek.

---

## 8. Öncelik Sıralaması (yol haritası — "sonra teste geçeceğiz" için)

Test aşamasına geçildiğinde önerilen sıra (yüksek etki / düşük efor önce):

1. **P0 — ✅ TAMAMLANDI (2026-09-12):**
   - [x] Bağımlılık zafiyet denetimi — `check-dependency-audit.mjs` + CI adımı.
   - [x] GAP-1/GAP-2 uç testleri — `test_gap_untested_endpoints.ts` (17/17).
   - [x] `test_auth206` veri hijyeni — sabit kodlu hash bağımlılığı kaldırıldı.
   - [x] Frontend güvenlik guard'ı — `check-frontend-security.mjs` (4 kural).
   - [x] **(Planda yoktu, test sırasında bulundu)** CI workflow'unun geçersiz
         YAML olduğu ve hiçbir job'ın çalışmadığı tespit edildi; düzeltildi ve
         `check-workflow-yaml.mjs` ile kilitlendi (bkz. §0.2).

   **P0 net kazanım:** 7 guard script (4 mevcut + 3 yeni) ve 17 yeni test;
   1 kritik CI arızası, 1 kimlik doğrulama boşluğu ve 1 test kırılganlığı
   giderildi.
2. **P1 — Orta efor, yüksek değer:**
   - [x] ✅ Frontend Vitest+RTL kurulumu + AppContext/api.ts testleri
         (bölüm 3.1-3.2) — **24 test**, 6 mutasyonla doğrulandı.
   - [x] ✅ Race-condition testleri (bölüm 2.2) — 10 test, mutation ile doğrulandı.
   - [ ] CSP header tespiti + öneri (bölüm 5.1).
   - [ ] Rol bazlı UI koşulları + form doğrulama testleri (bölüm 3.2'nin
         kalan maddeleri).
3. **P2 — Daha büyük efor:**
   - Playwright E2E kritik akışlar (bölüm 3.3).
   - Pagination/idempotency sistematik taraması (bölüm 2.2).
   - DB migration/backup-restore tatbikatı (bölüm 4).
4. **P3 — Periyodik/tatbikat niteliğinde:**
   - Yük testi regresyonu (bölüm 7).
   - Zero-downtime deploy canlı doğrulama (bölüm 6).
   - Docker sertleştirme periyodik kontrol.

---

*Bu plan `ISSUES_ROADMAP.md` ile aynı ruhla yaşayan bir dokümandır — test
aşamasında yeni bir boşluk bulundukça buraya `- [ ]` olarak eklenir, biten
maddeler `- [x]` olarak işaretlenir.*
