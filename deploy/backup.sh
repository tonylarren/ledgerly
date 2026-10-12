#!/usr/bin/env bash
# Nightly backup: a consistent snapshot of the live database (safe while Ledgerly runs),
# compressed into ./backups and kept for KEEP_DAYS days. Run from cron as root.
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y-%m-%d_%H%M)"
TMP="snapshot-$STAMP.db"
mkdir -p backups

docker compose -f docker-compose.prod.yml exec -T ledgerly node --disable-warning=ExperimentalWarning -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/ledgerly.db').exec(\"VACUUM INTO '/data/$TMP'\");
"
mv "data/$TMP" "backups/ledgerly-$STAMP.db"
gzip -f "backups/ledgerly-$STAMP.db"
find backups -name 'ledgerly-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: backups/ledgerly-$STAMP.db.gz ($(du -h "backups/ledgerly-$STAMP.db.gz" | cut -f1))"
