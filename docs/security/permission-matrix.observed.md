# Observed permission matrix (HTTP status per role; ✓ = expected to be allowed)

| Operation | owner | editor | viewer | pending | revoked | expired | unrelated |
|---|---|---|---|---|---|---|---|
| GET /vaults/S/records | 200 ✓ | 200 ✓ | 200 ✓ | 403 | 404 | 403 | 404 |
| GET /records/:id | 200 ✓ | 200 ✓ | 200 ✓ | 403 | 404 | 403 | 404 |
| GET /records/:id/versions | 200 ✓ | 200 ✓ | 200 ✓ | 403 | 404 | 403 | 404 |
| GET /vaults/S/members | 200 ✓ | 200 ✓ | 200 ✓ | 403 | 404 | 403 | 404 |
| POST /records into S | 201 ✓ | 201 ✓ | 403 | 403 | 404 | 403 | 404 |
| PUT /records/:id | 200 ✓ | 200 ✓ | 403 | 403 | 404 | 403 | 404 |
| DELETE /records/:id | 200 ✓ | 200 ✓ | 403 | 403 | 404 | 403 | 404 |
| POST /vaults/S/members (invite) | 201 ✓ | 403 | 403 | 403 | 404 | 403 | 404 |
| PATCH /vaults/S/members/:viewer (role change) | 200 ✓ | 403 | 403 | 403 | 404 | 403 | 404 |
| DELETE /vaults/S/members/:owner (remove another member) | 409 | 403 | 403 | 403 | 404 | 403 | 404 |
| POST /vaults/S/rotate | 409 | 403 | 403 | 403 | 404 | 403 | 404 |
| PATCH /vaults/S (resharing setting) | 200 ✓ | 403 | 403 | 403 | 404 | 403 | 404 |
| DELETE /vaults/S | 204 ✓ | 403 | 403 | 403 | 404 | 403 | 404 |
