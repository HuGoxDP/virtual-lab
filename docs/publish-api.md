# Publish API — what the editor (B7) uses

The contract for a personal publish key: how to check one, what it owns, how it creates and
updates a scenario, and what each answer means. Written for the editor's Publish dialog, but
it is the whole key surface a client sees — the admin-only routes (issue, list, rotate,
revoke, approve, reject, accept, restore, transfer, storage) are **not** here: they belong to
`/admin`, not to an author.

Every example below is the real output of `curl` against the composed stack
(`http://127.0.0.1:8044`, backend `1.0.0`), run on 2026-11-12. The demo key and the demo
scenario were deleted and the key revoked afterwards, which is why a second run gets a
different id, token and sha256.

## 1. The key

`vlk_` + 32 random bytes, base64url — 43 characters after the prefix
(`/^vlk_[A-Za-z0-9_-]{43}$/`). The prefix makes a leaked key findable by a secret scan and a
log grep, which is the point of it.

A moderator shows the key **once**, in the body of the issue or rotate response, and the
backend keeps only its SHA-256 (`publish_keys.token_hash`, UNIQUE). There is no "show it
again", and no route that returns it later.

Keys issued before B6 carry no prefix. They keep working: the stored value is a SHA-256
whatever the token looked like, and the lookup is by that digest.

**Keep the key for the tab's lifetime; do not store it.** The admin UI keeps it in
`sessionStorage` only, and a key in `localStorage` survives a machine being shared. A key is
a credential that can write to the catalog in the teacher's name; treat it like a password.

## 2. Authorization

`Authorization: Bearer <key>` on every call, **over HTTPS**. With `REQUIRE_HTTPS` on (the
https compose override, and production), a credential that arrives in the clear is refused
before it is looked up — the answer is `403 {"error":"Потрібне HTTPS-з’єднання","code":"https_required"}`
(the shape, not a capture: the stack this document was run against has the switch off;
`backend/test/integration/https-required.test.js` pins it, 8 assertions, including that the
refusal never counts against the failed-auth limit).

Answers, in the order a client should expect them:

| status | meaning | what to show the user |
|---|---|---|
| 401 | no credential presented | "sign in first" |
| 403 | a credential that is unknown, revoked or wrong for this action | "this code stopped working" / "not your scenario" |
| 404 | unknown scenario or category | nothing: for a scenario that is not yours, 403 and 404 are both possible on purpose |
| 409 | the state is wrong for this action (in review, already published, id taken, the version changed) | the message; keep the row as it is |
| 413 | the archive is too large or has too many entries | the message |
| 429 | rate limit; `Retry-After` says when | "too many uploads this hour" |

`X-Forwarded-Proto` is honoured from the last proxy, so a deployment behind its own TLS
proxy must forward `https` (nginx does, `nginx/nginx.conf`).

## 3. Validate a key

```
$ curl -s http://127.0.0.1:8044/api/auth/me -H "Authorization: Bearer vlk_cfr5Iwqb-i1KK3AG8fu84xk919lgZ3LWU_ohbJ-9c_0"
{"role":"author","label":"docs-demo-2026-11-12","keyId":38}  HTTP 200
```

`role` is `author` or `moderator` (or `moderator` with a `keyId: null` for the bootstrap
token). A sign-in box in the editor should call this and remember the label; anything but 200
means the key is not usable.

## 4. What the key owns

```
$ curl -s http://127.0.0.1:8044/api/admin/scenarios -H "Authorization: Bearer vlk_…"
{"scenarios":[]}  HTTP 200        # a fresh key
```

An author sees only the rows their key owns; a moderator sees everything. Each row carries
what the admin list shows: `status` (`draft`/`review`/`published`/`rejected`), `scenarioUrl`,
`manifestUrl`, `ownerLabel`, the current and pending version ids. A `draft` row is not in the
public catalog — `/api/catalog` and `/api/catalog/:id` are the public surface.

## 5. Create a scenario

Two ways, both producing a **draft** owned by the calling key: `POST /api/catalog` with
metadata, or `POST /api/scenarios/from-archive` taking id, title, description and version
from the archive's own `manifest.json`. The second is what "Create project → Publish" wants.

```
$ curl -s -X POST http://127.0.0.1:8044/api/scenarios/from-archive \
    -H "Authorization: Bearer vlk_…" -F "archive=@demo.zip"
{"scenario":{"id":"doc-demo-scenario","title":"Демо","status":"draft","isPublished":false, …}}  HTTP 201

$ curl -s -X POST http://127.0.0.1:8044/api/scenarios/from-archive \
    -H "Authorization: Bearer vlk_…" -F "archive=@demo.zip"
{"error":"Сценарій з id \"doc-demo-scenario\" вже існує"}     HTTP 409
```

The id must be free across the whole catalog, published rows included: 409 on a taken id
answers "this slug exists" and the message names it. `manifest.json` needs
`manifestVersion`, `id` (a slug of 2–100 `a-z0-9-`), `name`, `version` and `entryPoint`.

## 6. Upload an archive

`POST /api/scenarios/:id/archive` with the ZIP in the `archive` field. What happens depends on
the row's status — this is the whole "draft" design of §7:

| row status | caller | answer |
|---|---|---|
| `draft` | owner or moderator | **201**, a new `current` version; `scenarioUrl` points at it |
| `published` | the owning **author** | **201**, a `pending` version — students keep the current archive until a moderator accepts |
| `published` | a **moderator** | **201**, the new version becomes `current` at once |
| `review` | anyone | **409** `Сценарій на перевірці: відкличте з перевірку, …` — withdraw first |
| not yours | anyone | **403** |

```
$ curl -s -X POST http://127.0.0.1:8044/api/scenarios/doc-demo-scenario/archive \
    -H "Authorization: Bearer vlk_…" -F "archive=@demo-v2.zip"
{"id":"doc-demo-scenario","sha256":"25f1aa82…","url":"/scenarios/25f1aa82….zip",
 "deduplicated":false,"version":{"id":48,"manifestVersion":"2.0.0","state":"current", …}}  HTTP 201
```

`state` is `current` or `pending` — read it, it is the answer to "did this go live".
`deduplicated: true` means the same bytes are already in the store (content-addressed) and the
object was reused; the version row is still new. Identical content uploaded a second time
answers 201 with the existing version and writes no new row.

Limits (the same numbers on a refusal): 200 MB per archive, 10 MB per entry, 20 000 entries,
and 20 uploads per hour per author key (`AUTHOR_UPLOADS_PER_HOUR`). Cover images have their
own counter, 30 per hour.

## 7. Submit and withdraw

```
$ curl -s -X POST http://127.0.0.1:8044/api/scenarios/doc-demo-scenario/submit \
    -H "Authorization: Bearer vlk_…"
{"id":"doc-demo-scenario","status":"review","isPublished":false,"submittedAt":"2026-11-12T05:21:30.856Z"}  HTTP 200

$ curl -s -X POST http://127.0.0.1:8044/api/scenarios/doc-demo-scenario/archive \
    -H "Authorization: Bearer vlk_…" -F "archive=@demo.zip"
{"error":"Сценарій на перевірці: відкличте з перевірки, щоб завантажити новий архів"}  HTTP 409

$ curl -s -X POST http://127.0.0.1:8044/api/scenarios/doc-demo-scenario/withdraw \
    -H "Authorization: Bearer vlk_…"
{"id":"doc-demo-scenario","status":"draft", …}  HTTP 200
```

Submit puts a `draft` or `rejected` row into the moderator's queue. Withdraw is the author's
own way back to `draft`, and it is the way to replace an archive while under review: a
moderator may also withdraw. **Approve, reject, unpublish and accept/reject of a pending
version are moderator-only** — an author sending them gets 403 even on their own scenario.

## 8. What an author may not send

`role`, `ownerKeyId`, `owner_key_id`, `status`, `isPublished`, `author`, `scenarioUrl`,
`manifestUrl`, `imageUrl` and every `archive*` field are ignored or refused: the listed ones
are a 400 that names them (`Автору заборонено поля: …`), the aliases are simply not read — the
row keeps the owner, the status and the attribution the server derives. Do not send them; a
client that does is a client that will break when the refusal becomes a hard error.

## 9. Errors, as the editor should show them

```
$ curl -s http://127.0.0.1:8044/api/auth/me -w " HTTP %{http_code}\n"
{"error":"Потрібна авторизація"} HTTP 401                      # no key
$ curl -s http://127.0.0.1:8044/api/auth/me -H "Authorization: Bearer vlk_wrong…" -w " HTTP %{http_code}\n"
{"error":"Невірний токен"} HTTP 403                            # unknown or revoked key
$ curl -s http://127.0.0.1:8044/api/catalog/no-such-scenario -w " HTTP %{http_code}\n"
{"error":"Сценарій не знайдено"} HTTP 404                      # unknown id
```

A revoked key is refused on every route, including the ones that were mid-request when the
revocation landed — a write re-reads the key inside its own transaction (B6 phase 7), so a
key that stopped working while an upload was streaming leaves nothing behind.

## 10. For B7, in one paragraph

Sign in with the key (`/api/auth/me`), list what it owns (`/api/admin/scenarios`), create from
the built archive (`/api/scenarios/from-archive`) or upload into an existing row
(`/api/scenarios/:id/archive`) and read `version.state` — `current` means live, `pending`
means waiting for a moderator. `submit` and `withdraw` are the author's own; everything that
changes what students see is the moderator's. Keep the key for the tab, send it over HTTPS,
and never write it anywhere a log could find it.
