#!/usr/bin/env bash
set -u

failures=0

check_command() {
  local name="$1"
  local command_name="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    printf 'PASS %-18s %s\n' "$name" "$("$command_name" --version 2>&1 | head -1)"
  else
    printf 'FAIL %-18s command not found: %s\n' "$name" "$command_name"
    failures=$((failures + 1))
  fi
}

check_command "node" node
check_command "pnpm" pnpm
check_command "python3" python3

# python3-pip 仅供宿主探针 glue 脚本使用;DeepDOC 本体在容器内,故非硬门禁,缺失只 WARN
if python3 -m pip --version >/dev/null 2>&1; then
  printf 'PASS %-18s %s\n' "pip" "$(python3 -m pip --version 2>&1 | awk '{print $1, $2}')"
else
  printf 'WARN %-18s python3 -m pip missing (host glue only; DeepDOC runs in-container)\n' "pip"
fi
check_command "curl" curl
check_command "jq" jq

if ! command -v docker >/dev/null 2>&1; then
  printf 'FAIL %-18s Docker CE CLI not available\n' "docker"
  failures=$((failures + 1))
else
  docker_client_version=$(docker version --format '{{.Client.Version}}' 2>/dev/null || true)
  if [ -n "$docker_client_version" ]; then
    printf 'PASS %-18s Docker CE CLI %s\n' "docker" "$docker_client_version"
  else
    printf 'FAIL %-18s Docker CE CLI is not responding\n' "docker"
    failures=$((failures + 1))
  fi

  if docker info >/dev/null 2>&1; then
    docker_server_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
    printf 'PASS %-18s Docker Engine reachable%s\n' "engine" "${docker_server_version:+ ($docker_server_version)}"

    docker_mem_bytes=$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)
    if [ -n "$docker_mem_bytes" ]; then
      docker_mem_gib=$(awk -v bytes="$docker_mem_bytes" 'BEGIN { printf "%.2f", bytes / 1024 / 1024 / 1024 }')
      if awk -v gib="$docker_mem_gib" 'BEGIN { exit !(gib < 22) }'; then
        printf 'WARN %-18s Docker Engine memory %s GiB; 22 GiB daily / 24 GiB parser profile is unavailable\n' "resources" "$docker_mem_gib"
      else
        printf 'PASS %-18s Docker Engine memory %s GiB\n' "resources" "$docker_mem_gib"
      fi
    else
      printf 'WARN %-18s Docker Engine memory could not be measured\n' "resources"
    fi
  else
    printf 'FAIL %-18s Docker Engine API unreachable or permission denied\n' "engine"
    failures=$((failures + 1))
  fi
fi

if docker compose version >/dev/null 2>&1; then
  compose_version=$(docker compose version --short 2>/dev/null || true)
  printf 'PASS %-18s Compose plugin %s\n' "compose" "${compose_version:-available}"
else
  printf 'FAIL %-18s Docker Compose plugin unavailable\n' "compose"
  failures=$((failures + 1))
fi

if [ -S /var/run/docker.sock ]; then
  if docker info >/dev/null 2>&1; then
    printf 'PASS %-18s /var/run/docker.sock accessible\n' "socket"
  else
    printf 'FAIL %-18s /var/run/docker.sock exists but is not accessible\n' "socket"
    failures=$((failures + 1))
  fi
else
  printf 'FAIL %-18s /var/run/docker.sock missing\n' "socket"
  failures=$((failures + 1))
fi

if [ "$failures" -eq 0 ]; then
  printf '\nREADY: environment gate passed; architecture probes may start.\n'
  exit 0
fi

printf '\nBLOCKED: fix the failed checks before running container-based probes.\n'
exit 1
