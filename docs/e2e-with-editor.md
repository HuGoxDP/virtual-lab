# Running the browser e2e (with the editor)

How the suite in `e2e/` is driven against a composed stack, including the editor
override — the run M2.1 (2026-11-11) established.

## 1. The stack

```bash
docker compose -f docker-compose.yml -f docker-compose.editor.yml up --build -d
```

`docker-compose.editor.yml` serves the editor beside the catalog at `/editor/` (it mounts
`nginx/editor.conf` into `server.d/`; without it `/editor/` does not exist). The editor is built
from the sibling `WebEngineTSEditor` checkout — **the override's build context
(`../../WebEngineTSEditor`) assumes the owner's layout, where the platform lives under
`testv/`**. In a worker worktree (`.workers/W<n>/{virtual-lab,WebEngineTSEditor}`) the context is
one directory up: stack a local override with `context: ../WebEngineTSEditor` for the run.

## 2. Content

The suite needs a non-empty catalog (`global-setup.ts` says so, and says it clearly):

```bash
cd backend
node --env-file-if-exists=../.env scripts/publish-release.mjs   --release <path>/ScenarioCreator/ReleaseScenarios
node --env-file-if-exists=../.env scripts/import-release-assets.mjs --release <same>   # for ?stream=1
```

The bench scenes in the release report "no entry in catalog-metadata.mjs" — expected, harmless
(they get no subject in the catalog).

## 3. The browser

```bash
cd e2e && npx playwright install chromium     # once per machine
set -a && . ../.env && set +a                 # ADMIN_TOKEN for the admin path
E2E_BASE_URL=http://127.0.0.1:8044 npm test
```

## 4. What the 2026-11-11 run showed (M2.1)

With the editor in the stack: **136 passed, 1 failed, 2 skipped** over the whole suite (the
published run was 91 passed / 14 not run with an empty-catalog detour in between — see
`​.claude-shared/code-foundations/M2.1/notes.md` for the full account).

The one failure is `streaming.spec.ts` — *"an asset-heavy scenario renders the same scene from a
manifest as from its ZIP"*: the streamed first frame took ~100 s against the spec's 60 s budget
on this machine (ZIP ~49 s, manifest ~127 s, software WebGL via SwiftShader). The correctness
half of that test passes; the **budget is hardware-bound here** and the manifest path's speed is
the streaming lane's problem (E-G2a / R8), not the editor's.

**A trap worth remembering:** `docker compose down -v` between runs wipes the published catalog —
every catalog-dependent spec then fails on an empty store, which reads like product breakage and
is not. Bring the stack up, re-check `/api/catalog` **before** blaming the suite.
