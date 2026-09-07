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

# 客户端：存在即跳过，不覆盖本地可能已调整的重定向 URI。
# rag-api 是 T14a 的服务端 OIDC 客户端（PKCE，回调 /auth/callback），与 rag-web 同一来源。
for client in "${KEYCLOAK_CLIENT_ID:-rag-web}" rag-api; do
  client_id="$(curl -sf "${auth[@]}" "${api}/${KEYCLOAK_REALM}/clients?clientId=${client}" |
    jq -r '.[0].id // empty')"
  if [[ -z "${client_id}" ]]; then
    log "补建客户端 ${client}"
    jq --arg cid "${client}" '.clients[] | select(.clientId == $cid)' "${REALM_FILE}" |
      curl -sf -X POST "${auth[@]}" -H 'content-type: application/json' \
        --data-binary @- "${api}/${KEYCLOAK_REALM}/clients" >/dev/null ||
      die "创建客户端 ${client} 失败"
  else
    log "客户端 ${client} 已存在，跳过创建"
  fi
done

# 开发用户：固定 UUID 创建——业务库种子（prisma/seed.ts 的 BusinessUser.subject）按这个
# id 预置映射，随机 id 会让「realm 用户 ↔ BusinessUser」对不上。
# 老版本脚本建的 dev 用户是随机 id：删掉重建（本地开发 realm，用户身上无可保留数据）。
DEV_USER_ID="018f0000-0000-7000-8000-00000000a001"
user_id="$(curl -sf "${auth[@]}" \
  "${api}/${KEYCLOAK_REALM}/users?username=${DEV_USER_NAME}&exact=true" | jq -r '.[0].id // empty')"
if [[ -n "${user_id}" && "${user_id}" != "${DEV_USER_ID}" ]]; then
  log "开发用户 ${DEV_USER_NAME} 的 id 不是 T14a 固定值（${user_id}），删除重建"
  curl -sf -X DELETE "${auth[@]}" "${api}/${KEYCLOAK_REALM}/users/${user_id}" >/dev/null ||
    die "删除旧开发用户失败"
  user_id=""
fi
if [[ -z "${user_id}" ]]; then
  log "创建开发用户 ${DEV_USER_NAME}（固定 id ${DEV_USER_ID}）"
  curl -sf -X POST "${auth[@]}" -H 'content-type: application/json' \
    -d "{\"id\":\"${DEV_USER_ID}\",\"username\":\"${DEV_USER_NAME}\",\"enabled\":true,\"emailVerified\":true,\"email\":\"${DEV_USER_NAME}@example.invalid\",\"firstName\":\"Dev\",\"lastName\":\"User\"}" \
    "${api}/${KEYCLOAK_REALM}/users" >/dev/null || die "创建开发用户失败"
  user_id="${DEV_USER_ID}"
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
