#!/usr/bin/env python3
import os
import re
import sys
import json
import urllib.request
import urllib.error

is_dry_run = "--dry-run" in sys.argv
token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
repo = os.environ.get("REPO", "rtosma/YAKITTAKIPSISTEMI")

if not is_dry_run and not token:
    print("Hata: GH_TOKEN veya GITHUB_TOKEN ortam değişkeni bulunamadı.", file=sys.stderr)
    print("Kullanım: GH_TOKEN='token' python3 scripts/create_issues.py", file=sys.stderr)
    print("Test için: python3 scripts/create_issues.py --dry-run", file=sys.stderr)
    sys.exit(1)

with open("issue.md", "r", encoding="utf-8") as f:
    content = f.read()

# Split by module header
modules = re.split(r'(?=# Modül \d+:)', content)
modules = [m.strip() for m in modules if m.strip()]

def create_issue(title, labels, body):
    if is_dry_run:
        return {"number": "DRY-RUN", "html_url": "https://github.com/dry-run"}
    
    url = f"https://api.github.com/repos/{repo}/issues"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "Python-Issue-Creator"
    }
    payload = json.dumps({
        "title": title,
        "body": body,
        "labels": [l.strip() for l in labels]
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        raise Exception(f"HTTP {e.code}: {err_body}")

def main():
    mode = "DRY RUN MODU" if is_dry_run else "CANLI MOD"
    print(f"📋 Toplam {len(modules)} adet modül/issue işlenecek... ({mode})\n")

    count = 0
    for block in modules:
        title_m = re.search(r'--title\s+"([^"]+)"', block)
        label_m = re.search(r'--label\s+"([^"]+)"', block)
        body_m = re.search(r'--body\s+"([\s\S]+?)"\s*(?=\n# Modül|\n*$)', block)

        if title_m and body_m:
            count += 1
            title = title_m.group(1)
            labels = label_m.group(1).split(",") if label_m else []
            body = body_m.group(1).strip()

            print(f"[{count}/{len(modules)}] ⏳ İşleniyor: \"{title}\"")
            print(f"    Etiketler: {', '.join(labels)}")
            try:
                result = create_issue(title, labels, body)
                print(f"    ✅ Başarılı! Issue: {result.get('html_url')}\n")
            except Exception as e:
                print(f"    ❌ Hata: {e}\n")
        else:
            print(f"⚠️ Ayrıştırılamayan blok: {block[:60]}...")

    print(f"🎉 İşlem tamamlandı. Toplam {count} issue ayrıştırıldı ve işlendi.")

if __name__ == "__main__":
    main()
