#!/bin/sh
# Runs once, on the first start of an empty data volume (postgres image /docker-entrypoint-initdb.d).
# Creates the two roles of contracts section 11.3:
#   ia_owner  POSTGRES_USER, owns the schema, used only by migrations (MIGRATE_DATABASE_URL)
#   ia_app    DB_APP_ROLE, the role in the api's DATABASE_URL; owns nothing, never gets UPDATE / DELETE /
#             TRUNCATE on audit_entry or audit_checkpoint (revoked again after every migration).
# Optionally creates a database and role for Keycloak (Compose profile `sso`).
set -eu

: "${POSTGRES_USER:?}"
: "${POSTGRES_DB:?}"
: "${IA_APP_DB_PASSWORD:?IA_APP_DB_PASSWORD must be set}"
APP_ROLE="${DB_APP_ROLE:-ia_app}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_role="$APP_ROLE" -v app_pw="$IA_APP_DB_PASSWORD" -v owner="$POSTGRES_USER" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE :"app_role" LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"app_role";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app_role";
-- Tables and sequences created later by the owner (drizzle migrations) are usable by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
SQL

if [ -n "${KEYCLOAK_DB_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v kc_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'kc_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE keycloak OWNER keycloak;
SQL
fi

echo "ia: roles created (owner=$POSTGRES_USER, app=$APP_ROLE)"
