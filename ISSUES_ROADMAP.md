# 📋 ISSUES_ROADMAP — Taşındı

Bu dosyanın güncel ve genişletilmiş hâli **[`docs/ISSUES_ROADMAP.md`](./docs/ISSUES_ROADMAP.md)** adresindedir.

**Sürüm:** Node.js Enterprise Roadmap **v2.2** — v2.1'deki 12 modül grubu / 25 iş paketi korunarak
**18 modül grubu / 198 iş paketine** genişletildi ve tamamı GitHub issue'su olarak açıldı (#13–#210).

| Ne değişti | Detay |
|---|---|
| Mevcut 25 iş paketi | Tamamı korundu; `[L]`/`[XL]` olanlar **epic**'e dönüştürülüp `XS`/`S` alt issue'lara bölündü |
| Yeni modül grupları | `FW-13xx` ESP32 Firmware · `FLEET-14xx` Filo · `INV-15xx` Stok & Maliyet · `NOTIF-16xx` Bildirim · `BILL-17xx` Lisans · `HR-18xx` İK |
| Yeni kritik kapsam | K-factor uzaktan kalibrasyon (`FUEL-404`), hibrit fail-open politikası (`FUEL-410`), 13 raporluk katalog (`REP-7xx`), 3 panelin ekran envanteri (`FE-8xx`) |

## Dokümantasyon

| Doküman | İçerik |
|---|---|
| [`docs/PROJE-REHBERI.md`](./docs/PROJE-REHBERI.md) | Ekip çalışma rehberi: mimari, veri modeli, API, MQTT, yetki matrisi, kurulum, riskler |
| [`docs/ISSUES_ROADMAP.md`](./docs/ISSUES_ROADMAP.md) | 198 iş paketi, issue numaraları, kritik yol, faz dağılımı |
| [`docs/SUNUM-REHBERI.md`](./docs/SUNUM-REHBERI.md) | 13 slaytlık müşteri sunumu, konuşma metinleri, SSS, demo senaryosu |
| [`docs/SOZLUK.md`](./docs/SOZLUK.md) | Teknik, saha ve mevzuat terimleri sözlüğü |

`docs/ISSUES_ROADMAP.md` otomatik üretilir: `node scripts/roadmap/generate-roadmap-doc.mjs`
