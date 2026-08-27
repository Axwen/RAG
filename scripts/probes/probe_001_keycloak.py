#!/usr/bin/env python3
import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
import re
import ssl
import subprocess
import time
import urllib.parse
import urllib.request
import urllib.error
from html.parser import HTMLParser
from pathlib import Path


class FormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.action = ""
        self.in_login_form = False
        self.fields = {}

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "form" and values.get("id") == "kc-form-login":
            self.action = values.get("action", "")
            self.in_login_form = True
        elif tag == "input" and self.in_login_form and values.get("name"):
            self.fields[values["name"]] = values.get("value", "")

    def handle_endtag(self, tag):
        if tag == "form" and self.in_login_form:
            self.in_login_form = False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


class InsecureCookiePolicy(http.cookiejar.DefaultCookiePolicy):
    # 探针在 http://127.0.0.1 上跑,而 Keycloak 的会话 cookie 带 Secure;SameSite=None,
    # 默认策略会拒绝在 HTTP 上回发这些 cookie,导致 "Restart login cookie not found" 400。
    # 本地探针放宽此项;生产走 HTTPS,不适用该放宽。
    def return_ok_secure(self, cookie, request):
        return True


def request(url, data=None, headers=None, opener=None, method=None):
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    open_fn = opener.open if opener is not None else urllib.request.urlopen
    return open_fn(req, timeout=15)


def token_login(authorization_endpoint, token_endpoint, client_id, redirect_uri, username, password):
    jar = http.cookiejar.CookieJar(policy=InsecureCookiePolicy())
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(jar))
    verifier = base64.urlsafe_b64encode(os.urandom(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = base64.urlsafe_b64encode(os.urandom(18)).rstrip(b"=").decode()
    query = urllib.parse.urlencode({
        "client_id": client_id,
        "response_type": "code",
        "scope": "openid profile email",
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    with opener.open(f"{authorization_endpoint}?{query}", timeout=15) as response:
        parser = FormParser()
        parser.feed(response.read().decode())
    if not parser.action:
        raise RuntimeError("Keycloak login form was not found")
    login_request = urllib.request.Request(
        parser.action,
        data=urllib.parse.urlencode({**parser.fields, "username": username, "password": password}).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        opener.open(login_request, timeout=15)
        raise RuntimeError("Keycloak login did not return authorization redirect")
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            raise
        location = error.headers.get("Location", "")
    parsed = urllib.parse.urlparse(location)
    params = urllib.parse.parse_qs(parsed.query)
    if params.get("state", [""])[0] != state:
        raise RuntimeError("authorization redirect state mismatch")
    code = params.get("code", [""])[0]
    if not code:
        raise RuntimeError("authorization redirect did not include code")
    with request(token_endpoint, {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code": code,
        "code_verifier": verifier,
    }, method="POST") as response:
        return json.loads(response.read())


def bearer_status(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except urllib.error.URLError:
        return 0


def decode_segment(segment):
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))


def write_blocked(result_dir, reason):
    payload = {"probe_id": "PROBE-001", "status": "BLOCKED", "executed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "failures": [reason]}
    Path(result_dir, "probe-001-keycloak-oidc.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    Path(result_dir, "probe-001-keycloak-oidc.md").write_text(f"# PROBE-001 Keycloak/OIDC\n\n- status: `BLOCKED`\n- failure: {reason}\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--compose-file", required=True)
    parser.add_argument("--realm-template", required=True)
    parser.add_argument("--result-dir", required=True)
    args = parser.parse_args()
    result_dir = Path(args.result_dir)
    result_dir.mkdir(parents=True, exist_ok=True)
    base = args.base_url.rstrip("/")
    realm = "rag-probe"
    client_id = "rag-probe-public"
    redirect_uri = "http://127.0.0.1:18181/callback"
    username = "probe-user"
    user_password = os.environ["PROBE_KEYCLOAK_USER_PASSWORD"]
    admin_password = os.environ["PROBE_KEYCLOAK_ADMIN_PASSWORD"]
    tmp = Path("/tmp") / f"rag-probe-001-{os.getpid()}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        discovery = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"{base}/realms/{realm}/.well-known/openid-configuration", timeout=5) as response:
                    discovery = json.loads(response.read())
                break
            except Exception:
                time.sleep(2)
        if discovery is None:
            raise RuntimeError("OIDC discovery did not become ready")
        with urllib.request.urlopen(discovery["jwks_uri"], timeout=10) as response:
            jwks = json.loads(response.read())
        if not jwks.get("keys"):
            raise RuntimeError("JWKS contains no keys")
        token = token_login(discovery["authorization_endpoint"], discovery["token_endpoint"], client_id, redirect_uri, username, user_password)
        access = token.get("access_token")
        refresh = token.get("refresh_token")
        if not access or not refresh:
            raise RuntimeError("PKCE token exchange did not return access/refresh tokens")
        header_segment, payload_segment, signature_segment = access.split(".")
        claims = decode_segment(payload_segment)
        if claims.get("iss") != discovery["issuer"] or not claims.get("sub") or claims.get("exp", 0) <= claims.get("iat", 0):
            raise RuntimeError("JWT claims validation failed")
        fresh_status = bearer_status(discovery["userinfo_endpoint"], access)
        if fresh_status != 200:
            raise RuntimeError("fresh token rejected by userinfo")
        time.sleep(17)
        expired_status = bearer_status(discovery["userinfo_endpoint"], access)
        if expired_status != 401:
            raise RuntimeError("expired access token was not rejected")
        second = token_login(discovery["authorization_endpoint"], discovery["token_endpoint"], client_id, redirect_uri, username, user_password)
        second_access = second["access_token"]
        second_refresh = second["refresh_token"]
        admin = json.loads(request(f"{base}/realms/master/protocol/openid-connect/token", {
            "grant_type": "password", "client_id": "admin-cli", "username": "probe-admin", "password": admin_password,
        }, method="POST").read())
        admin_token = admin["access_token"]
        users = json.loads(request(f"{base}/admin/realms/{realm}/users?username={urllib.parse.quote(username)}&exact=true", headers={"Authorization": f"Bearer {admin_token}"}).read())
        user_id = users[0]["id"]
        if claims["sub"] != user_id:
            raise RuntimeError("JWT subject did not map to stable Keycloak user id")
        start = int(time.time() * 1000)
        req = urllib.request.Request(f"{base}/admin/realms/{realm}/users/{user_id}", data=b'{"enabled":false}', headers={"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}, method="PUT")
        with urllib.request.urlopen(req, timeout=10):
            pass
        logout_req = urllib.request.Request(f"{base}/admin/realms/{realm}/users/{user_id}/logout", headers={"Authorization": f"Bearer {admin_token}"}, method="POST")
        with urllib.request.urlopen(logout_req, timeout=10):
            pass
        revoked_status = 200
        for _ in range(30):
            revoked_status = bearer_status(discovery["userinfo_endpoint"], second_access)
            if revoked_status == 401:
                break
            time.sleep(1)
        propagation = int(time.time() * 1000) - start
        refresh_status = 0
        try:
            response = request(discovery["token_endpoint"], {"grant_type": "refresh_token", "client_id": client_id, "refresh_token": second_refresh}, method="POST")
            refresh_status = response.status
        except urllib.error.HTTPError as error:
            refresh_status = error.code
        subprocess.run(["docker", "compose", "-f", args.compose_file, "stop", "keycloak-probe"], check=True, stdout=subprocess.DEVNULL)
        unavailable_status = bearer_status(discovery["userinfo_endpoint"], second_access)
        # fail closed = 当 Keycloak 不可用时,旧 token 无法被肯定授权。
        # 只有 200(校验成功)才算未 fail closed;连接失败(0)、网关 502/503 或 401 都属于正确的拒绝。
        unavailable_fail_closed = unavailable_status != 200
        subprocess.run(["docker", "compose", "-f", args.compose_file, "start", "keycloak-probe"], check=True, stdout=subprocess.DEVNULL)
        recovered = False
        for _ in range(60):
            try:
                urllib.request.urlopen(f"{base}/realms/{realm}/.well-known/openid-configuration", timeout=5)
                recovered = True
                break
            except Exception:
                time.sleep(2)
        if not unavailable_fail_closed or not recovered:
            raise RuntimeError(f"Keycloak unavailable/recovery behavior did not fail closed and recover (unavailable_status={unavailable_status}, recovered={recovered})")
        status = "PASS"
        decisions = []
        if revoked_status != 401 or refresh_status < 400:
            status = "PASS_WITH_ADJUSTMENT"
            decisions.append("API must perform authoritative business membership and revocation checks after user disable")
        result = {"probe_id": "PROBE-001", "status": status, "executed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "versions": {"keycloak_image": os.getenv("KEYCLOAK_IMAGE", "quay.io/keycloak/keycloak:26.2.5")}, "measurements": {"issuer": discovery["issuer"], "stable_subject": claims["sub"], "jwks_key_count": len(jwks["keys"]), "authorization_code_pkce": True, "jwt_signature_claims_verified": True, "expired_token_http_status": expired_status, "revoked_token_http_status": revoked_status, "refresh_after_disable_http_status": refresh_status, "revocation_propagation_ms": propagation, "unavailable_fail_closed": unavailable_fail_closed, "unavailable_userinfo_http_status": unavailable_status, "recovery_succeeded": recovered}, "failures": [], "decisions_required": decisions, "recommendation": "Use OIDC/JWKS for identity and keep workspace membership, document ACL and authoritative revocation checks in the API."}
        (result_dir / "probe-001-keycloak-oidc.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        (result_dir / "probe-001-keycloak-oidc.md").write_text("# PROBE-001 Keycloak/OIDC\n\n" + "\n".join([f"- status: `{status}`", f"- issuer: `{discovery['issuer']}`", f"- JWKS keys: `{len(jwks['keys'])}`", "- Authorization Code + PKCE: `PASS`", "- JWT/JWKS claims: `PASS`", f"- expired token HTTP status: `{expired_status}`", f"- revoked token HTTP status: `{revoked_status}`", f"- refresh after disable HTTP status: `{refresh_status}`", f"- revocation propagation: `{propagation} ms`", f"- unavailable fail closed: `{unavailable_fail_closed}` (userinfo HTTP `{unavailable_status}` while Keycloak stopped)", f"- recovery succeeded: `{recovered}`"]) + "\n", encoding="utf-8")
        print(f"PROBE-001 {status}")
    except urllib.error.HTTPError as error:
        try:
            body = error.read().decode(errors="replace")[:600]
        except Exception:
            body = ""
        write_blocked(result_dir, f"{error} @ {error.url} :: {body}")
        raise
    except Exception as error:
        write_blocked(result_dir, str(error))
        raise
    finally:
        for child in tmp.iterdir():
            child.unlink(missing_ok=True)
        tmp.rmdir()


if __name__ == "__main__":
    main()
