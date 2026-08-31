import mqtt, { MqttClient } from 'mqtt';
import { logger } from '../utils/logger';
import { redisPool } from '../db/redisPool';
import { EventEmitter } from 'events';

// Local Event Bus for decoupling (Prep for ARCH-102: BullMQ)
export const ioTEventBus = new EventEmitter();

class MQTTService {
  private client: MqttClient | null = null;
  private readonly brokerUrl = process.env.MQTT_URL || 'mqtt://localhost:1883';

  public connect(): void {
    logger.info(`🔌 [MQTT] Broker'a bağlanılıyor: ${this.brokerUrl}`);

    this.client = mqtt.connect(this.brokerUrl, {
      clientId: `backend_service_${Math.random().toString(16).slice(3)}`,
      clean: false, // Kalıcı oturum (QoS 1 mesajlarını kaybetmemek için)
      reconnectPeriod: 5000,
      protocolVersion: 5,
    });

    this.client.on('connect', () => {
      logger.info('✅ [MQTT] Broker bağlantısı başarılı.');
      
      // ESP32'lerden gelen standart telemetri verileri
      // Format: telemetry/v1/{tenantId}/{siteId}/{deviceType}/{deviceId}/data
      this.client?.subscribe('telemetry/v1/+/+/+/+/data', { qos: 1 }, (err) => {
        if (err) logger.error({ err }, '🚨 [MQTT] /data topic abone olunamadı!');
        else logger.info('📡 [MQTT] Telemetri veri akışı (data) dinleniyor...');
      });

      // ESP32'lerden gelen LWT (Last Will and Testament) veya durum mesajları
      // Format: telemetry/v1/{tenantId}/{siteId}/{deviceType}/{deviceId}/status
      this.client?.subscribe('telemetry/v1/+/+/+/+/status', { qos: 1 }, (err) => {
        if (err) logger.error({ err }, '🚨 [MQTT] /status topic abone olunamadı!');
        else logger.info('📡 [MQTT] Cihaz durum akışı (status/LWT) dinleniyor...');
      });
    });

    this.client.on('message', async (topic, payload) => {
      try {
        const parts = topic.split('/');
        // Örnek: ["telemetry", "v1", "tenant1", "site1", "pump", "device123", "data"]
        if (parts.length < 7) return;

        const tenantId = parts[2];
        const siteId = parts[3];
        const deviceType = parts[4];
        const deviceId = parts[5];
        const messageType = parts[6]; // 'data' veya 'status'

        const messageStr = payload.toString();

        if (messageType === 'status') {
          // LWT veya manuel statüs bildirimi
          const status = messageStr.toUpperCase() === 'OFFLINE' ? 'OFFLINE' : 'ONLINE';
          await redisPool.setDeviceState(deviceId, status);
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
          await redisPool.setDeviceState(deviceId, 'ONLINE');
        }
      } catch (err) {
        logger.error({ err, topic, payload: payload.toString() }, '🚨 [MQTT] Mesaj işleme hatası!');
      }
    });

    this.client.on('error', (err) => {
      logger.error({ err }, '🚨 [MQTT] Bağlantı hatası!');
    });

    this.client.on('offline', () => {
      logger.warn('⚠️ [MQTT] Broker ile bağlantı koptu, yeniden bağlanılmaya çalışılıyor...');
    });
  }

  public async disconnect(): Promise<void> {
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
