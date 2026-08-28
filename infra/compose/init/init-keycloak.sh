#!/usr/bin/env bash
# 幂等导入 Keycloak Realm 与本地开发用户。
#
# 不用 --import-realm：那只在 Realm 不存在时生效，且失败静默。这里走 Admin REST API，
# 存在则跳过创建、只对齐可重复对齐的部分，并总是重置开发用户口令。
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_env
require_env KEYCLOAK_ADMIN KEYCLOAK_ADMIN_PASSWORD KEYCLOAK_REALM DEV_USER_PASSWORD
: "${KEYCLOAK_BASE_URL:=http://localhost:8080}"
: "${DEV_USER_NAME:=dev}"

REALM_FILE="${COMPOSE_DIR}/keycloak/realm-${KEYCLOAK_REALM}.json"
[[ -f "${REALM_FILE}" ]] || die "缺少 Realm 定义 ${REALM_FILE}"

kc_token() {
  curl -sf -X POST \
    "${KEYCLOAK_BASE_URL}/realms/master/protocol/openid-connect/token" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=password' \
    --data-urlencode 'client_id=admin-cli' \
    --data-urlencode "username=${KEYCLOAK_ADMIN}" \
    --data-urlencode "password=${KEYCLOAK_ADMIN_PASSWORD}" |
    jq -r '.access_token'
}

wait_for "Keycloak Admin API" 30 curl -sf "${KEYCLOAK_BASE_URL}/realms/master"
TOKEN="$(kc_token)"
[[ -n "${TOKEN}" && "${TOKEN}" != "null" ]] || die "无法获取 Keycloak 管理令牌；检查 KEYCLOAK_ADMIN/KEYCLOAK_ADMIN_PASSWORD"

auth=(-H "authorization: Bearer ${TOKEN}")
api="${KEYCLOAK_BASE_URL}/admin/realms"

realm_status="$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "${api}/${KEYCLOAK_REALM}")"
if [[ "${realm_status}" == "200" ]]; then
  log "Realm ${KEYCLOAK_REALM} 已存在，跳过创建"
else
  log "创建 Realm ${KEYCLOAK_REALM}"
  curl -sf -X POST "${auth[@]}" -H 'content-type: application/json' \
    --data-binary "@${REALM_FILE}" "${api}" >/dev/null ||
    die "创建 Realm 失败"
fi

# 客户端：存在即跳过，不覆盖本地可能已调整的重定向 URI
client_id="$(curl -sf "${auth[@]}" "${api}/${KEYCLOAK_REALM}/clients?clientId=${KEYCLOAK_CLIENT_ID:-rag-web}" |
  jq -r '.[0].id // empty')"
if [[ -z "${client_id}" ]]; then
  log "补建客户端 ${KEYCLOAK_CLIENT_ID:-rag-web}"
  jq --arg cid "${KEYCLOAK_CLIENT_ID:-rag-web}" '.clients[] | select(.clientId == $cid)' "${REALM_FILE}" |
    curl -sf -X POST "${auth[@]}" -H 'content-type: application/json' \
      --data-binary @- "${api}/${KEYCLOAK_REALM}/clients" >/dev/null ||
    die "创建客户端失败"
else
  log "客户端 ${KEYCLOAK_CLIENT_ID:-rag-web} 已存在，跳过创建"
fi

# 开发用户：存在即复用，口令每次重置，保证脚本可重复执行后状态一致
user_id="$(curl -sf "${auth[@]}" \
  "${api}/${KEYCLOAK_REALM}/users?username=${DEV_USER_NAME}&exact=true" | jq -r '.[0].id // empty')"
if [[ -z "${user_id}" ]]; then
  log "创建开发用户 ${DEV_USER_NAME}"
  curl -sf -X POST "${auth[@]}" -H 'content-type: application/json' \
    -d "{\"username\":\"${DEV_USER_NAME}\",\"enabled\":true,\"emailVerified\":true,\"email\":\"${DEV_USER_NAME}@example.invalid\",\"firstName\":\"Dev\",\"lastName\":\"User\"}" \
    "${api}/${KEYCLOAK_REALM}/users" >/dev/null || die "创建开发用户失败"
  user_id="$(curl -sf "${auth[@]}" \
    "${api}/${KEYCLOAK_REALM}/users?username=${DEV_USER_NAME}&exact=true" | jq -r '.[0].id')"
else
  log "开发用户 ${DEV_USER_NAME} 已存在，复用"
fi

curl -sf -X PUT "${auth[@]}" -H 'content-type: application/json' \
  -d "{\"type\":\"password\",\"temporary\":false,\"value\":\"${DEV_USER_PASSWORD}\"}" \
  "${api}/${KEYCLOAK_REALM}/users/${user_id}/reset-password" >/dev/null ||
  die "重置开发用户口令失败"

# 角色映射：先查已有映射，只补差集，重复执行不产生重复项
available="$(curl -sf "${auth[@]}" \
  "${api}/${KEYCLOAK_REALM}/users/${user_id}/role-mappings/realm/available")"
to_add="$(jq -c '[.[] | select(.name | startswith("knowledge-") or . == "platform-admin")]' <<<"${available}")"
if [[ "${to_add}" != "[]" ]]; then
  log "为 ${DEV_USER_NAME} 补齐 Realm 角色"
  curl -sf -X POST "${auth[@]}" -H 'content-type: application/json' -d "${to_add}" \
    "${api}/${KEYCLOAK_REALM}/users/${user_id}/role-mappings/realm" >/dev/null ||
    die "分配角色失败"
else
  log "开发用户角色已齐备，跳过"
fi

log "Keycloak 初始化完成：realm=${KEYCLOAK_REALM} user=${DEV_USER_NAME}"
