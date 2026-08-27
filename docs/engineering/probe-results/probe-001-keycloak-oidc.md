# PROBE-001 Keycloak/OIDC

- status: `PASS`
- issuer: `http://127.0.0.1:18080/realms/rag-probe`
- JWKS keys: `2`
- Authorization Code + PKCE: `PASS`
- JWT/JWKS claims: `PASS`
- expired token HTTP status: `401`
- revoked token HTTP status: `401`
- refresh after disable HTTP status: `400`
- revocation propagation: `70 ms`
- unavailable fail closed: `True` (userinfo HTTP `502` while Keycloak stopped)
- recovery succeeded: `True`
