// e2e/global-setup.ts
//
// Fails the run before any browser starts if the stack is not actually there.
//
// Without this the first symptom is a page-load timeout in an unrelated test,
// which reads like a product defect rather than "nothing is running".

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8044';

async function globalSetup(): Promise<void> {
  let health: Response;

  try {
    health = await fetch(`${BASE_URL}/api/health`);
  } catch (cause) {
    throw new Error(
      `Cannot reach ${BASE_URL}. Start the stack first:\n` +
      `  docker compose up -d\n` +
      `or point E2E_BASE_URL at a running instance.\n\n${cause}`
    );
  }

  if (!health.ok) {
    throw new Error(`${BASE_URL}/api/health returned ${health.status} — the API or its database is down.`);
  }

  if (!process.env.ADMIN_TOKEN) {
    throw new Error(
      'ADMIN_TOKEN is not set. The admin golden path needs it; export it from the ' +
      'same .env the stack was started with.'
    );
  }

  // The student path needs something to open. An empty catalog is a valid state
  // for a fresh install (see db/init.sql), but it is not a state these tests can
  // run in — say so plainly rather than failing on a missing card.
  const catalog = await fetch(`${BASE_URL}/api/catalog?limit=1`);
  const { total } = await catalog.json() as { total: number };

  if (total === 0) {
    throw new Error(
      'The published catalog is empty, so there is no scenario to open. Publish a ' +
      'release first:\n  cd backend && npm run publish:release'
    );
  }

  const build = await health.json() as { build?: { version: string } };
  console.log(`e2e → ${BASE_URL} (API ${build.build?.version ?? 'unknown'}, ${total} published scenario(s))`);
}

export default globalSetup;
