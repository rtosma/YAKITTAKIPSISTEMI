# Dağıtım / rollback tatbikat raporları (OPS-1110)

`node scripts/test-ops1110.mjs --live` her çalıştırmada bu klasöre `<tarih>.md` yazar: sürekli yük + **aktif ikmal oturumu** + WebSocket istemcileri altında gerçek
dağıtım (A→B) ve gerçek geri alma (B→A); ölçülen kesinti, oturum sürekliliği, soket boşaltma yayılımı ve **rollback süresi**. Çeyrekte **en az bir** rapor bulunmalı;
büyük altyapı değişikliğinden (Docker/nginx/Postgres/Node sürümü) sonra da tekrarlanır. Prosedür: [../DEPLOY_ROLLBACK.md](../DEPLOY_ROLLBACK.md).
