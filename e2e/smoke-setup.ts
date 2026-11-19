// e2e/smoke-setup.ts
//
// The smoke's only gate: the stack must answer /api/health. Unlike the main
// suite's global-setup, an empty catalog is NOT a refusal here — a fresh install
// has no scenarios, and proving that state boots and serves is the smoke's job.
// ADMIN_TOKEN is not required either: the one test that needs it skips itself
// with a reason when it is unset.

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8051';

/**
 * The health fetch. Over plain HTTP (or a trusted cert) this is fetch; with the
 * explicit E2E_INSECURE_TLS=1 opt-in (the selfcheck stack's self-signed cert,
 * P5b D8) it is node:https with rejectUnauthorized:false — undici's fetch
 * ignores NODE_TLS_REJECT_UNAUTHORIZED and would refuse the cert.
 */
async function fetchHealth(): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  if (process.env.E2E_INSECURE_TLS !== '1') return fetch(`${BASE_URL}/api/health`);
  const { request } = await import('node:https');
  return new Promise((resolve, reject) => {
    const req = request(`${BASE_URL}/api/health`, { rejectUnauthorized: false, timeout: 15_000 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({
        ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
        status: res.statusCode ?? 0,
        json: async () => JSON.parse(text),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('health probe timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function smokeSetup(): Promise<void> {
  let health: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    health = await fetchHealth();
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
