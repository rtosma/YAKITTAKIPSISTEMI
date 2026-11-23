// REP-702 — `archiver`'ın YAYINLANMIŞ TEK `@types/archiver` paketi (8.x) yalnızca
// `archiver@8`'in yeni sınıf tabanlı API'sini ({Archiver, ZipArchive, ...})
// tipler. Bu depo bilerek `archiver@7.0.1`'e SABİTLENDİ (bkz. package.json
// yorumu) — çünkü `archiver-zip-encrypted` eklentisi (gerçek WinZip AES-256
// şifreleme) yalnızca 7.x'in ESKİ, fonksiyonel API'siyle (`archiver.create(...)`,
// `archiver.registerFormat(...)`) çalışır; 8.x bu API'yi TAMAMEN kaldırdı.
// Yayınlanmış tipler bu yüzden çalışma zamanındaki gerçek şekille uyumsuz —
// burada, projede ilk kez, KÜÇÜK bir özel ambient bildirim kullanılıyor.
declare module 'archiver' {
  import { Transform } from 'stream';

  interface ArchiverOptions {
    zlib?: { level?: number };
    // archiver-zip-encrypted'in eklediği alanlar — temel `archiver` tipinde yok.
    encryptionMethod?: 'aes256' | 'aes192' | 'aes128' | 'zip20';
    password?: string;
    [key: string]: unknown;
  }

  interface EntryData {
    name: string;
    date?: Date;
    mode?: number;
    prefix?: string;
  }

  interface Archiver extends Transform {
    append(source: Buffer | NodeJS.ReadableStream | string, data: EntryData): Archiver;
    finalize(): Promise<void>;
    pointer(): number;
    abort(): Archiver;
  }

  interface ArchiverStatic {
    (format: string, options?: ArchiverOptions): Archiver;
    create(format: string, options?: ArchiverOptions): Archiver;
    registerFormat(format: string, module: unknown): void;
    isRegisteredFormat(format: string): boolean;
  }

  const archiver: ArchiverStatic;
  export = archiver;
}

// archiver-zip-encrypted, `archiver.registerFormat('zip-encrypted', <bu modül>)`
// ile kaydedilen ham bir CommonJS modül dışa aktarır — kendi başına
// çağrılan/yeni bir tipi yok, yalnızca `archiver`'ın içine kaydedilir.
declare module 'archiver-zip-encrypted' {
  const zipEncryptedFormatModule: unknown;
  export = zipEncryptedFormatModule;
}
