#!/usr/bin/env bash
set -e

echo "Creating GitHub Issues from issue.md..."

# Execute commands from issue.md
bash issue.md

echo "All issues created successfully!"
