// e2e/smoke-setup.ts
//
// The smoke's only gate: the stack must answer /api/health. Unlike the main
// suite's global-setup, an empty catalog is NOT a refusal here — a fresh install
// has no scenarios, and proving that state boots and serves is the smoke's job.
// ADMIN_TOKEN is not required either: the one test that needs it skips itself
// with a reason when it is unset.

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8051';

async function smokeSetup(): Promise<void> {
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
  const body = await health.json() as { db?: string; build?: { version?: string } };
  console.log(`smoke → ${BASE_URL} (API ${body.build?.version ?? 'unknown'}, db ${body.db ?? 'unknown'})`);
}

export default smokeSetup;
