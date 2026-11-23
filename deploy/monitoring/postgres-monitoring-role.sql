-- OPS-1107 — postgres-exporter için en az yetkili izleme rolü (superuser yerine). Bir kerelik, superuser ile çalıştırın:
--   docker compose exec -T postgres psql -U postgres -d yakittakip_db -v pw="'<güçlü-parola>'" -f - < deploy/monitoring/postgres-monitoring-role.sql
-- Sonra .env: PG_EXPORTER_USER=exporter  PG_EXPORTER_PASSWORD=<aynı parola>. pg_monitor rolü yalnızca izleme görünümlerini okur; iş verisine erişemez.
CREATE ROLE exporter LOGIN PASSWORD :pw;
GRANT pg_monitor TO exporter;
