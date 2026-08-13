import fs from 'fs';

const isDryRun = process.argv.includes('--dry-run');
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const repo = process.env.REPO || 'rtosma/YAKITTAKIPSISTEMI';

if (!isDryRun && !token) {
  console.error('Hata: GH_TOKEN veya GITHUB_TOKEN ortam değişkeni bulunamadı.');
  console.error('Kullanım: GH_TOKEN="your_personal_access_token" node scripts/create_issues.js');
  console.error('Test için: node scripts/create_issues.js --dry-run');
  process.exit(1);
}

const issueContent = fs.readFileSync('issue.md', 'utf-8');

const modules = issueContent.split(/(?=# Modül \d+:)/g).filter(block => block.trim().length > 0);

async function createIssue(title, labels, body) {
  if (isDryRun) {
    return { number: 'DRY-RUN', html_url: 'https://github.com/dry-run' };
  }
  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'NodeJS-Issue-Creator'
    },
    body: JSON.stringify({
      title,
      body,
      labels: labels.map(l => l.trim())
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Issue oluşturulamadı (${response.status}): ${errorText}`);
  }

  return await response.json();
}

async function main() {
  console.log(`📋 Toplam ${modules.length} adet modül/issue işlenecek... (${isDryRun ? 'DRY RUN MODU' : 'CANLI MOD'})\n`);

  let count = 0;
  for (const block of modules) {
    const titleMatch = block.match(/--title\s+"([^"]+)"/);
    const labelMatch = block.match(/--label\s+"([^"]+)"/);
    const bodyMatch = block.match(/--body\s+"([\s\S]+?)"\s*(?=\n# Modül|\n*$)/);

    if (titleMatch && bodyMatch) {
      count++;
      const title = titleMatch[1];
      const labels = labelMatch ? labelMatch[1].split(',') : [];
      const body = bodyMatch[1].trim();

      console.log(`[${count}/${modules.length}] ⏳ İşleniyor: "${title}"`);
      console.log(`    Etiketler: ${labels.join(', ')}`);
      try {
        const result = await createIssue(title, labels, body);
        console.log(`    ✅ Başarılı! Issue: ${result.html_url}\n`);
      } catch (err) {
        console.error(`    ❌ Hata:`, err.message, '\n');
      }
    } else {
      console.warn(`⚠️ Ayrıştırılamayan blok: ${block.substring(0, 50)}...`);
    }
  }
  console.log(`🎉 İşlem tamamlandı. Toplam ${count} issue işlendi.`);
}

main();
