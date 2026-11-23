# Kesinti / offline kaos testi (TEST-1007)

> Amaç: şantiye internetinin kesilmesi ve bağımlılık çökmelerinin **gerçek koşullara yakın ve tekrarlanabilir** biçimde denenmesi. Çıktı: bu belgedeki senaryolar + her koşuda `docs/chaos-reports/<tarih>.md|.json`
> (sürümler arası karşılaştırma). İlgili: [BACKUP_RESTORE.md](BACKUP_RESTORE.md), [DEPLOY_ROLLBACK.md](DEPLOY_ROLLBACK.md), [runbooks/](runbooks/).
>
> **Kapsam uyarlaması:** Ticket toxiproxy/`tc netem` + Testcontainers + TEST-1005 cihaz simülatörü öneriyor. Bu ortamda bunlar yok ve dış imaj bağımlılığı istenmedi; yerine
> (a) test dosyasında **toxiproxy'nin ilgili özelliklerini** (kes, gecikme, bant genişliği, bağlantı sıfırlama, *"istek işlendi ama yanıt kayboldu"*) uygulayan küçük bir TCP proxy — **tohumlu PRNG** ile her koşuda aynı kararlar;
> (b) firmware'in çevrimdışı kuyruk + batch senkron + yeniden deneme mantığını uygulayan **cihaz simülatörü** (yalnızca `ACCEPTED`/`DUPLICATE_SKIPPED` olanlar kuyruktan silinir); (c) **gerçek bağımlılıklar**: çalışan compose yığını (Postgres, Redis, EMQX, backend, nginx) — çökmeler gerçek
> `docker stop` / süreç `SIGKILL` ile. "72 saat" **simüle** edilir (kesinti boyunca 72 saatlik `deviceTimestamp` geçmişi kuyruğa girer); gerçek 72 saat beklenmez.

## Çalıştırma

```bash
cd backend && set -a && . ../.env && set +a && npx tsx test/test_test1007_chaos.ts --report   # yerel/staging yığını; ~4-5 dk
CHAOS_ONLY=AC npx tsx test/test_test1007_chaos.ts                                              # yalnızca A ve C senaryoları (hata ayıklama)
```

**Docker gerektirir → CI'da çalışmaz** (CI GitHub `services:` kullanır, konteyner yaşam döngüsü kontrolü yok — `test_res905`/`iot301` ile aynı gerekçe). Bağımlılıkları kısa süreliğine durdurur ve `finally` ile HER KOŞULDA geri başlatır;
**yalnızca geliştirme/staging'de** çalıştırın (üretimde değil). Test kendi sentetik ikmallerini (`local_sequence_id > taban`) ve tank seviyesini sonda geri alır. CI'da çalışan kısım: `test_test1007_error_mapping.ts` (hata sınıflandırması) ve `scripts/test-test1007.mjs` (sözleşme).

## Senaryolar ve kabul kriterleri

Her senaryo sonunda **DB'deki kayıt sayısı, benzersiz `(device_id, localSequenceId)`, toplam litre ve tank Δ'sı elle hesaplanan değerle birebir** doğrulanır ("eksiksiz + mükerrersiz").

| # | Senaryo | Enjekte edilen | AC |
|---|---|---|---|
| A | Taban | sağlam hat, 40 ikmal / 2 batch | referans |
| B | **72 saatlik kesinti** | ağ tamamen kesik; 72 sa × saatte 3 = **216 ikmal** kuyrukta birikir, her "6 saatte" bir deneme (12 başarısız) | **hiçbir ikmal kaybolmaz**: 216/216, 1725 L, tank Δ 1725 L; kesinti boyunca DB'ye tek kayıt sızmaz; kayıtlar cihaz zamanıyla (71,7 sa aralık) saklanır |
| C | **Kademeli bozulma** | gecikme 250 ms + bant 12 KB/s + **%35 bağlantı kaybı** (yarısı işlenmeden, yarısı *işlendikten sonra* — yanıt kaybolur), 150 ikmal / 25'lik batch | eksiksiz + mükerrersiz; "işlendi ama yanıt kayboldu" durumu ≥2 kez yaşanır ve yeniden gönderimde kayıtlar `DUPLICATE_SKIPPED` döner |
| D | **Senkron sırasında ikinci kesinti** | batch1 tamam; batch2 sunucuda işlenir ama yanıtı kaybolur; ardından ikinci kesinti (kısmi senkron) | ara durum: DB 40, cihaz 20'sini onaylı sanıyor (80 kuyrukta); sonra DB **tam 100**, batch2'nin 20 kaydı `DUPLICATE_SKIPPED` — **mükerrer yok** |
| E | **Sunucu çökmesi** | senkron ortasında backend'in node süreci `SIGKILL` | restart policy ile geri gelir; kuyruk korunur; 60/60 eksiksiz, mükerrersiz |
| F1 | Redis çöktü | `docker stop redis` | aşağıdaki matris |
| F2 | MQTT (EMQX) çöktü | `docker stop emqx` | aşağıdaki matris |
| F3 | PostgreSQL çöktü | `docker stop postgres` | aşağıdaki matris |

### Bağımlılık çökmesinde **tanımlı davranış** (RES-905 + bu testle doğrulanan)

| Bağımlılık | Cihaz senkronu (`/telemetry/sync-batch`) | Login | Liveness | Readiness | Toparlanma |
|---|---|---|---|---|---|
| **Redis** | **503** (fail-closed: nonce/replay koruması atlanamaz; ~2,4 sn'de yanıt — asılı kalmaz). Cihaz kuyruğu korur | **503** (AUTH-209: kilit sayacı okunamazken brute-force korumasız giriş açılmaz) | 200 | 503 (`redis ok=false`) | Redis dönünce aynı kuyruk sorunsuz senkronlanır |
| **MQTT (EMQX)** | **200** — HTTP yolu MQTT'den bağımsız, kayıt kabul edilir | 200 | 200 | 503 (`mqtt ok=false`, ~1,5 sn'de fark edilir) | Backend kendi üstel backoff'uyla yeniden bağlanır (≈ 9 sn) |
| **PostgreSQL** | **503 `DB_UNAVAILABLE`** + `Retry-After: 5` (~5 sn'de yanıt; kalıcı yazım yok). Cihaz kuyruğu korur | 503 | 200 (DB kesintisi süreci öldürmez) | 503 ≤ 2 sn'de (`postgres ok=false`) | Havuz kendiliğinden toparlanır (~3 sn), kuyruk eksiksiz senkronlanır |
| **Backend süreci** (SIGKILL) | nginx 502 → cihaz yeniden dener | — | — | — | restart policy ~2 sn; kuyruk eksiksiz |

Cihaz tarafı kuralı (firmware): **2xx dışındaki HER yanıt/ağ hatası = "onaylanmadı"**; kuyruk yalnızca yanıttaki `ACCEPTED`/`DUPLICATE_SKIPPED` kayıtlar için silinir → hangi anda kopulursa kopulsun kayıp da mükerrer de oluşmaz.

## Bu testin bulduğu ve düzelttiği boşluklar

1. **Readiness asılıyordu:** `/health/ready` Postgres çökünce bağlantı havuzunun 10 sn'lik zaman aşımına kadar bekliyordu → 5 sn'lik probe "yanıt yok" görüyor, 503 yerine kararsız davranıyordu. Artık her bağımlılık kontrolü **2 sn** ile sınırlı (`readinessService.ts`).
2. **DB erişilemezken opak 500:** `ECONNREFUSED/ENOTFOUND/57P01/"Connection terminated"` hataları `CRITICAL_UNHANDLED_EXCEPTION` + 500 (ve Sentry'de sahte kritik hata) üretiyordu. Artık yeniden denenebilir **503 `DB_UNAVAILABLE` + `Retry-After`** (`errorHandler.ts`; CI'da `test_test1007_error_mapping.ts`).
3. **Belgelenen ama gerçek olmayan varsayım:** RES-905 notunda login "fail-open" idi; AUTH-209 sonrası Redis çökünce login **fail-closed 503**. Tablo gerçeği yansıtır.

## Bilinen operasyonel bulgular (kod değişikliği gerektirmeyen, işletme bilgisi)

- **`docker kill <konteyner>` restart policy'yi tetiklemeyebilir** (Docker bunu "elle durdurma" sayar; ilk koşuda backend `Exited (137)` kaldı). Gerçek çökme (süreç ölümü/OOM) tetikler — test bu yüzden node sürecini konteyner içinden öldürür. Arıza tatbikatında konteyneri `docker kill` ile değil süreci öldürerek düşürün.
- **nginx upstream IP'si `reload` sırasında çözülür.** Backend konteyneri *yeni IP ile* yeniden oluşursa (ör. elle `docker compose up --force-recreate backend`), nginx eski IP'ye gidip **502** verir; `docker exec yakittakip_frontend nginx -s reload` gerekir. `zero-downtime-deploy.sh`/`rollback.sh` bunu zaten yapar (atomik kesme + reload); yalnızca elle yeniden oluşturmada dikkat.
- Redis/Postgres durduğunda `resetLoginRl` gibi yardımcılar (redis-cli exec) başarısız olur — test ortamı bilgisi.

## Sürümler arası karşılaştırma

Her `--report` koşusu `docs/chaos-reports/<tarih>.json` (makine okunur) ve `.md` yazar; `.md`'de her senaryonun **süresinin bir önceki rapora oranı** bulunur. Kabul kuralı: tüm senaryolarda `exact = EVET`; süre oranı belirgin
(>3×) artmışsa sebep araştırılır. Raporlar sürüm etiketini (`/health` → `version`) içerir. Yeni bir sürüm/altyapı değişikliğinden (Docker, nginx, Postgres, Node) sonra ve çeyrekte bir tekrarlanır.

| Rapor | Sürüm | Sonuç |
|---|---|---|
| [chaos-reports/](chaos-reports/) | her rapor kendi sürümünü taşır | her koşuda güncellenir |
