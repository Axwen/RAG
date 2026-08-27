#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
compose_file="$script_dir/compose/keycloak.yml"
template_file="$script_dir/fixtures/keycloak/rag-probe-realm.json"
runtime_dir="$script_dir/runtime/keycloak"
result_dir="$repo_root/docs/engineering/probe-results"
started_by_probe=0

: "${PROBE_KEYCLOAK_ADMIN_PASSWORD:=$(openssl rand -hex 18)}"
: "${PROBE_KEYCLOAK_USER_PASSWORD:=$(openssl rand -hex 18)}"
export PROBE_KEYCLOAK_ADMIN_PASSWORD PROBE_KEYCLOAK_USER_PASSWORD

cleanup() {
  if [ "$started_by_probe" -eq 1 ]; then
    docker compose -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ -d "$runtime_dir" ]; then
    find "$runtime_dir" -mindepth 1 -delete >/dev/null 2>&1 || true
    rmdir "$runtime_dir" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for command_name in docker jq openssl python3; do
  command -v "$command_name" >/dev/null || {
    printf 'PROBE-001 BLOCKED: %s command is unavailable\n' "$command_name" >&2
    exit 1
  }
done

mkdir -p "$runtime_dir" "$result_dir"
jq --arg password "$PROBE_KEYCLOAK_USER_PASSWORD" \
  '(.users[] | select(.username == "probe-user") | .credentials) = [{type:"password",value:$password,temporary:false}]' \
  "$template_file" >"$runtime_dir/rag-probe-realm.json"

docker compose -f "$compose_file" up -d
started_by_probe=1

python3 "$script_dir/probe_001_keycloak.py" \
  --base-url "${KEYCLOAK_PROBE_URL:-http://127.0.0.1:18080}" \
  --compose-file "$compose_file" \
  --realm-template "$template_file" \
  --result-dir "$result_dir"
