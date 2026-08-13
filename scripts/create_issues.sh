#!/usr/bin/env bash
set -e

echo "Ensuring required labels exist in repository..."

LABELS=(
  "security"
  "high-priority"
  "medium-priority"
  "low-priority"
  "refactoring"
  "backend-integration"
  "feature"
  "infrastructure"
  "ai"
)

for label in "${LABELS[@]}"; do
  echo "Checking label: $label"
  gh label create "$label" --force 2>/dev/null || true
done

echo "Creating GitHub Issues from issue.md..."

# Execute commands from issue.md
bash issue.md

echo "All issues created successfully!"
