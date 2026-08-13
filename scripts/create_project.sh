#!/usr/bin/env bash
set -euo pipefail

OWNER="rtosma"
REPO="YAKITTAKIPSISTEMI"
PROJECT_NAME="${REPO} Project"

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

if [ -z "$TOKEN" ]; then
  echo "Hata: GITHUB_TOKEN veya GH_TOKEN ortam değişkeni bulunamadı."
  echo "Kullanım: GITHUB_TOKEN='ghp_yourtoken...' ./scripts/create_project.sh"
  exit 1
fi

API_HEADER="Accept: application/vnd.github.inertia-preview+json"
AUTH_HEADER="Authorization: token ${TOKEN}"

echo "1. '${PROJECT_NAME}' projesi oluşturuluyor..."
PROJECT_RESPONSE=$(curl -s -X POST \
  -H "${AUTH_HEADER}" \
  -H "${API_HEADER}" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/${OWNER}/${REPO}/projects" \
  -d "{\"name\":\"${PROJECT_NAME}\",\"body\":\"${REPO} Proje Takip Tahtası\"}")

PROJECT_ID=$(echo "$PROJECT_RESPONSE" | jq -r '.id // empty')
PROJECT_URL=$(echo "$PROJECT_RESPONSE" | jq -r '.html_url // empty')

if [ -z "$PROJECT_ID" ]; then
  echo "Hata: Proje oluşturulamadı."
  echo "$PROJECT_RESPONSE"
  exit 1
fi

echo "✅ Proje oluşturuldu! ID: ${PROJECT_ID}"
echo "🔗 URL: ${PROJECT_URL}"

echo "2. Sütunlar oluşturuluyor ('To do', 'In progress', 'Done')..."
TODO_RESPONSE=$(curl -s -X POST \
  -H "${AUTH_HEADER}" \
  -H "${API_HEADER}" \
  -H "Content-Type: application/json" \
  "https://api.github.com/projects/${PROJECT_ID}/columns" \
  -d '{"name":"To do"}')
TODO_COLUMN_ID=$(echo "$TODO_RESPONSE" | jq -r '.id // empty')

curl -s -X POST \
  -H "${AUTH_HEADER}" \
  -H "${API_HEADER}" \
  -H "Content-Type: application/json" \
  "https://api.github.com/projects/${PROJECT_ID}/columns" \
  -d '{"name":"In progress"}' > /dev/null

curl -s -X POST \
  -H "${AUTH_HEADER}" \
  -H "${API_HEADER}" \
  -H "Content-Type: application/json" \
  "https://api.github.com/projects/${PROJECT_ID}/columns" \
  -d '{"name":"Done"}' > /dev/null

if [ -z "$TODO_COLUMN_ID" ]; then
  echo "Hata: 'To do' sütunu oluşturulamadı."
  echo "$TODO_RESPONSE"
  exit 1
fi

echo "✅ 'To do' sütun ID: ${TODO_COLUMN_ID}"

echo "3. Açık issue'lar çekiliyor ve 'To do' sütununa kart olarak ekleniyor..."
ISSUES=$(curl -s -H "${AUTH_HEADER}" "https://api.github.com/repos/${OWNER}/${REPO}/issues?state=open&per_page=100")

echo "$ISSUES" | jq -c '.[]' | while read -r issue; do
  IS_PR=$(echo "$issue" | jq 'has("pull_request")')
  if [ "$IS_PR" = "true" ]; then
    continue
  fi

  ISSUE_ID=$(echo "$issue" | jq -r '.id')
  ISSUE_TITLE=$(echo "$issue" | jq -r '.title')
  ISSUE_NUM=$(echo "$issue" | jq -r '.number')

  echo "  ➕ Kart ekleniyor: #${ISSUE_NUM} - ${ISSUE_TITLE}"
  curl -s -X POST \
    -H "${AUTH_HEADER}" \
    -H "${API_HEADER}" \
    -H "Content-Type: application/json" \
    "https://api.github.com/projects/columns/${TODO_COLUMN_ID}/cards" \
    -d "{\"content_id\":${ISSUE_ID},\"content_type\":\"Issue\"}" > /dev/null
done

echo ""
echo "🎉 Tüm açık issue'lar başarıyla '${PROJECT_NAME}' projesindeki 'To do' sütununa eklendi!"
echo "📌 Proje Adresi: ${PROJECT_URL}"
