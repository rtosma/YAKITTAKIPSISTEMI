# Roboto (Google) — Apache License 2.0

`Roboto-Regular.woff` ve `Roboto-Bold.woff`, [npm `roboto-fontface@0.10.0`](https://www.npmjs.com/package/roboto-fontface)
paketinden (`package/fonts/roboto/`) alınmıştır — Google'ın Roboto yazı
tipinin Apache License 2.0 altında dağıtılan derlemesi.

## Neden burada (REP-703 PDF export)

pdfkit'in gömülü standart-14 fontları (Helvetica vb.) WinAnsiEncoding
kullanır — Türkçe'ye özgü `ş Ş ğ Ğ ı İ` karakterleri bu kodlamada YOKTUR ve
sessizce yanlış/anlamsız glif'lere dönüşür (canlı doğrulandı: "İkmal Hareket
Raporu" başlığı "Aà ¶ÖÂ†&V°et Raporu" olarak render edildi). Roboto,
Latin Extended-A'yı (Türkçe dahil) kapsayan gerçek bir Unicode font'tur ve
pdfkit/fontkit onu gömüp doğru glif'leri seçebiliyor.

`.woff2` DEĞİL `.woff` kullanılıyor: fontkit (pdfkit'in font ayrıştırıcısı)
bu paketin `.woff2` dosyalarını `_addGlyph`'te bir `RangeError` ile
işleyemedi (muhtemelen fontkit'in woff2 glyf-transform desteğindeki bir
sınır) — `.woff` sürümleri sorunsuz gömülüyor.

## Nasıl okunuyor

`process.cwd()`'ye göre (Dockerfile'da WORKDIR `/app`, container'da
`/app/src/reports/assets/fonts/...`) — `despatchAdviceXmlService.ts`'in
vendored UBL XSD'leri okuma deseniyle AYNI (bkz. o dosyadaki yorum);
`__dirname`/`import.meta.url` DEĞİL, çünkü esbuild bundle'ı `dist/`'e
çıkıyor ve bu ikisi orada `src/`'e göre anlamlı bir yol vermez.
