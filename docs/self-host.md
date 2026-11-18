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

Реліз платформи — це стан гілки `main`; тегів версій у репозиторії немає.
Яка саме збірка у вас працює, показує `GET /api/health` → `build` (рушій —
окремо: штамп збірки у переглядачі під `?diag=1`).

### Як оновитися

Образи застосунку збираються локально (`backend`, `frontend`, `backup`), тому
оновлення — це `git pull` плюс перебудова; `docker compose pull` сам по собі
оновлює лише образ PostgreSQL. Порядок:

1. **Зробіть бекап і перевірте його читанням:**

   ```bash
   docker compose run --rm -e BACKUP_RUN_ONCE=1 backup
   node scripts/lib/verify-backup.mjs backup/out/<каталог-бекапу>
   ```

   Перевірка пише маркер `verified`; без нього `restore.mjs` відмовляє навіть
   у dry-run — неперевірений бекап не є ціллю відновлення. Процедура —
   `docs/backup-restore.md`. **Бекап містить приватний LTI-ключ: зберігайте
   його як секрет.**

2. Оновіть код:

   ```bash
   git pull
   ```

3. Перебудуйте і перезапустіть стек:

   ```bash
   docker compose up -d --build
   ```

   Перша збірка після pull може тривати кілька хвилин: tarball рушія
   завантажується з GitHub Releases під час збірки — хосту потрібен інтернет.

4. Перевірте `/api/health` (`"db":"connected"`) і каталог у браузері. Схема
   бази мігрує сама при старті backend. Дані живуть у п'яти Docker-томах
   (`virtual_lab_pgdata`, `virtual_lab_archives`, `virtual_lab_assets`,
   `virtual_lab_previews`, `virtual_lab_lti`) — збірка та перезапуск їх не
   чіпають; LTI-ключ лишається на місці.

Після оновлення можна прогнати `npm run selfhost-check` (нижче).

### Що нового

Розділ оновлюється, коли в `origin/main` з'являються зміни, видимі
адміністратору. Новіше — згори.

- **2026-11-18 — self-host-набір (HO1):** цей посібник, `npm run selfhost-check`
  і перевірка бекапу читанням; відновлення приймає лише бекап із маркером
  `verified` (`docs/backup-restore.md`).
- **2026-11-12 — особисті ключі публікації (B6):** ключі з префіксом `vlk_`,
  ротація з передачею сценаріїв новому власнику, сторінка «Доступ» в `/admin`;
  опція `REQUIRE_HTTPS` (`docker-compose.https.yml`); схвалення прив'язане до
  версії архіву, яку модератор перевірив.
- **2026-11-11 — нічні бекапи (P5a):** сервіс `backup`, відновлення
  `restore.mjs` із dry-run за замовчуванням, `docs/backup-restore.md`; HTTPS
  на 8443 із самопідписаним сертифікатом (`docker-compose.https.yml`).
- **2026-11-11 — рушій із GitHub Release (A10):** залежність фронтенду —
  tarball релізу, тож збірці потрібна мережа.
- **2026-10-27 — інструмент LTI 1.3 для Moodle:** реєстрація одним посиланням,
  оцінки в журнал Moodle; покрокова реєстрація — розділ «Робота як
  LTI-інструмент (Moodle)» нижче; огляд — `Readme.md`, той самий розділ.
- **2026-10-26 — ізоляція сценаріїв:** код сценаріїв виконується в ізольованому
  фреймі поза origin платформи й не має доступу до токена адміністратора.

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

## Робота як LTI-інструмент (Moodle)

Покрокова реєстрація платформи в Moodle. Огляд — `Readme.md`, розділ «Робота
як LTI-інструмент (Moodle)». **Кроки перевірені на Moodle 5.0.2 (локальний
стенд lti-demo); на іншій версії Moodle назви пунктів меню можуть
відрізнятися.** Відрепетирувати реєстрацію можна на локальному стенді
(Moodle 5.0.2 + платформа + TLS-проксі): `docs/lti-demo.md`.

### Передумова: HTTPS з обох боків

**LTI не працює без HTTPS на платформі й на Moodle.** Cookies сесії —
`SameSite=None; Secure; Partitioned`, через http браузер їх не надсилає.
Стандартний self-host слухає http:8044: підніміть стек із розділу HTTPS вище
(8443) або власний TLS. Поки `LTI_PUBLIC_URL` не https, усі `/api/lti` — 503.

### Крок 1 — змінні в `.env`

```bash
openssl rand -hex 24   # → LTI_REGISTRATION_SECRET
# .env:
LTI_PUBLIC_URL=https://lab.example.edu:8443
LTI_REGISTRATION_SECRET=<згенерований секрет>
LTI_FRAME_ANCESTORS=https://moodle.example.edu
```

- `LTI_PUBLIC_URL` — https-origin платформи **без шляху**, з портом, якщо не
  443; точно той, що відкривають браузери студентів.
- `LTI_REGISTRATION_SECRET` — не коротший за 16 символів, інакше 503.
  **Секрет їде в URL реєстрації (журнали nginx, історія браузера) — змініть
  його одразу після реєстрації** (крок 4).
- `LTI_FRAME_ANCESTORS` — точний origin Moodle (кілька — через пробіл). Без
  нього «Select content» лишиться порожнім; некоректне значення — контейнер
  frontend не стартує.

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
```

Ключ інструмента (RSA-2048) генерується сам при першому старті й лежить у
томі `virtual_lab_lti` (`/srv/lti/tool-key.pem`). **Втрата тома робить
реєстрацію недійсною — потрібна повторна.** Бекапи включають ключ:
зберігайте їх як секрет.

### Крок 2 — реєстрація одним посиланням (рекомендовано)

1. Moodle, адміністратор: Site administration → Plugins → Activity modules →
   External tool → Manage tools (`/mod/lti/toolconfigure.php`).
2. У полі *Tool URL or registration URL* вставте
   `https://<платформа>/api/lti/register?secret=<LTI_REGISTRATION_SECRET>`
   і натисніть *Add LTI Advantage*.
3. Інструмент з'явиться у статусі *Pending* — натисніть *Activate*.
4. У налаштуваннях інструмента (олівець): *Tool configuration usage* —
   «Show in activity chooser and as a preconfigured tool» (інакше інструмента
   немає у виборі активностей); *Default launch container* — «New window»;
   надсилання імені й e-mail студента — «Never» (`docs/privacy.md`).

### Крок 3 — ручна реєстрація (якщо динамічна заблокована)

Створіть інструмент вручну й заповніть поля; `<база>` — ваш `LTI_PUBLIC_URL`:

| Поле Moodle | Значення |
|---|---|
| Tool URL / Target link URI / Redirection URI(s) | `<база>/api/lti/launch` |
| Initiate login URL | `<база>/api/lti/login` |
| Public keyset URL | `<база>/api/lti/jwks` |
| Метод автентифікації | `private_key_jwt`, RS256 |
| Services | AGS (`lineitem`, `result.readonly`, `score`) + Deep Linking |

### Крок 4 — ротація секрету

**Одразу після реєстрації змініть `LTI_REGISTRATION_SECRET` у `.env`** і
перезапустіть backend (`docker compose up -d backend`). Реєстрація збережена;
секрет потрібен лише для нових реєстрацій.

### Що далі: викладач і студент

Викладач додає в курс активність *External tool* → *Select content* → обирає
сценарій у пікері. Запустити можна лише **опубліковані** сценарії; оцінюваним
сценарій робить `"graded": true` у маніфесті (прапорець — з поточної версії
архіву). Студент відкриває активність — лабораторна стартує в новому вікні,
оцінка після «Здати» йде в журнал Moodle (AGS). Платформа не зберігає
оцінок, імен і пошти (`docs/privacy.md`).

### Якщо щось пішло не так

- **503 на `/api/lti`** — `LTI_PUBLIC_URL` не https або
  `LTI_REGISTRATION_SECRET` коротший за 16 символів.
- **Порожнє «Select content»** — `LTI_FRAME_ANCESTORS` не заданий чи вказує
  інший origin; або браузер не прийняв самопідписаний сертифікат: відкрийте
  адресу платформи напряму й прийміть його (`docs/lti-demo-cheatsheet.md`).
- **403 при реєстрації** — невірний секрет; **401** — секрет у URL відсутній.
- **Реєстрація зникла після `down -v`** — ключ згенеровано заново:
  зареєструйте інструмент повторно (крок 2).
- **«Сесію Moodle завершено…»** — сесія запуску живе 4 години
  (`LTI_SESSION_TTL_SECONDS`): відкрийте роботу знову з курсу в Moodle.
- **Safari** — пікер перевірений у Chromium і Firefox, Safari не тестувався
  (ITP, `docs/lti-demo.md`); запуск у новому вікні цього не стосується.

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