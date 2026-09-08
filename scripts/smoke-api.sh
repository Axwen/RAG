#!/usr/bin/env bash
# API 真实链路冒烟 + 日志检测。
#
# 为什么要有：单测直接 new 领域服务、绕过 NestJS DI，抓不到"进程起来了但每个请求都
# 500"这类回归（T0 遗留缺陷正是这样溜过去的）。这个脚本用编译产物真起进程、打真实
# HTTP、再对进程输出做日志断言，是 CI 里唯一覆盖"跑起来对不对"的一环。
#
# 四类断言：
#   1. HTTP 契约：T1a 领域端点的状态码、错误信封五字段、内容寻址幂等；
#      T14b 起领域端点受 IdentityGuard 保护——先走 OIDC 登录拿会话 cookie，
#      无会话请求必须 401，请求体 tenantId 已退场
#   2. 日志结构：每行都是 JSON、带 level/time/service，框架日志也走 pino
#      （响应体与日志行共享 trace_id 由 apps/api/test/global-exception-filter.test.ts 断言，
#       冒烟里无法在不加故障注入路由的前提下触发 500）
#   3. 日志泄漏：.env 里的真实口令与模型密钥不得出现在进程输出里（ADR-0032 / 脱敏默认值）
#
# 前置：pnpm run infra:up && pnpm run bootstrap && pnpm run build
# 用法：bash scripts/smoke-api.sh
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

OUT_DIR="${ROOT}/.smoke"
API_LOG="${OUT_DIR}/api.log"
TMP="${OUT_DIR}/tmp"
rm -rf "${OUT_DIR}"
mkdir -p "${TMP}"

API_PID=""
cleanup() {
  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" 2>/dev/null; then
    # setsid 起的进程自成进程组，负号杀整组，避免留下 node 子进程占端口
    kill -TERM -"${API_PID}" 2>/dev/null || true
    wait "${API_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

failures=0
pass() { printf '  ✅ %s\n' "$1"; }
fail() {
  printf '  ❌ %s\n' "$1" >&2
  failures=$((failures + 1))
}

# ── 端口与 .env ────────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "❌ 缺少 .env（cp .env.example .env 后再跑）" >&2
  exit 2
fi
API_PORT="$(sed -nE 's/^API_PORT=([0-9]+).*/\1/p' .env | tail -1)"
API_PORT="${API_PORT:-3001}"
BASE="http://127.0.0.1:${API_PORT}"

# ── 启动编译产物 ──────────────────────────────────────────────────────────────
if [[ ! -f apps/api/dist/main.js ]]; then
  echo "❌ 缺少 apps/api/dist/main.js（先跑 pnpm run build）" >&2
  exit 2
fi

echo "▶ 启动 API（编译产物，dist/main.js）"
# 不预置任何依赖变量：API 自己 preloadRootEnv() 读根 .env（DX-T1），这里顺带验证它还成立
setsid node apps/api/dist/main.js >"${API_LOG}" 2>&1 </dev/null &
API_PID=$!

ready=0
for _ in $(seq 1 60); do
  if [[ "$(curl -fsS -o /dev/null -w '%{http_code}' "${BASE}/health/ready" 2>/dev/null || true)" == "200" ]]; then
    ready=1
    break
  fi
  if ! kill -0 "${API_PID}" 2>/dev/null; then
    echo "❌ API 进程已退出，日志尾部：" >&2
    tail -n 30 "${API_LOG}" >&2
    exit 1
  fi
  sleep 1
done
if [[ "${ready}" -ne 1 ]]; then
  echo "❌ 60s 内 /health/ready 未返回 200（六项依赖未全部 up）；日志尾部：" >&2
  tail -n 30 "${API_LOG}" >&2
  exit 1
fi
pass "/health/ready 200（六项依赖全 up，且未手工 source .env）"

# ── HTTP 辅助 ─────────────────────────────────────────────────────────────────
STATUS=""
BODY="${TMP}/body.json"
req() {
  local method="$1" path="$2" data="${3-}" ; shift 3 || shift $#
  local args=(-sS -X "${method}" -o "${BODY}" -w '%{http_code}' "${BASE}${path}")
  if [[ -n "${data}" ]]; then
    args+=(-H 'content-type: application/json' --data-binary "${data}")
  fi
  args+=("$@")
  STATUS="$(curl "${args[@]}" || echo 000)"
}
jget() { python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[k] if isinstance(d, dict) and k in d else None
    if d is None: break
print("" if d is None else d)
' "${BODY}" "$1"; }
expect() {
  local what="$1" got="$2" want="$3"
  if [[ "${got}" == "${want}" ]]; then pass "${what}"; else fail "${what}（期望 ${want}，实得 ${got}）"; fi
}

# ── 0. 会话：OIDC 登录拿 cookie（T14b 起 manifests 全部受保护） ──────────────
echo "▶ 会话（OIDC 授权码 + PKCE，devuser）"

# 无会话先验一条：领域端点必须 401 信封（守卫在 HTTP 层的证据）。
# 用裸 curl：带会话 cookie 的 req() 要等登录完成后才定义。
NOSESSION_STATUS="$(curl -sS -X POST -o "${BODY}" -w '%{http_code}' \
  -H 'content-type: application/json' --data-binary '{"version": 1}' \
  "${BASE}/manifests/ingestion" || echo 000)"
expect "无会话请求领域端点 -> 401" "${NOSESSION_STATUS}" 401
expect "无会话错误码 UNAUTHORIZED" "$(jget code)" UNAUTHORIZED

# 走 API 的 /auth/login：PKCE 的 verifier/challenge 由 API 生成并种在自己的
# pkce cookie 里——脚本不自己碰 PKCE，模拟的就是浏览器行为。
#   /auth/login（API_JAR 收 pkce cookie）→ Keycloak 登录表单 → POST 凭据
#   → 302 带 code → /auth/callback（携 pkce cookie）→ 会话 cookie 落 API_JAR
DEV_USER_NAME="$(sed -nE 's/^DEV_USER_NAME=(.+)$/\1/p' .env | tail -1)"
DEV_USER_NAME="${DEV_USER_NAME:-dev}"
DEV_USER_PASSWORD="$(sed -nE 's/^DEV_USER_PASSWORD=(.+)$/\1/p' .env | tail -1)"

KC_JAR="${TMP}/kc-jar.txt"
API_JAR="${TMP}/api-jar.txt"
LOGIN_HTML="${TMP}/kc-login.html"

AUTHORIZE_URL="$(curl -sS -c "${API_JAR}" --max-time 15 -o /dev/null -w '%{redirect_url}' "${BASE}/auth/login")"
if [[ "${AUTHORIZE_URL}" != *"protocol/openid-connect/auth"* ]]; then
  echo "❌ /auth/login 未重定向到 Keycloak（实得 ${AUTHORIZE_URL:0:120}）" >&2
  exit 1
fi
pass "/auth/login 302 到 Keycloak authorize"

curl -sS -c "${KC_JAR}" --max-time 15 "${AUTHORIZE_URL}" -o "${LOGIN_HTML}"
LOGIN_ACTION="$(python3 -c '
import html, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"action=\"([^\"]+)\"", text)
print(html.unescape(m.group(1)) if m else "")
' "${LOGIN_HTML}")"
if [[ -z "${LOGIN_ACTION}" ]]; then
  echo "❌ Keycloak 登录页解析失败（authorize 页无 form action）" >&2
  exit 1
fi

CALLBACK_LOCATION="$(curl -sS -b "${KC_JAR}" -c "${KC_JAR}" --max-time 15 -o /dev/null -w '%{redirect_url}' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "username=${DEV_USER_NAME}" \
  --data-urlencode "password=${DEV_USER_PASSWORD}" \
  --data-urlencode 'credentialId=' \
  "${LOGIN_ACTION}")"
CALLBACK_CODE="$(python3 -c '
import sys, urllib.parse
q = urllib.parse.urlparse(sys.argv[1]).query
print(urllib.parse.parse_qs(q).get("code", [""])[0])
' "${CALLBACK_LOCATION}")"
if [[ -z "${CALLBACK_CODE}" ]]; then
  echo "❌ 授权码获取失败（location=${CALLBACK_LOCATION:0:120}）" >&2
  exit 1
fi

CB1_STATUS="$(curl -sS -b "${API_JAR}" -c "${API_JAR}" -o "${BODY}" -w '%{http_code}' \
  "${BASE}/auth/callback?code=${CALLBACK_CODE}" || echo 000)"
expect "OIDC 回调 -> 200 会话视图" "${CB1_STATUS}" 200
if python3 -c "import json,sys; sys.exit(0 if 'workspaces' in json.load(open('${BODY}')) else 1)"; then
  pass "会话视图含 Workspace 投影"
else
  fail "会话视图缺少 Workspace 投影"
fi
if python3 -c "import json,sys; sys.exit(0 if 'issuer' not in json.load(open('${BODY}')) else 1)"; then
  pass "会话视图不外发 issuer/subject"
else
  fail "会话视图泄漏 issuer/subject"
fi

# req() 已消费 code（一次性）。再走一遍完整 login 流程，把会话 cookie 落进
# API_JAR 供后续领域请求使用——second pass 的 code 是新的，合法。
AUTHORIZE_URL2="$(curl -sS -c "${API_JAR}" --max-time 15 -o /dev/null -w '%{redirect_url}' "${BASE}/auth/login")"
curl -sS -c "${KC_JAR}" --max-time 15 "${AUTHORIZE_URL2}" -o "${LOGIN_HTML}"
LOGIN_ACTION2="$(python3 -c '
import html, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"action=\"([^\"]+)\"", text)
print(html.unescape(m.group(1)) if m else "")
' "${LOGIN_HTML}")"
CALLBACK_LOCATION2="$(curl -sS -b "${KC_JAR}" -c "${KC_JAR}" --max-time 15 -o /dev/null -w '%{redirect_url}' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "username=${DEV_USER_NAME}" \
  --data-urlencode "password=${DEV_USER_PASSWORD}" \
  --data-urlencode 'credentialId=' \
  "${LOGIN_ACTION2}")"
CALLBACK_CODE2="$(python3 -c '
import sys, urllib.parse
q = urllib.parse.urlparse(sys.argv[1]).query
print(urllib.parse.parse_qs(q).get("code", [""])[0])
' "${CALLBACK_LOCATION2}")"
CB_STATUS="$(curl -sS -c "${API_JAR}" --max-time 15 -o /dev/null -w '%{http_code}' \
  "${BASE}/auth/callback?code=${CALLBACK_CODE2}")"
expect "第二次回调（取会话 cookie）-> 200" "${CB_STATUS}" 200

# req() 从此带上会话 cookie（登录完成，覆盖前面的无 cookie 定义）
req() {
  local method="$1" path="$2" data="${3-}" ; shift 3 || shift $#
  local args=(-sS -X "${method}" -o "${BODY}" -w '%{http_code}' -b "${API_JAR}" "${BASE}${path}")
  if [[ -n "${data}" ]]; then
    args+=(-H 'content-type: application/json' --data-binary "${data}")
  fi
  args+=("$@")
  STATUS="$(curl "${args[@]}" || echo 000)"
}

# 会话自检：领域请求从此可用
req GET /auth/session ''
expect "GET /auth/session -> 200" "${STATUS}" 200
expect "会话视图租户管理员" "$(python3 -c "import json; print(json.load(open('${BODY}'))['tenants'][0]['tenantRoleCode'])")" tenant-admin

# ── 1. HTTP 契约断言 ─────────────────────────────────────────────────────────
echo "▶ HTTP 契约"

STAMP="$(date +%s)"

# 内容寻址幂等：同一份 body 两次写入必须拿到同一个 id
ING_BODY="$(python3 -c '
import json, sys
print(json.dumps({
  "version": int(sys.argv[2]) % 2000000000,
  "parserRef": "deepdoc@1.0.0",
  "chunkerRef": "wide-1024@1.0.0",
  "embeddingRef": "qwen3-embedding-8b@1.0.0",
  "indexSchemaRef": "rag-chunk@1.0.0",
  "parseBackend": "deepdoc",
  "sourceFormats": ["pdf", "md"],
}))' "${STAMP}")"

req POST /manifests/ingestion "${ING_BODY}"
expect "POST /manifests/ingestion -> 201" "${STATUS}" 201
ING_ID="$(jget id)"
ING_STATUS="$(jget status)"
expect "新建 Manifest 初始态 DRAFT" "${ING_STATUS}" DRAFT
expect "租户来自服务端身份（种子租户）" "$(jget tenantId)" '018f0000-0000-7000-8000-000000000001'

req POST /manifests/ingestion "${ING_BODY}"
ING_ID_2="$(jget id)"
expect "同 body 重放返回同一 id（(tenantId, contentHash) 幂等）" "${ING_ID_2}" "${ING_ID}"

req POST "/manifests/ingestion/${ING_ID}/approve" ''
expect "approve -> 200" "${STATUS}" 200
expect "approve 后 status=APPROVED" "$(jget status)" APPROVED

req POST "/manifests/ingestion/${ING_ID}/approve" ''
expect "重复 approve 幂等 200（不是 500 check_violation）" "${STATUS}" 200

# 错误信封：五字段 + param 定位
req POST /manifests/retrieval "$(python3 -c '
import json, sys
print(json.dumps({
  "version": 1,
  "sparsePolicy": {"bm25": True},
  "vectorPolicy": {"channels": [{"name": "dense", "embeddingRef": "e@1.0.0", "dimension": 1024}]},
  "fusionPolicy": {"rrf": True}, "rerankerRef": "r@1.0.0",
  "candidateBudget": 2048,
}))')"
expect "candidateBudget=2048 -> 400" "${STATUS}" 400
expect "错误码 VALIDATION_ERROR" "$(jget code)" VALIDATION_ERROR
expect "param 指向 candidateBudget" "$(jget param)" candidateBudget
for f in code message param doc_url trace_id; do
  if python3 -c "import json,sys; sys.exit(0 if '$f' in json.load(open('${BODY}')) else 1)"; then
    pass "信封含字段 ${f}"
  else
    fail "信封缺字段 ${f}"
  fi
done

req GET /releases/018f0000-0000-7000-8000-0000000000ff ''
expect "GET 不存在的 Release -> 404" "${STATUS}" 404
expect "错误码 NOT_FOUND" "$(jget code)" NOT_FOUND

req GET /this-route-does-not-exist ''
expect "未定义路由 -> 404" "${STATUS}" 404
expect "未定义路由走信封而非 Nest 默认" "$(jget code)" NOT_FOUND

req POST /manifests/ingestion '{"version": "oops"'
expect "畸形 JSON -> 400" "${STATUS}" 400
expect "畸形 JSON 走信封" "$(jget code)" VALIDATION_ERROR

# trace_id 只复用严格校验过的 W3C traceparent
TRACE_ID='4bf92f3577b34da6a3ce929d0e0e4736'
req GET /releases/018f0000-0000-7000-8000-0000000000ff '' \
  -H "traceparent: 00-${TRACE_ID}-00f067aa0ba902b7-01"
expect "合法 traceparent 时 trace_id 复用其 trace-id" "$(jget trace_id)" "${TRACE_ID}"

req GET /releases/018f0000-0000-7000-8000-0000000000ff '' -H 'traceparent: NOT-A-TRACEPARENT'
BAD_TRACE="$(jget trace_id)"
if [[ "${BAD_TRACE}" != "NOT-A-TRACEPARENT" && -n "${BAD_TRACE}" ]]; then
  pass "非法 traceparent 不回显，服务端生成 trace_id"
else
  fail "非法 traceparent 被回显或 trace_id 为空（实得 '${BAD_TRACE}'）"
fi

# 响应体不得携带堆栈
if grep -qE '"stack"|at [A-Za-z0-9_$.]+ \(' "${BODY}"; then
  fail "错误响应体疑似包含堆栈"
else
  pass "错误响应体不含堆栈"
fi

# ── 2. 日志结构断言 ──────────────────────────────────────────────────────────
echo "▶ 日志结构"

# 优雅停机后再判日志：先让缓冲刷完，否则最后几行可能截断
kill -TERM -"${API_PID}" 2>/dev/null || true
wait "${API_PID}" 2>/dev/null || true
API_PID=""

LOG_LINES="$(grep -c '' "${API_LOG}" || true)"
if [[ "${LOG_LINES}" -lt 1 ]]; then
  fail "进程输出为空（日志采集会拿不到任何东西）"
else
  pass "进程输出 ${LOG_LINES} 行"
fi

# 每行都必须是结构化 JSON 且带 level/time/service。
# 例外只允许 Node 运行时自身的告警（它写 stderr、不经我们的 logger），且必须显式列出。
python3 - "${API_LOG}" >"${TMP}/log-report.txt" <<'PY'
import json, re, sys

# Node/V8 自身的告警不经过应用 logger，无法结构化；只放行这几类，其余非 JSON 行即失败
NOISE = re.compile(r'^(\(node:\d+\)|Warning:|\s+at |\(Use `node )')

bad, missing, nest_lines, listening = [], [], 0, False
with open(sys.argv[1], encoding='utf-8', errors='replace') as fh:
    for n, raw in enumerate(fh, 1):
        line = raw.rstrip('\n')
        if line.strip() == '':
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            if not NOISE.match(line):
                bad.append((n, line[:160]))
            continue
        if not isinstance(rec, dict):
            bad.append((n, line[:160])); continue
        absent = [k for k in ('level', 'time', 'service') if k not in rec]
        if absent:
            missing.append((n, ','.join(absent), line[:120]))
        if rec.get('service') != 'api':
            missing.append((n, 'service!=api', line[:120]))
        if rec.get('nest') is True:
            nest_lines += 1
        if rec.get('msg') == 'api listening':
            listening = True

print(f'BAD={len(bad)}')
print(f'MISSING={len(missing)}')
print(f'NEST={nest_lines}')
print(f'LISTENING={"1" if listening else "0"}')
for n, line in bad[:5]:
    print(f'  非 JSON 行 {n}: {line}')
for n, keys, line in missing[:5]:
    print(f'  字段缺失 {n} [{keys}]: {line}')
PY
cat "${TMP}/log-report.txt" | grep -E '^  ' || true
r() { sed -nE "s/^$1=(.*)/\1/p" "${TMP}/log-report.txt"; }

expect "无非结构化日志行（Nest 框架日志已接入 pino）" "$(r BAD)" 0
expect "每行 JSON 均带 level/time/service=api" "$(r MISSING)" 0
expect "启动日志含 'api listening'" "$(r LISTENING)" 1
if [[ "$(r NEST)" -gt 0 ]]; then
  pass "框架日志走 pino（nest:true 共 $(r NEST) 行）"
else
  fail "未见 nest:true 行——app.useLogger() 可能被移除，框架日志会绕过 redact"
fi

# ── 3. 日志泄漏断言 ─────────────────────────────────────────────────────────
echo "▶ 日志泄漏"

# 逐个变量从 .env 取值：不 source、不进本脚本环境，也绝不打印值本身
env_value() { sed -nE "s/^$1=(.*)\$/\\1/p" .env | tail -1 | sed -E 's/^"(.*)"$/\\1/; s/^'"'"'(.*)'"'"'$/\\1/'; }

leaked=""
for name in POSTGRES_PASSWORD RABBITMQ_PASSWORD MINIO_ROOT_PASSWORD \
            KEYCLOAK_ADMIN_PASSWORD DEV_USER_PASSWORD \
            OPENROUTER_API_KEY FLUXIONAI_API_KEY; do
  value="$(env_value "${name}")"
  # 过短的占位值（如 "x"）会误报，跳过
  if [[ -z "${value}" || "${#value}" -lt 8 ]]; then
    continue
  fi
  if grep -qF -- "${value}" "${API_LOG}"; then
    leaked="${leaked}${name} "
  fi
done

if [[ -z "${leaked}" ]]; then
  pass "进程输出不含 .env 中的口令与模型密钥"
else
  fail "以下变量的值出现在进程输出里：${leaked}"
fi

# 连接串里的口令同样不能出现（DATABASE_URL 常被整串打进日志）
db_pw="$(sed -nE 's#^DATABASE_URL=.*://[^:]+:([^@]+)@.*#\1#p' .env | tail -1)"
if [[ -n "${db_pw}" && "${#db_pw}" -ge 4 ]]; then
  if grep -qF -- "${db_pw}" "${API_LOG}"; then
    fail "DATABASE_URL 的口令出现在进程输出里"
  else
    pass "DATABASE_URL 的口令未出现在进程输出里"
  fi
fi

# ── 结论 ─────────────────────────────────────────────────────────────────────
echo
if [[ "${failures}" -eq 0 ]]; then
  echo "✅ 冒烟通过（HTTP 契约 + 日志结构 + 日志泄漏）"
  echo "   进程日志：${API_LOG}"
  exit 0
fi
echo "❌ 冒烟失败：${failures} 项" >&2
echo "   进程日志：${API_LOG}" >&2
exit 1
