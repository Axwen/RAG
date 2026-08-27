#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
compose_file="$script_dir/compose/opensearch.yml"
result_dir="$repo_root/docs/engineering/probe-results"
started_by_probe=0

cleanup() {
  if [ "$started_by_probe" -eq 1 ]; then
    docker compose -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for command_name in docker python3; do
  command -v "$command_name" >/dev/null || {
    printf 'PROBE-003 BLOCKED: %s command is unavailable\n' "$command_name" >&2
    exit 1
  }
done

mkdir -p "$result_dir"

docker compose -f "$compose_file" up -d
started_by_probe=1

OPENSEARCH_PROBE_URL="${OPENSEARCH_PROBE_URL:-http://127.0.0.1:19200}" \
python3 "$script_dir/probe_003_opensearch.py" \
  --compose-file "$compose_file" \
  --result-dir "$result_dir"
