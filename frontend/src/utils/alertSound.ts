/**
 * FE-815 Teknik Not: "Kritik alarmlarda sesli uyarı gerekir ama tarayıcı
 * otomatik ses çalmayı engelleyebilir; kullanıcı etkileşimiyle etkinleştirme
 * akışı gerekir." Bu kod tabanında hiçbir ses dosyası/altyapısı yoktu — yeni
 * bir .mp3/.wav bağımlılığı EKLEMEDEN Web Audio API ile kısa bir "bip"
 * üretiliyor. `enableAlertSound()` kullanıcının KENDİ tıklamasıyla
 * çağrılmalı (tarayıcının autoplay politikası, bir AudioContext'in ilk
 * kez kullanıcı hareketi OLMADAN "resume" edilmesini reddeder) — bu
 * fonksiyon o ilk, sessiz/minik "etkinleştirme" dokunuşudur.
 */

let audioContext: AudioContext | null = null;
let isEnabled = false;

export function isAlertSoundEnabled(): boolean {
  return isEnabled;
}

export function enableAlertSound(): void {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  isEnabled = true;
}

/** Kritik bir alarm geldiğinde çağrılır — etkinleştirilmemişse sessizce hiçbir şey yapmaz (hata fırlatmaz). */
export function playAlertBeep(): void {
  if (!isEnabled || !audioContext) return;
  try {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.4);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.4);
  } catch {
    // Tarayıcı/ortam Web Audio'yu desteklemiyor veya reddetti — sessizce yut, alarm akışını ETKİLEMEZ.
  }
}
