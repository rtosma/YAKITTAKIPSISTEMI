// FUEL-402.2 — `redlock`'un YAYINLANMIŞ tek `@types/redlock` paketi yok
// (npm registry'de bulunamadı) ve kütüphanenin kendisi de (v4.2.0, en son
// KARARLI sürüm — v5 hâlâ beta) düz CommonJS, tip bildirimi içermiyor.
// archiver.d.ts'teki AYNI desen: burada, kullandığımız YÜZEYE (promise
// stilinde lock/unlock + clientError event'i) özgü küçük bir ambient
// bildirim kullanılıyor.
declare module 'redlock' {
  import { EventEmitter } from 'events';

  interface RedlockOptions {
    driftFactor?: number;
    retryCount?: number;
    retryDelay?: number;
    retryJitter?: number;
  }

  interface Lock {
    resource: string;
    value: string;
    expiration: number;
    unlock(): Promise<void>;
    extend(ttl: number): Promise<Lock>;
  }

  class Redlock extends EventEmitter {
    constructor(clients: unknown[], options?: RedlockOptions);
    lock(resource: string, ttl: number): Promise<Lock>;
    on(event: 'clientError', listener: (err: Error) => void): this;
  }

  export = Redlock;
}
