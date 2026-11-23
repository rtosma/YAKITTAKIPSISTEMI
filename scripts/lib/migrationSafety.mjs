// ==============================================================================
// OPS-1104 — schema.sql değişikliklerinin "expand/contract" (iki aşamalı) güvenliği.
//
// Ticket Teknik Notu: "Geriye uyumsuz migration'lar zero-downtime dağıtımı bozar;
// iki aşamalı (expand/contract) yaklaşım kullanılmalıdır." Bu projede migration aracı
// (drizzle-kit) yok: schema.sql her dağıtımda idempotent şekilde, tek transaction'da
// uygulanır (scripts/zero-downtime-deploy.sh, adım 2b) ve BLUE/GREEN geçişte eski
// replika yeni şemayla bir süre birlikte çalışır. Bu yüzden şema değişikliği yalnızca
// EKLEYİCİ (expand) olmalıdır; yıkıcı/uyumsuz adımlar (contract) ancak eski kod artık
// hiçbir yerde çalışmadığında, AYRI bir dağıtımda ve bilinçli onayla yapılabilir.
//
// Bu modül iki şema sürümünü ifade (statement) düzeyinde karşılaştırır: YENİ sürümde
// olup ESKİSİNDE olmayan her ifadeyi geriye uyumsuzluk kalıpları için tarar. Satır
// değil ifade karşılaştırıldığı için taşınan/yeniden biçimlenen ifadeler (ve dosyanın
// tarihsel içeriği) yanlış alarm üretmez.
//
// ONAY (bilinçli contract adımı): ifadenin hemen üstündeki yorum satırlarından biri
//   -- MIGRATION-CONTRACT: <en az 15 karakterlik gerekçe / ilgili issue>
// içeriyorsa ihlal "onaylı" sayılır (raporlanır ama CI'ı kırmaz). Gerekçesiz veya
// kısa gerekçeli işaret kabul edilmez.
//
// Sıfır bağımlılık. Kullanım (CLI): scripts/check-migration-safety.mjs
// ==============================================================================

export const APPROVAL_MARKER = 'MIGRATION-CONTRACT:';
export const MIN_REASON_LENGTH = 15;

/** SQL metnini {sql, comments[]} ifadelerine böler ($$ blokları, tırnaklar ve -- yorumları güvenle atlanır). */
export function splitStatements(text) {
  const statements = [];
  let buf = '';
  let comments = [];
  let commentBuf = [];
  let i = 0;
  const n = text.length;
  let dollarTag = null;
  const flush = () => {
    // Boşluk farkları (satır sonu, `;` öncesi boşluk, parantez içi boşluk) ifadeyi "değişmiş" göstermesin.
    const sql = buf.replace(/\s+/g, ' ').trim().replace(/\s+([;,)])/g, '$1').replace(/([(])\s+/g, '$1');
    if (sql) statements.push({ sql, comments: comments.slice() });
    buf = '';
    comments = [];
  };
  while (i < n) {
    const ch = text[i];
    if (dollarTag) {
      if (text.startsWith(dollarTag, i)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      buf += ch; i++; continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      const line = text.slice(i + 2, end === -1 ? n : end).trim();
      // Yorum, ondan SONRA başlayan ifadeye aittir (bir ifadenin ortasındaki yorum da ona eklenir).
      commentBuf.push(line);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      if (!buf.trim()) { comments = comments.concat(commentBuf); commentBuf = []; }
      buf += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 40));
      if (m) {
        if (!buf.trim()) { comments = comments.concat(commentBuf); commentBuf = []; }
        dollarTag = m[0]; buf += m[0]; i += m[0].length; continue;
      }
    }
    if (ch === ';') { buf += ';'; i++; flush(); continue; }
    if (!buf.trim() && /\S/.test(ch)) { comments = comments.concat(commentBuf); commentBuf = []; }
    buf += ch; i++;
  }
  flush();
  return statements;
}

const RULES = [
  { id: 'DROP_TABLE', re: /\bDROP\s+TABLE\b/i, why: 'Tablo silme eski replikayı kırar; önce kullanımı kaldırıp AYRI bir dağıtımda silin.' },
  { id: 'DROP_COLUMN', re: /\bDROP\s+COLUMN\b/i, why: 'Kolon silme eski replikanın sorgularını kırar (expand/contract: önce kod kullanmayı bıraksın).' },
  { id: 'RENAME', re: /\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b|\bALTER\s+TABLE\s+\S+\s+RENAME\b/i, why: 'Yeniden adlandırma eski replikayı kırar (yeni kolonu ekleyip kopyalayın, eskisini sonra silin).' },
  { id: 'ALTER_TYPE', re: /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, why: 'Kolon tipi değişimi tabloyu yeniden yazabilir/kilitleyebilir ve eski kodu kırabilir. Genişletme (VARCHAR(n) büyütme) bile onay ister.' },
  { id: 'SET_NOT_NULL', re: /\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i, why: 'NOT NULL eklemek eski replikanın NULL yazan INSERT/UPDATE\'lerini reddettirir ve dolu tabloda başarısız olabilir.' },
  { id: 'TRUNCATE', re: /^\s*TRUNCATE\b/i, why: 'TRUNCATE veri kaybıdır.' },
  { id: 'DROP_TYPE_INDEX', re: /^\s*DROP\s+(TYPE|INDEX|SCHEMA)\b(?!\s+IF\s+EXISTS\s+idx_)/i, why: 'Tip/şema/indeks silme geriye uyumsuz olabilir.' },
  { id: 'DELETE_ALL', re: /^\s*DELETE\s+FROM\s+\S+\s*;?\s*$/i, why: 'Koşulsuz DELETE veri kaybıdır.' }
];

// Idempotent yeniden kurulum kalıpları (her dağıtımda çalışır, güvenlidir): DROP POLICY/TRIGGER/FUNCTION/VIEW IF EXISTS,
// DROP CONSTRAINT IF EXISTS (gevşetme), REVOKE/GRANT. Bunlar RULES'a zaten girmez; ayrıca açıkça belgelenir.

/** Bir ifade eklemeli-geriye uyumsuz mu? [{rule, why}] döner. */
export function classifyStatement(sql) {
  const found = [];
  for (const r of RULES) if (r.re.test(sql)) found.push({ rule: r.id, why: r.why });
  // NOT NULL kolon ekleme: DEFAULT (veya GENERATED) yoksa eski replika INSERT'leri kolonu vermez → hata.
  const addCols = sql.match(/\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?[^,;]+/gi);
  if (addCols) {
    for (const c of addCols) {
      if (/\bNOT\s+NULL\b/i.test(c) && !/\bDEFAULT\b|\bGENERATED\b/i.test(c)) {
        found.push({ rule: 'ADD_NOT_NULL_NO_DEFAULT', why: 'DEFAULT\'suz NOT NULL kolon: dolu tabloda başarısız olur, eski replika INSERT\'leri kolonu vermediği için kırılır.' });
        break;
      }
    }
  }
  return found;
}

function approvalFor(statement) {
  for (const c of statement.comments) {
    const idx = c.indexOf(APPROVAL_MARKER);
    if (idx !== -1) {
      const reason = c.slice(idx + APPROVAL_MARKER.length).trim();
      if (reason.length >= MIN_REASON_LENGTH) return reason;
    }
  }
  return null;
}

/**
 * @returns {{violations: object[], approved: object[], added: number}}
 *  violations: onaysız geriye uyumsuz yeni ifadeler (CI'ı kırar) — approved: onaylı contract adımları.
 */
export function analyzeMigration(oldSql, newSql) {
  const oldSet = new Set(splitStatements(oldSql).map((s) => s.sql));
  const added = splitStatements(newSql).filter((s) => !oldSet.has(s.sql));
  const violations = [];
  const approved = [];
  for (const st of added) {
    const issues = classifyStatement(st.sql);
    if (issues.length === 0) continue;
    const reason = approvalFor(st);
    const entry = { sql: st.sql.length > 160 ? `${st.sql.slice(0, 157)}...` : st.sql, issues };
    if (reason) approved.push({ ...entry, reason });
    else violations.push(entry);
  }
  return { violations, approved, added: added.length };
}
