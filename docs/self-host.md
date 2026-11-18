# Самостійне розгортання (self-host)

Цей документ — для адміністратора університету, який розгортає платформу на
власному сервері. Production-доступу та deploy-конвеєра немає: репозиторій
збирається і запускається там, де ви його склонували. `npm run selfhost-check`
(нижче) — локальний доказ, що саме це працює на чистому клоні.

## Що це таке

Virtual Lab — платформа віртуальних лабораторних робіт: каталог сценаріїв,
перегляд у браузері (рушій WebEngineTS у ізольованому фреймі), публікація
сценаріїв авторами, LTI-інтеграція з LMS. Стек: PostgreSQL + Express API +
Angular-фронтенд за nginx, усе в Docker Compose.

## Вимоги

- Docker Engine 24+ та Docker Compose v2+ (`docker compose`, не `docker-compose`)
- 2 GB RAM мінімум, 5 GB диска
- Вільний порт для фронтенду (`FRONTEND_PORT` у `.env`, за замовчуванням 8044)
- Node.js 22+ — лише для `npm run selfhost-check` та e2e; самому стеку не потрібен

## Встановлення

```bash
git clone <url-репозиторію> virtual-lab
cd virtual-lab
cp .env.example .env
```

Відредагуйте `.env` — обов'язково два значення:

```bash
# пароль бази та токен початкового модератора; кожен — свій, довгий, випадковий
openssl rand -hex 32   # → DB_PASSWORD
openssl rand -hex 32   # → ADMIN_TOKEN
```

`DB_PASSWORD=change-me-before-deploying` та `ADMIN_TOKEN=change-me-before-deploying`
з шаблону залишати не можна: перший захищає базу, другий — усі ендпоінти запису
(він діє як модератор без окремого ключа). Коротший за 32 символи `ADMIN_TOKEN`
працює, але дає попередження при старті. `.env` не потрапляє в git — не комітьте його.

```bash
docker compose up -d --build
```

Перший запуск — 2–5 хвилин (збірка Angular + завантаження образів). Перевірка:

```bash
docker compose ps
curl http://localhost:8044/api/health
# {"status":"ok","db":"connected","build":{...}}
```

Сайт: `http://server-ip:8044` (або ваш `FRONTEND_PORT`).

### Перший модератор

Каталог на свіжій установці порожній — це нормально. `ADMIN_TOKEN` з `.env` уже є
модератором: з ним видайте особисті ключі авторам і модераторам
(`POST /api/keys`, заголовок `Authorization: Bearer <токен>`; докладно —
`docs/publish-api.md`). Особисті ключі працюють незалежно від bootstrap-токена;
якщо `ADMIN_TOKEN` не заданий, bootstrap просто вимкнено.

### Наповнення каталогу

Сценарії живуть у репозиторії **ScenarioCreator**, не тут. Публікація релізу:
`cd backend && npm run publish:release` (див. `docs/publish-api.md`).

## Оновлення

```bash
git pull
docker compose up -d --build
```

Дані живуть у Docker-томах (`virtual_lab_pgdata`, `virtual_lab_archives`,
`virtual_lab_assets`, `virtual_lab_lti`) — збірка та
перезапуск їх не чіпають. Схема бази мігрує сама при старті backend.

## Резервні копії та відновлення

Сервіс `backup` робить дамп бази + архіви томів за розкладом; відновлення —
`docker-compose.restore.yml`. Процедура, формат і доказ відновлюваності —
**`docs/backup-restore.md`**. Бекапи містять приватний LTI-ключ: зберігайте їх як секрети.

## HTTPS

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
curl -k https://127.0.0.1:8443/api/health
```

Образ збирає самопідписаний сертифікат (`nginx/make-cert.mjs`) — `curl -k` тут
очікуваний. На production-хості змонтуйте власний сертифікат у `/etc/nginx/tls/`
і власні порти (це, разом із off-host бекапом, — задача P5b). З `REQUIRE_HTTPS`
токени приймаються лише через TLS-слухач; публічні маршрути на :80 живі як раніше.

## Редактор сценаріїв (необов'язково)

```bash
docker compose -f docker-compose.yml -f docker-compose.editor.yml up --build -d
```

Редактор збирається з **сусіднього чекаута `WebEngineTSEditor`**
(`../../WebEngineTSEditor` відносно цього репо) і з'являється на `/editor/`.
Без нього платформа працює як раніше — студентам він не потрібен.

## Логи, зупинка, скидання

```bash
docker compose logs -f            # усі логи
docker compose logs -f backend    # один сервіс
docker compose stop               # зупинити, дані лишаються
docker compose down               # прибрати контейнери, томи лишаються
docker compose down -v            # ПОВНЕ скидання: томи й усі дані видаляються
```

`down -v` — незворотна дія: спершу зробіть бекап (`docs/backup-restore.md`).

## Перевірка «чи працює моя установка?» — `npm run selfhost-check`

Команда клонує гілку репозиторію в тимчасову папку, пише `.env` із згенерованими
секретами, піднімає **окремий** стек (перейменований проєкт `vl-selfcheck`,
томи `vlcheck_*`, контейнери `VLCheck*`), чекає healthy, робить і **перевіряє
читанням** один бекап, проганяє e2e-smoke (7 перевірок свіжої установки) і все
прибирає. Жодного дотику до вашого робочого стека.

```bash
npm run selfhost-check -- --lock <каталог-замок> [--ref main] [--frontend-port 8051]
```

- `--lock` обов'язковий: каталог, який ви тримаєте як замок, щоб перевірка не
  змагалася з робочим стеком за Docker і порти. У робочому процесі WebEngine це
  `bash .workers/wk.sh lock vl-db W<n> HO1`; поза ним — будь-який каталог, який
  гарантує, що інші compose-запуски цієї бази зараз не йдуть.
- Порт за замовчуванням 8051, не 8044: перевірка відмовляється стартувати, якщо
  порт зайнятий (`--frontend-port` змінює).
- `--keep` лишає тимчасовий клон і стек для огляду; без нього все прибирається
  навіть після помилки.
- Кожен крок друкує один рядок `ok`/`FAIL`; підсумок — `GREEN` або `RED at <крок>`.

Потрібні Docker і Node.js 22+; e2e-залежності та Chromium команда ставить сама
в тимчасовий клон.