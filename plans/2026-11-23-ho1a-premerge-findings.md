# HO1a findings-fix round (MS-1, slot W1) — plan

Worktree: E:/Projects/WebstormProjects/WebEngine/.workers/W1/virtual-lab
Branch: HO1a-windows-installer (HEAD 91f777b, ahead 3 / behind 2 vs origin/ms/1=72ebb8e).
Another worker stopped mid-task; this session finishes it. Commit on branch; do NOT push.
Never touch E:/Acceptance/**, .workers coordination/state files, other repos, primary checkouts.
Never run gate.sh. No npm install, no docker stack-ups. UI/doc strings Ukrainian;
code/comments/messages English ASCII.

MANDATORY workflow (code-foundations): skills cc-debugging (STABILIZE -> LOCATE ->
HYPOTHESIZE -> EXPERIMENT -> FIX -> TEST -> SEARCH; failing repro captured BEFORE edits),
cc-defensive-programming + cc-pseudocode-programming (install.ps1 edits), aposd-verifying-correctness
(final check). Graphify already queried by lead (base-stale for HO1a; read new files directly;
NEVER graphify update).

## Phase A — merge-forward + reproduce (capture raw outputs)
1. `git fetch origin --prune` then `git merge origin/ms/1 --no-edit`. Expected clean: incoming
   commits touch only scripts/test/backup-suite.test.mjs. If denied/conflict: STOP, report
   BLOCKED with raw error; no -X ours/theirs, commit-tree, reset or workarounds.
2. Repro finding 1 (BLOCKING): additions-only guard in scripts/test/install-windows-doc.test.mjs:79-100
   compares docs/self-host.md against LIVE ref origin/ms/1; once merged it fails. Reproduce per
   reviewer: temp git repo (git init, write refs/remotes/origin/ms/1 pointing at a commit whose
   docs/self-host.md = CURRENT worktree doc, i.e. post-HO1a), copy doc + test preserving relative
   layout (scripts/test/... two levels below root), run `node --test` -> expect AssertionError
   "the section minus the new subsection must equal the base section (0 deleted lines)". Capture.
3. Repro finding 4: `node -e "console.log('C:\Windows')"` -> prints C:Windows. Capture.
4. Repro finding 3: scripts/test/install-harness.mjs (makeSandbox + runInstaller with env
   {DB_PASSWORD:'...', ADMIN_TOKEN:'...'} dummy non-secret values) -> stdout has no NOTE for those
   keys. Capture.
5. Baseline: `npm run test:scripts` at repo root — record pass/fail counts.

## Phase B — fixes
File scope EXACTLY: install.ps1; docs/self-host.md; scripts/test/install-windows-doc.test.mjs;
scripts/test/install-harness.mjs line 20 ONLY; NEW scripts/test/fixtures/self-host-pre-ho1a.md.
The two existing-test edits are the task owner's explicit sanctioned exceptions to the milestone
test guard; NO other existing test modified/deleted/renamed; package.json untouchable.

- F1: fixture scripts/test/fixtures/self-host-pre-ho1a.md = exact bytes of
  `git show origin/ms/1:docs/self-host.md` (verified pre-HO1a: identical to e70ff8d, contains
  neither '### Windows: встановлення однією командою (install.cmd)' nor 'install.cmd').
  .gitignore ignores `.env.*` — fixture name avoids that; write via fs.writeFileSync(Buffer from
  spawnSync git show) or bash redirect (binary-safe). Rewrite ONLY test #3 of
  install-windows-doc.test.mjs to compare DOC against the fixture (both CRLF->LF normalized):
  same three assertions (text before ## Встановлення equal; text after equal; section minus new
  subsection [heading through line before ### Перший модератор] equals fixture section). Remove
  git spawnSync probe and early-return — fixture always present, test runs unconditionally.
  Tests #1 and #2 stay byte-identical. Update file header comment (frozen-fixture guard, no live
  ref). Fixture must NOT contain the new heading (assert in new regression test).
- F2 (ACL, non-blocking -> document): Ukrainian paragraph INSIDE Windows subsection of
  docs/self-host.md (after secrets paragraph 'Секрети зберігаються…', before 'Перший запуск —
  **2–5 хвилин**'): створений `.env` успадковує ACL теки репозиторію — якщо тека доступна на
  читання іншим користувачам (напр. BUILTIN\Users при розгортанні в C:\virtual-lab), вони можуть
  прочитати секрети; інсталятор ACL не змінює; обмежте доступ до `.env` (властивості файлу ->
  Безпека, або icacls) на спільних машинах. Additions-only: `git diff --numstat origin/ms/1... --
  docs/self-host.md` must show 0 deleted lines; no heading renames; no `docker compose … -f` line;
  do not break selfhost-doc.test.mjs section slicing.
- F3 (silent env override): install.ps1 right after FRONTEND_PORT NOTE block (~line 252): foreach
  key DB_PASSWORD, ADMIN_TOKEN — if process env sets it non-empty, print
  `NOTE: <KEY> is set in the environment; compose uses it instead of the .env value.`
  KEY NAME ONLY, never value (compose interpolation: process env precedence, docker-compose.yml).
  Pure ASCII (5.1 reads BOM-less as ANSI), English, no prompt, no secret echo. Update
  intent-level pseudocode header (.DESCRIPTION) with this step. Exactly two docker calls in order
  (info, compose up -d --build) unchanged; existing-.env bytes/mtime untouched; FRONTEND_PORT NOTE
  logic unchanged (DW-2.4 pins: env port equal to .env port -> NO 'NOTE:' at all — new NOTEs must
  not fire when those env vars unset/empty; harness childEnv spreads process.env, so tests must
  explicitly clear DB_PASSWORD/ADMIN_TOKEN via env:{DB_PASSWORD:'',ADMIN_TOKEN:''}).
- F4: scripts/test/install-harness.mjs line 20: 'C:\Windows' -> 'C:\\Windows'. ONE line only.

## Phase C — regression tests, ONE NEW FILE scripts/test/install-windows-findings.test.mjs
Pattern: import { ROOT, canRun, makeSandbox, runInstaller, secretValues } from './install-harness.mjs';
node:test; Windows-only legs `if (!canRun()) return;` — never skip/todo. Cover:
- F3: env DB_PASSWORD+ADMIN_TOKEN set (dummy) -> exit 0, NOTE naming each key, NEITHER value
  anywhere in stdout/stderr/dockerCalls, .env created normally (secrets 64-hex, differ),
  dockerCalls exactly ['info','compose up -d --build']; env cleared -> no NOTE for those keys;
  existing-.env case -> file byte-identical + mtime unchanged, NOTEs still shown.
- F4 (static, all platforms): harness source contains escaped literal 'C:\\Windows' and NOT
  unescaped 'C:\Windows' (read as text; careful with JS escaping in the test itself).
- F1: fixture exists, lacks NEW_HEADING and 'install.cmd'; committed post-merge simulation: temp
  git repo whose refs/remotes/origin/ms/1 carries CURRENT (fixed) docs/self-host.md, run rewritten
  guard test there via spawnSync(process.execPath, ['--test', ...]) -> status 0 (guard holds after
  merge; OLD test failed this exact scenario in Phase A). Negative leg: doc with a reworded line
  outside ## Встановлення fails the fixture guard.
- F2 (static): Windows subsection contains ACL warning (/ACL/ and /Users/, icacls or Безпека).
Then FULL battery + counts + raw tails: root `npm run test:scripts`; `cd backend && npm run
test:unit`; `cd frontend && npm run test:scripts`. Check frontend/node_modules and
backend/node_modules first: if frontend deps exist also `npx ng test --no-watch` and
`npm run build` + `npm run check:csp`; backend integration needs docker-compose.test.yml Postgres
on :55432 — do NOT start stacks; if not running record env-blocked with reason. e2e needs full
stack — env-blocked unless already up. Before heavy suites check free RAM
(powershell FreePhysicalMemory/1MB); if <~1.5GB note it. Any RED: cc-debugging; fix only within
scope; out-of-scope fix needed -> STOP, BLOCKED with evidence.
SEARCH (cc-debugging step 7): grep repo for sibling defects — other single-backslash Windows path
literals in .mjs/.js strings, other tests comparing docs against live git refs; record (out of
scope -> debt in report, do not fix).
Test-guard evidence: `git diff --name-only --no-renames --diff-filter=MDR origin/ms/1... --
'*test*' '*.spec.*' package.json` must print EXACTLY scripts/test/install-windows-doc.test.mjs
and scripts/test/install-harness.mjs. Capture raw. Also `git diff --numstat origin/ms/1... --
docs/self-host.md` (deleted must be 0).

## Phase D — commit + report
Stage EXACTLY: install.ps1, docs/self-host.md, scripts/test/install-windows-doc.test.mjs,
scripts/test/install-harness.mjs, scripts/test/fixtures/self-host-pre-ho1a.md, new regression
test file. `git status --porcelain` shows nothing else tracked-modified. ONE commit, message like
`fix(install): premerge findings — frozen doc-guard fixture, env-override NOTEs, ACL doc, harness
path escape (HO1a review round 1)`. Do NOT push. Do NOT commit plans/ or logs/.
Full report -> logs/ho1a-findings-report.md (gitignored): per finding repro output (before), fix
description, after-evidence (raw outputs), test counts per suite, env-blocked list with reasons,
guard outputs, sibling-search results, last SHA (`git rev-parse HEAD`), changed files
(`git show --stat --oneline HEAD`).
Reply <=10 lines: DONE or BLOCKED, branch, last SHA, changed files, test counts, one evidence line
per finding, report path. Mask any secrets.

Done-when: merge commit parent 72ebb8e; F1 guard green post-merge simulation AND fixture test
green normal run; F2 numstat deleted=0 + doc test green; F3 NOTE positive/negative sandbox
evidence no value echo; F4 corrected literal + static pin green; full runnable battery green;
test-guard diff exactly the two sanctioned files; one commit, no push, clean tracked tree.
Any permission denial (merge/commit/node/npm) -> BLOCKED with exact denial, no improvisation.