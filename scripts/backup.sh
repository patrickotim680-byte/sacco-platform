#!/usr/bin/env bash
# Database + document backup. Usage: DATABASE_URL=... STORAGE_DIR=... ./scripts/backup.sh [output-dir]
# Encrypt the output (e.g. gpg --symmetric) and copy it off-site. Test restores regularly.
set -euo pipefail
OUT="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
pg_dump --no-owner --format=custom --file "$OUT/db-$STAMP.dump" "${DATABASE_URL:?DATABASE_URL is required}"
if [ -d "${STORAGE_DIR:-.storage}" ]; then tar -czf "$OUT/documents-$STAMP.tar.gz" "${STORAGE_DIR:-.storage}"; fi
echo "Backup written to $OUT ($STAMP)"
# Restore:  pg_restore --clean --no-owner -d "$DATABASE_URL" db-<stamp>.dump   (then start the app to re-apply triggers)
