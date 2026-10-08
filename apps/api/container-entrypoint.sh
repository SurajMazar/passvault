#!/bin/sh
# Runs pending Prisma migrations (when MIGRATE_ON_START=true) and then the API.
set -eu
if [ "${MIGRATE_ON_START:-false}" = "true" ]; then
  echo "[entrypoint] applying database migrations (prisma migrate deploy)"
  ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
fi
exec "$@"
