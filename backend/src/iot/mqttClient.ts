import mqtt, { MqttClient } from 'mqtt';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { redisPool } from '../db/redisPool';
import { EventEmitter } from 'events';
import { runWithTenant } from '../context/tenantContext';

// Local Event Bus for decoupling (Prep for ARCH-102: BullMQ)
export const ioTEventBus = new EventEmitter();

// IOT-301.1: "İki backend örneği çalışırken her mesaj yalnızca bir kez
// işlenmelidir." Bu ÖZELLİKLE OPS-1102'nin zero-downtime deploy script'i
// için gerçek bir senaryo: dağıtım sırasında birkaç saniyeliğine eski VE
// yeni backend replikası AYNI ANDA ayakta ve MQTT'ye bağlı olur. Paylaşımlı
// abonelik olmadan EMQX aynı mesajı HER İKİ replikaya da teslim eder — bu da
// telemetri olaylarının (ve onlara bağlı Socket.io yayınlarının) o pencerede
// iki kez işlenmesine yol açar. `$share/<group>/<topic>` ile broker mesajı
// gruptaki yalnızca BİR üyeye dağıtır.
const MQTT_SHARE_GROUP = 'yakittakip-backend';

// IOT-301.1: mqtt.js'in yerleşik reconnectPeriod'u SABİT bir gecikmedir,
// üstel değil. reconnectPeriod: 0 ile yerleşik yeniden bağlanma kapatılıp
// burada üstel backoff (1sn, 2sn, 4sn... 30sn tavan) elle yönetiliyor;
// başarılı bir 'connect' sayaç sıfırlar.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class MQTTService {
  private client: MqttClient | null = null;
  private readonly brokerUrl = config.MQTT_URL;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manuallyDisconnected = false;

  public connect(): void {
    this.manuallyDisconnected = false;
    logger.info(`🔌 [MQTT] Broker'a bağlanılıyor: ${this.brokerUrl}`);

    this.client = mqtt.connect(this.brokerUrl, {
      clientId: `backend_service_${Math.random().toString(16).slice(3)}`,
      clean: false, // Kalıcı oturum (QoS 1 mesajlarını kaybetmemek için)
      reconnectPeriod: 0, // bkz. yukarıdaki not — üstel backoff elle yönetiliyor
      protocolVersion: 5,
      // EMQX artık anonim bağlantı kabul etmiyor (bkz. docker-compose.yml /
      // docker/emqx/entrypoint.sh) — kimlik doğrulaması olmadan herkes sahte
      // pompa/tank telemetrisi yayınlayabilir ya da tüm kiracıların canlı
      // verisine abone olabilirdi.
      username: config.MQTT_USERNAME,
      password: config.MQTT_PASSWORD,
    });

    this.client.on('connect', () => {
      logger.info('✅ [MQTT] Broker bağlantısı başarılı.');
      this.reconnectAttempts = 0; // başarılı bağlantı — backoff sayacı sıfırlanır

      // ESP32'lerden gelen standart telemetri verileri
      // Format: telemetry/v1/{tenantId}/{siteId}/{deviceType}/{deviceId}/data
      this.client?.subscribe(`$share/${MQTT_SHARE_GROUP}/telemetry/v1/+/+/+/+/data`, { qos: 1 }, (err) => {
        if (err) logger.error({ err }, '🚨 [MQTT] /data topic abone olunamadı!');
        else logger.info('📡 [MQTT] Telemetri veri akışı (data) dinleniyor... (paylaşımlı abonelik)');
      });

      // ESP32'lerden gelen LWT (Last Will and Testament) veya durum mesajları
      // Format: telemetry/v1/{tenantId}/{siteId}/{deviceType}/{deviceId}/status
      this.client?.subscribe(`$share/${MQTT_SHARE_GROUP}/telemetry/v1/+/+/+/+/status`, { qos: 1 }, (err) => {
        if (err) logger.error({ err }, '🚨 [MQTT] /status topic abone olunamadı!');
        else logger.info('📡 [MQTT] Cihaz durum akışı (status/LWT) dinleniyor... (paylaşımlı abonelik)');
      });
    });

    this.client.on('message', async (topic, payload) => {
      try {
        // $share/<group>/ öneki yalnızca ABONELİK filtresinde kullanılır —
        // broker teslim ederken mesajın topic'ini asıl (paylaşımsız) haline
        // döndürür, bu yüzden parse mantığı DEĞİŞMİYOR.
        const parts = topic.split('/');
        // Örnek: ["telemetry", "v1", "tenant1", "site1", "pump", "device123", "data"]
        if (parts.length < 7) return;

        const tenantId = parts[2];
        const siteId = parts[3];
        const deviceType = parts[4];
        const deviceId = parts[5];
        const messageType = parts[6]; // 'data' veya 'status'

        const messageStr = payload.toString();

        // ARCH-101.4: MQTT bir HTTP isteği değil, authenticateJWT middleware'i
        // hiç çalışmaz — bu yüzden AsyncLocalStorage tenant context'i burada,
        // topic'ten ayrıştırılan tenantId ile açıkça kuruluyor. Bu sayede bu
        // handler içinden (veya senkron olarak emit edilen 'telemetryData'
        // event'ini dinleyen socketServer.ts gibi abonelerden) çağrılabilecek
        // withTenant()/getTenantId() tabanlı repository fonksiyonları doğru
        // kiracıyı görür — context olmadan çağrılırlarsa sessizce yanlış
        // veri döndürmek yerine MissingTenantContextException fırlatırlar.
        await runWithTenant({ tenantId }, async () => {
          if (messageType === 'status') {
            // LWT veya manuel statüs bildirimi
            const status = messageStr.toUpperCase() === 'OFFLINE' ? 'OFFLINE' : 'ONLINE';
            const changed = await redisPool.setDeviceState(deviceId, status);
            if (changed) {
              // IOT-301.2 AC: "Cihaz durumu değişimi canlı olarak arayüze
              // yansımalıdır" — yalnızca GERÇEK bir geçişte yayınlanır.
              ioTEventBus.emit('deviceStatusChanged', { tenantId, siteId, deviceType, deviceId, status });
            }
          } else if (messageType === 'data') {
            const parsedData = JSON.parse(messageStr);

            // Gelen veriyi logla
            logger.debug({ deviceId, parsedData }, '📩 [MQTT] Telemetri verisi alındı.');

            // Event fırlat (İleride BullMQ'ya aktarmak üzere ARCH-102)
            ioTEventBus.emit('telemetryData', {
              tenantId,
              siteId,
              deviceType,
              deviceId,
              data: parsedData,
              timestamp: new Date().toISOString()
            });

            // Cihaz veri gönderiyorsa kesinlikle ONLINE'dır.
            const changed = await redisPool.setDeviceState(deviceId, 'ONLINE');
            if (changed) {
              ioTEventBus.emit('deviceStatusChanged', { tenantId, siteId, deviceType, deviceId, status: 'ONLINE' });
            }
          }
        });
      } catch (err) {
        logger.error({ err, topic, payload: payload.toString() }, '🚨 [MQTT] Mesaj işleme hatası!');
      }
    });

    this.client.on('error', (err) => {
      logger.error({ err }, '🚨 [MQTT] Bağlantı hatası!');
    });

    this.client.on('close', () => {
      if (this.manuallyDisconnected) return;
      this.scheduleReconnect();
    });
  }

  /**
   * IOT-301.1 AC: "Broker koptuğunda istemci exponential backoff ile
   * yeniden bağlanmalıdır." 1sn'den başlayıp her denemede ikiye katlanır,
   * 30sn'de tavanlanır — broker kısa süreliğine yeniden başlatıldığında
   * hızlı, uzun süreli bir kesintide ise brokera/ağa saldırı gibi görünecek
   * bir istek fırtınası yaratmadan yeniden dener.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // zaten planlanmış bir yeniden deneme var
    const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    logger.warn(
      { delayMs, attempt: this.reconnectAttempts },
      `⚠️ [MQTT] Broker ile bağlantı koptu — ${delayMs}ms sonra yeniden denenecek (deneme #${this.reconnectAttempts}).`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.client?.end(true, {}, () => this.connect());
    }, delayMs);
  }

  /**
   * FUEL-401.3: sunucudan cihaza komut yayını (örn. FORCE_CUTOFF). Bu servis
   * şimdiye kadar yalnızca ABONE oluyordu (telemetri/status akışı) — bu ilk
   * gerçek YAYIN çağrısı. `command/v1/{deviceId}` topic'i, telemetri
   * topic'inin (`telemetry/v1/...`) tam tersi yönü temsil eder; ESP32
   * firmware'i bu topic'i dinleyip pompayı fiziksel olarak keser (donanım
   * tarafı bu ticket'ın kapsamı dışında, yalnızca sunucu tarafı komut
   * gönderimi burada).
   */
  public publishCommand(deviceId: string, command: string, payload: Record<string, unknown> = {}): void {
    if (!this.client || !this.client.connected) {
      logger.error({ deviceId, command }, '🚨 [MQTT] Broker bağlı değilken komut yayınlanamadı!');
      return;
    }
    const topic = `command/v1/${deviceId}`;
    const message = JSON.stringify({ command, ...payload, issuedAt: new Date().toISOString() });
    this.client.publish(topic, message, { qos: 1 }, (err) => {
      if (err) logger.error({ err, deviceId, command }, '🚨 [MQTT] Komut yayınlanamadı!');
      else logger.warn({ deviceId, command }, `📤 [MQTT] Komut yayınlandı: ${command} → ${deviceId}`);
    });
  }

  public async disconnect(): Promise<void> {
    this.manuallyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      await new Promise<void>((resolve) => {
        this.client!.end(false, {}, () => {
          logger.info('🔌 [MQTT] Broker bağlantısı kapatıldı.');
          resolve();
        });
      });
    }
  }
}

export const mqttService = new MQTTService();
