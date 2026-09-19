#!/usr/bin/env node
// ==============================================================================
// OPS-1108 — Alertmanager yapılandırmasını ORTAM DEĞİŞKENLERİNDEN üretir (docker-compose.monitoring.yml `alertmanager-config` init servisi).
// Alertmanager env ile şablonlamayı desteklemez ve kanallar ortama göre değişir (Telegram/e-posta/webhook) — bu yüzden yapılandırma programatik
// üretilir, SIRLAR (bot token, SMTP parolası, webhook URL'leri) config'e DEĞİL ayrı `*_file` dosyalarına yazılır (config git/log'a sızmaz).
//
// NÖBET (ON-CALL) KANALLARI ve ŞİDDET SEVİYELERİ (docs/ALERTING.md):
//   critical → `oncall`  : müşteri/veri etkilenir, HEMEN insan gerekir (Telegram nöbet grubu + e-posta + webhook[PagerDuty/Opsgenie]); tekrar 1 saat.
//   warning  → `team`    : mesai içinde bakılır (Telegram ekip grubu + e-posta); gece 23:00-07:00 (Europe/Istanbul) SUSTURULUR, sabah tekrar bildirilir; tekrar 12 saat.
//   info     → `null`    : bildirim yok — Grafana/Alertmanager panosunda görünür (uyarı yorgunluğu).
//   Watchdog → `heartbeat`: her zaman ateşleyen "kalp atışı" → ALERT_HEARTBEAT_URL (dış ölü-adam servisi). Gönderim KESİLİRSE bildirim hattı ölmüştür.
// UYARI YORGUNLUĞU: group_by [alertname, severity] (örnek başına DEĞİL); group_wait/interval; critical→warning ve kök neden (BackendDown/PostgresDown/
// DiskSpace) → belirti bastırma (inhibit).
//
// FAIL-CLOSED: on-call (critical) için HİÇ kanal tanımlı değilse üretim BAŞARISIZ olur (init servisi çıkış 1 → Alertmanager başlamaz):
// kanalsız bir izleme yığını "uyarılar çalışıyor" izlenimi verip sessizce hiçbir şey göndermez. Geliştirmede ALERT_ALLOW_NO_CHANNELS=true.
//
// Env:  ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ONCALL, ALERT_TELEGRAM_CHAT_TEAM
//       ALERT_SMTP_HOST (host:port), ALERT_SMTP_FROM, ALERT_SMTP_USER, ALERT_SMTP_PASSWORD, ALERT_EMAIL_ONCALL, ALERT_EMAIL_TEAM (virgülle çoklu)
//       ALERT_WEBHOOK_URL_ONCALL, ALERT_WEBHOOK_URL_TEAM, ALERT_HEARTBEAT_URL
//       ALERT_ALLOW_NO_CHANNELS, ALERT_TIMEZONE (Europe/Istanbul), ALERT_MUTE_WARNINGS_NIGHT (true), ALERT_TIMING (fast: yalnızca tatbikat/test)
//       ALERT_SECRETS_PATH (Alertmanager'ın gördüğü sır dizini; varsayılan /etc/alertmanager/secrets)
// Kullanım: node scripts/monitoring/render-alertmanager.mjs <çıktı-dizini>
// ==============================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RUNBOOK_LINE = '{{ if .Annotations.runbook_url }}\nRunbook: {{ .Annotations.runbook_url }}{{ end }}';
const TEXT_TEMPLATE =
  '{{ range .Alerts }}[{{ .Status | toUpper }}] {{ .Labels.severity | toUpper }} — {{ .Annotations.summary }}\n{{ .Annotations.description }}' + RUNBOOK_LINE + '\n\n{{ end }}';
// Kök nedeni bastırılan (BackendDown → API/saha uyarıları) alarm adları.
const BACKEND_SYMPTOMS = 'ApiErrorRate|ApiLatencyP95|EventLoopLag|BackendMemoryHigh|DbPoolSaturated|BusinessMetricsStale|DevicesOfflineRatio|NoActiveDevices|DespatchQueueBacklog|DespatchQueueStuck|DespatchDeadLetter|NotificationRetryBacklog|NotificationWebhookCircuitOpen|Mqtt.*|CriticalFieldAlarmsOpen';
const DB_SYMPTOMS = 'DbPoolSaturated|PostgresConnectionsHigh|ApiErrorRate|ApiLatencyP95';

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function renderAlertmanager(env = process.env) {
  const secretsPath = env.ALERT_SECRETS_PATH || '/etc/alertmanager/secrets';
  const secrets = {}; // dosya adı → içerik
  const warnings = [];
  const fast = env.ALERT_TIMING === 'fast';
  const tz = env.ALERT_TIMEZONE || 'Europe/Istanbul';

  const smtp = env.ALERT_SMTP_HOST && env.ALERT_SMTP_FROM;
  const telegram = env.ALERT_TELEGRAM_BOT_TOKEN;
  if (telegram) secrets.telegram_bot_token = env.ALERT_TELEGRAM_BOT_TOKEN;
  const global = { resolve_timeout: '5m' };
  if (smtp) {
    Object.assign(global, { smtp_smarthost: env.ALERT_SMTP_HOST, smtp_from: env.ALERT_SMTP_FROM, smtp_require_tls: env.ALERT_SMTP_REQUIRE_TLS !== 'false' });
    if (env.ALERT_SMTP_USER) {
      global.smtp_auth_username = env.ALERT_SMTP_USER;
      secrets.smtp_password = env.ALERT_SMTP_PASSWORD || '';
      global.smtp_auth_password_file = `${secretsPath}/smtp_password`;
    }
  }

  const channelsFor = (level) => {
    const up = level.toUpperCase();
    const out = { telegram_configs: [], email_configs: [], webhook_configs: [] };
    const chat = env[`ALERT_TELEGRAM_CHAT_${up}`];
    if (telegram && chat) {
      if (!/^-?\d+$/.test(chat.trim())) throw new Error(`ALERT_TELEGRAM_CHAT_${up} sayısal bir chat kimliği olmalıdır.`);
      out.telegram_configs.push({ bot_token_file: `${secretsPath}/telegram_bot_token`, chat_id: Number(chat.trim()), message: TEXT_TEMPLATE, parse_mode: '', send_resolved: true });
    }
    const to = list(env[`ALERT_EMAIL_${up}`]);
    if (smtp && to.length) for (const addr of to) out.email_configs.push({ to: addr, send_resolved: true, headers: { Subject: '[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }} ({{ .CommonLabels.severity }})' }, html: '', text: TEXT_TEMPLATE });
    const url = env[`ALERT_WEBHOOK_URL_${up}`];
    if (url) {
      if (!/^https?:\/\//.test(url)) throw new Error(`ALERT_WEBHOOK_URL_${up} http(s) URL olmalıdır.`);
      secrets[`webhook_${level}`] = url;
      out.webhook_configs.push({ url_file: `${secretsPath}/webhook_${level}`, send_resolved: true, max_alerts: 20 });
    }
    return out;
  };
  const count = (c) => c.telegram_configs.length + c.email_configs.length + c.webhook_configs.length;
  const prune = (c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v.length));

  const oncall = channelsFor('oncall');
  const team = channelsFor('team');
  if (count(oncall) === 0 && env.ALERT_ALLOW_NO_CHANNELS !== 'true') {
    throw new Error('Nöbet (on-call) için HİÇ bildirim kanalı tanımlı değil (ALERT_TELEGRAM_*/ALERT_EMAIL_*/ALERT_WEBHOOK_URL_ONCALL). ' +
      'Kanalsız Alertmanager kritik uyarıları sessizce yutar. Geliştirmede ALERT_ALLOW_NO_CHANNELS=true.');
  }
  if (count(team) === 0) { Object.assign(team, oncall); if (count(oncall)) warnings.push('ekip (warning) kanalı tanımsız — warning uyarıları nöbet kanallarına yönlendiriliyor.'); }

  const receivers = [{ name: 'null' }, { name: 'oncall', ...prune(oncall) }, { name: 'team', ...prune(team) }];
  if (env.ALERT_HEARTBEAT_URL) {
    secrets.webhook_heartbeat = env.ALERT_HEARTBEAT_URL;
    receivers.push({ name: 'heartbeat', webhook_configs: [{ url_file: `${secretsPath}/webhook_heartbeat`, send_resolved: false }] });
  } else {
    receivers.push({ name: 'heartbeat' });
    warnings.push('ALERT_HEARTBEAT_URL tanımsız — Watchdog kalp atışı gönderilmiyor: bildirim hattının ölümü DIŞARIDAN fark edilemez.');
  }

  const t = fast ? { crit: ['2s', '4s', '1h'], warn: ['2s', '4s', '1h'], hb: ['1s', '5s', '5s'] } : { crit: ['30s', '5m', '1h'], warn: ['2m', '10m', '12h'], hb: ['0s', '5m', '5m'] };
  const route = {
    receiver: 'null',
    group_by: ['alertname', 'severity'],
    group_wait: fast ? '2s' : '30s', group_interval: fast ? '4s' : '5m', repeat_interval: '4h',
    routes: [
      { matchers: ['alertname="Watchdog"'], receiver: 'heartbeat', group_wait: t.hb[0], group_interval: t.hb[1], repeat_interval: t.hb[2] },
      { matchers: ['severity="critical"'], receiver: 'oncall', group_wait: t.crit[0], group_interval: t.crit[1], repeat_interval: t.crit[2] },
      { matchers: ['severity="warning"'], receiver: 'team', group_wait: t.warn[0], group_interval: t.warn[1], repeat_interval: t.warn[2], ...(env.ALERT_MUTE_WARNINGS_NIGHT !== 'false' && !fast ? { mute_time_intervals: ['night'] } : {}) },
      { matchers: ['severity="info"'], receiver: 'null' }
    ]
  };
  const inhibit_rules = [
    // Aynı alertname'in critical'ı varsa warning'i bastır (tek olay iki bildirim üretmesin).
    { source_matchers: ['severity="critical"'], target_matchers: ['severity="warning"'], equal: ['alertname'] },
    // Kök neden → belirtiler: backend ayakta değilken API/saha uyarıları gürültüdür.
    { source_matchers: ['alertname="BackendDown"'], target_matchers: [`alertname=~"${BACKEND_SYMPTOMS}"`] },
    { source_matchers: ['alertname="BackendMissing"'], target_matchers: [`alertname=~"${BACKEND_SYMPTOMS}"`] },
    { source_matchers: ['alertname="PostgresDown"'], target_matchers: [`alertname=~"${DB_SYMPTOMS}"`] },
    { source_matchers: ['alertname="DiskSpace"', 'severity="critical"'], target_matchers: ['alertname="DiskWillFillSoon"'] }
  ];
  const config = {
    global, route, inhibit_rules, receivers,
    time_intervals: [{ name: 'night', time_intervals: [{ times: [{ start_time: '00:00', end_time: '07:00' }, { start_time: '23:00', end_time: '24:00' }], location: tz }] }]
  };
  return { config, secrets, warnings, channels: { oncall: count(oncall), team: count(team) } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = process.argv[2];
  if (!out) { console.error('Kullanım: render-alertmanager.mjs <çıktı-dizini>'); process.exit(2); }
  try {
    const { config, secrets, warnings, channels } = renderAlertmanager();
    mkdirSync(path.join(out, 'secrets'), { recursive: true, mode: 0o755 });
    // YAML, JSON'un üst kümesidir — Alertmanager JSON biçimli yapılandırmayı okur.
    writeFileSync(path.join(out, 'alertmanager.yml'), JSON.stringify(config, null, 2) + '\n');
    for (const [name, value] of Object.entries(secrets)) writeFileSync(path.join(out, 'secrets', name), value, { mode: 0o644 });
    for (const w of warnings) console.warn(`[render-alertmanager] UYARI: ${w}`);
    console.log(`[render-alertmanager] yapılandırma yazıldı (nöbet kanalı: ${channels.oncall}, ekip kanalı: ${channels.team}).`);
  } catch (err) {
    console.error(`[render-alertmanager] HATA: ${err.message}`);
    process.exit(1);
  }
}
