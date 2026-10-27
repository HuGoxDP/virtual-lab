// backend/test/manual-demo.js
//
// Одноразовий демонстраційний скрипт — НЕ частина npm test.
// Показує в консолі покроковий процес attachArchive: прийом файлу,
// обчислення sha256, читання маніфесту, попередження про id, дедуп,
// запис у БД. Потребує запущеної тестової БД:
//   docker compose -f docker-compose.test.yml up -d

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

process.env.ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-demo-${crypto.randomUUID()}`);
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '55432';
process.env.DB_NAME = process.env.DB_NAME || 'virtual_lab_test';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test_password';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'demo-admin-token';

const { app, pool } = require('../server');
const storage = require('../storage');
const { prepareSchema, truncateAll, seedScenarios } = require('./helpers/db');
const { validArchive } = require('./helpers/fixtures');

async function main() {
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);

  const AUTH = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
  const buffer = validArchive(); // manifest.id = "test.scenario.valid"

  console.log('\n===== Перше завантаження архіву на scenario "solar-system" =====');
  await request(app)
    .post('/api/scenarios/solar-system/archive')
    .set(AUTH)
    .attach('archive', buffer, 'scenario.zip')
    .expect(201);

  console.log('\n===== Повторне завантаження того самого архіву (очікується dedup) =====');
  await request(app)
    .post('/api/scenarios/solar-system/archive')
    .set(AUTH)
    .attach('archive', buffer, 'scenario.zip')
    .expect(201);

  await truncateAll(pool);
  await pool.end();
  await fsp.rm(process.env.ARCHIVE_ROOT, { recursive: true, force: true });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
