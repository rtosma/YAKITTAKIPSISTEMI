#include <Wire.h>
#include <Adafruit_PN532.h>

#define AKIS_SENSOR_PIN 14
#define ROLE_PIN 13

Adafruit_PN532 nfc(4, 5);
volatile int pulseCount = 0;
unsigned long sonAkisZamani = 0;
bool dolumDevamEdiyor = false;
float toplamLitre = 0;

void IRAM_ATTR countPulse() {
  pulseCount++;
  sonAkisZamani = millis(); // Her akış sinyalinde zamanı güncelle
}

void setup() {
  Serial.begin(115200);
  pinMode(ROLE_PIN, OUTPUT);
  digitalWrite(ROLE_PIN, LOW);
  
  pinMode(AKIS_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(AKIS_SENSOR_PIN), countPulse, FALLING);

  nfc.begin();
  if (!nfc.getFirmwareVersion()) {
    Serial.println("RFID Hatasi!");
    while (1);
  }
  nfc.SAMConfig();
  Serial.println("\nKUSAK BETON OTOMASYON: Hazir. Cipi okutun...");
}

void loop() {
  uint8_t success;
  uint8_t uid[] = { 0, 0, 0, 0, 0, 0, 0 };
  uint8_t uidLength;

  // Eğer dolum yapmıyorsak yeni kart bekle
  if (!dolumDevamEdiyor) {
    success = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 200);
    if (success) {
      Serial.println("\n>>> YETKILI KART: Dolum Basladi!");
      digitalWrite(ROLE_PIN, HIGH); // Pompayı aç
      dolumDevamEdiyor = true;
      pulseCount = 0;
      toplamLitre = 0;
      sonAkisZamani = millis();
    }
  } 
  else {
    // Dolum devam ediyorsa miktarı yazdır
    toplamLitre = pulseCount / 450.0; // Kalibrasyon değerin (450)
    Serial.print("\rGuncel Miktar: ");
    Serial.print(toplamLitre);
    Serial.print(" Litre \n");

    // Akış durdu mu kontrol et (3 saniye boyunca sinyal gelmezse kapat)
    if (millis() - sonAkisZamani > 3000) {
      digitalWrite(ROLE_PIN, LOW); // Pompayı kapat
      dolumDevamEdiyor = false;
      Serial.println("\n[+] AKIS DURDU. Toplam Dolum: " + String(toplamLitre) + " L.");
      Serial.println("Yeni islem icin kart bekliyor...");
    }
  }
}