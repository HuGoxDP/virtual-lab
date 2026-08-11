# Virtual Lab — Документація для розгортання

## Що це таке

Веб-додаток «Віртуальна 3D Лабораторія» для університету. Студенти відкривають каталог навчальних сценаріїв (фізика, біологія, хімія тощо), обирають сценарій і запускають інтерактивну 3D-симуляцію у браузері через WebGL.

Додаток складається з трьох частин: Angular-фронтенд (SPA), Express-бекенд (API + проксі для Google Drive), PostgreSQL (каталог сценаріїв). Все упаковано в Docker Compose — три контейнери, один `docker compose up`.

---

## Архітектура

```
┌─────────────────────────────────────────────────────┐
│                 docker compose                       │
│                                                     │
│  ┌───────────────────────────────────┐              │
│  │         nginx (web) :80           │              │
│  │  ┌─────────────┬────────────────┐ │              │
│  │  │  /          │  /api/*        │ │              │
│  │  │  static     │  proxy_pass    │ │              │
│  │  │  Angular    │  → api:3000    │ │              │
│  │  └──────┬──────┴───────┬────────┘ │              │
│  └─────────┼──────────────┼──────────┘              │
│            │              │                          │
│  ┌─────────▼──────┐  ┌───▼────────────────┐        │
│  │  Frontend      │  │  Backend (api)     │        │
│  │  Angular SPA   │  │  Express :3000     │        │
│  │  (статичні     │  │                    │        │
│  │   файли)       │  │  GET /api/catalog  │        │
│  └────────────────┘  │  GET /api/proxy-   │        │
│                      │      download      │        │
│                      │  POST /api/catalog │        │
│                      └────────┬───────────┘        │
│                               │                     │
│                      ┌────────▼───────────┐        │
│                      │  PostgreSQL (db)   │        │
│                      │  :5432             │        │
│                      │  virtual_lab       │        │
│                      └────────────────────┘        │
└─────────────────────────────────────────────────────┘
```

### Потік даних

1. Браузер відкриває `http://server:80` → nginx віддає Angular SPA (index.html + JS + CSS).
2. Angular робить `GET /api/catalog` → nginx проксірує на Express → Express робить SELECT з PostgreSQL → повертає JSON.
3. Студент натискає «Запустити» → Angular завантажує ZIP-сценарій. Якщо ZIP на Google Drive — запит іде через `GET /api/proxy-download?id=...` → Express бере посилання з БД, завантажує файл із Google Drive (обхід CORS) → стрімить клієнту.
4. WebGL-движок (WebEngineTS) розпаковує ZIP і запускає 3D-сцену в браузері.

---

## Структура файлів

```
virtual-lab/
├── frontend/                 # Angular 21 SPA
│   ├── src/
│   │   ├── app/
│   │   │   ├── pages/
│   │   │   │   ├── catalog/       # Сторінка каталогу
│   │   │   │   └── viewer/        # Сторінка 3D-перегляду
│   │   │   ├── models/            # TypeScript інтерфейси
│   │   │   └── services/          # HTTP-сервіси
│   │   ├── assets/                # Статика (ZIP-файли, іконки)
│   │   └── environments/
│   │       └── environment.ts     # catalogUrl: '/api/catalog'
│   ├── angular.json
│   ├── package.json
│   └── WebEngineTS-0.1.0.tgz     # 3D-движок (npm-пакет)
│
├── backend/                  # Express API
│   ├── server.js             # Весь бекенд в одному файлі
│   ├── package.json          # express, pg, cors
│   └── Dockerfile
│
├── nginx/
│   └── nginx.conf            # Reverse proxy конфіг
│
├── db/
│   └── init.sql              # Створення таблиць + seed-дані
│
├── docker-compose.yml        # Оркестрація всіх сервісів
└── Dockerfile.frontend       # Multi-stage: build Angular → nginx
```

---

## Інструкція з розгортання

### Вимоги до сервера

- Docker Engine 24+
- Docker Compose v2+
- 2 GB RAM мінімум
- 5 GB дискового простору
- Відкритий порт 80 (або інший, налаштовується)

### Крок 1: Отримати файли

Скопіювати всю папку `virtual-lab/` на сервер будь-яким способом (git clone, scp, rsync, флешка).

### Крок 2: Запустити

```bash
cd virtual-lab
docker compose up --build -d
```

Ця команда:
- Збирає Angular-проєкт у production-бандл (multi-stage Dockerfile).
- Піднімає PostgreSQL та заповнює початковими даними з `init.sql`.
- Запускає Express API і підключає його до бази.
- Запускає nginx, який роздає фронтенд і проксірує `/api/*`.

Перший запуск займе 2-5 хвилин (збірка Angular + завантаження Docker-образів).

### Крок 3: Перевірити

```bash
# Статус контейнерів
docker compose ps

# Перевірка API
curl http://localhost/api/health
# Очікувана відповідь: {"status":"ok","db":"connected"}

# Перевірка каталогу
curl http://localhost/api/catalog
# Очікувана відповідь: {"version":"1","scenarios":[...]}

# Логи (якщо щось не працює)
docker compose logs -f
```

Сайт доступний на `http://server-ip:80`.

### Зміна порту

Якщо порт 80 зайнятий, в `docker-compose.yml` змінити:

```yaml
ports:
  - "8080:80"    # було "80:80"
```

---

## Конфігурація

### Змінні середовища (`.env`)

Файл `.env` **не** зберігається в git. Створіть його з шаблону:

```bash
cp .env.example .env
```

| Змінна | Опис |
|--------|------|
| DB_NAME / DB_USER / DB_PASSWORD | Доступ до PostgreSQL. Пароль згенеруйте: `openssl rand -base64 24` |
| DB_HOST / DB_PORT | `database` / `5432` — імена всередині compose-мережі |
| API_PORT | Порт Express (внутрішній), `3000` |
| ADMIN_TOKEN | Токен для запису в каталог: `openssl rand -hex 32`. Без нього POST/PUT/DELETE відповідають 503 |
| FRONTEND_PORT | Зовнішній порт сайту |
| PROXY_RATE_LIMIT | Необов'язково: скільки завантажень з однієї адреси за 15 хв (за замовчуванням 60) |
| MAX_ARCHIVE_BYTES | Необов'язково: максимальний розмір архіву (за замовчуванням 2 GiB) |

### Безпека для production

1. Згенеруйте власні `DB_PASSWORD` та `ADMIN_TOKEN` — значення з `.env.example` є заглушками.
2. Не публікуйте порти `5432` та `3000` назовні: nginx і так проксіює API, а прямий доступ
   до БД ззовні небезпечний.
3. Ротація пароля БД **без втрати даних** (просто змінити `.env` недостатньо — `POSTGRES_PASSWORD`
   діє лише при першому створенні тому):
   ```bash
   docker compose exec database psql -U lab_user -d virtual_lab \
     -c "ALTER USER lab_user WITH PASSWORD 'НОВИЙ_ПАРОЛЬ';"
   # потім оновіть DB_PASSWORD у .env і перезапустіть бекенд
   docker compose up -d backend
   ```

### Публікація сценарію (через `/admin`)

Повний шлях від зібраного ZIP до видимого в каталозі — без терміналу і без SQL:

1. Відкрити `http://localhost:8044/admin`, ввести `ADMIN_TOKEN`
   (зберігається лише на час вкладки браузера).
2. **+ Новий сценарій** → заповнити `id`, назву, категорію та підпис категорії.
   `id` потрапляє в URL `/play/<id>`, тому це має бути слаг без пробілів.
3. У рядку сценарію натиснути **Архів…** і вибрати ZIP, зібраний ScenarioCreator.
   Показується прогрес завантаження, потім sha256 і розмір.
4. Перемкнути стан на **Опубліковано**.

Сервер перевіряє архів **до** збереження і відмовляє з конкретною причиною:
файл не читається як ZIP; немає `manifest.json` у корені; маніфест не є валідним JSON;
у маніфесті бракує обов'язкових полів; точка входу `scripts/<entryPoint>` відсутня в архіві.

> **`id` у каталозі та `id` у маніфесті — різні речі.** Каталог використовує слаги
> (`solar-system`), маніфести — зворотно-доменні ідентифікатори
> (`template.benchscene1.primitives`). Рушій їх не звіряє: `loadScenarioFromBuffer`
> отримує лише байти. Тому розбіжність показується як попередження, а не як помилка,
> а `manifest_id` зберігається в БД і видно в адмінці.

### Діагностика продуктивності (`?diag=1`)

Накладка рушія з FPS, часом кадру на CPU (з розбивкою по фазах) і оцінкою VRAM — це
**інструмент вимірювання, а не функція для студента**. Тому вона вимкнена за замовчуванням.

Щоб увімкнути, додайте `?diag=1` до адреси сценарію:

```
http://localhost:8044/play/solar-system?diag=1
```

Тоді у правому верхньому куті з'явиться кнопка **📊**. Без прапорця кнопки немає взагалі, і
профайлер навіть не створюється — його цикл `requestAnimationFrame` існує лише разом із
накладкою, тож вимкнений стан не коштує жодного кадру.

> Числа для порівняння конфігурацій знімайте **не тут**, а харнесом рушія
> (`WebEngineTS/benchmarks/`): він працює з content-only архівами, а оптимізації задаються
> прапорцями в URL. Накладка у в'юері показує стан живої сцени, а не відтворюваний замір.

### Стиснені текстури KTX2

Рушій уміє транскодувати `.ktx2` у формат, рідний для GPU (BC7, ASTC, ETC — залежно від
пристрою). Транскодер — це WASM-модуль, який роздає **платформа**, а не бандл рушія:
`frontend/src/assets/basis/` → `/assets/basis/`.

В'юер виставляє шлях сам (`Texture2D.ktx2TranscoderPath`) до завантаження будь-якого сценарію.
Змінювати нічого не потрібно, але якщо ви переносите `src/assets/` — **не забудьте про цю теку**:
дефолт рушія `/basis/` тут поверне 404, і збій буде **тихим**, аж поки якийсь сценарій не
привезе стиснені текстури.

Сценарії з подвійним форматом (і `.jpg`, і `.ktx2` в одному архіві) збирає ScenarioCreator
прапорцем `--ktx2`.

### Сховище сценаріїв

Архіви лежать у томі `virtual_lab_archives` під іменем свого sha256
(`/scenarios/<sha256>.zip`) і віддаються **nginx-ом**, не Express. Ім'я = вміст, тому файл
незмінний: браузер кешує його назавжди, а повторне завантаження того самого архіву
не займає місця.

```bash
# Завантажити архів для наявного сценарію
curl -X POST http://localhost:8044/api/scenarios/solar-system/archive \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "archive=@scenario.zip"

# Перенести архів із Google Drive у локальне сховище
curl -X POST http://localhost:8044/api/scenarios/solar-system/archive/import \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Порядок міграції з Google Drive** (потрібен один раз, і після `docker compose down -v`):

1. `LEGACY_DRIVE_PROXY=true` у `.env`, `docker compose up -d backend`.
2. Викликати `.../archive/import` для кожного сценарію.
3. `LEGACY_DRIVE_PROXY=false`, `docker compose up -d backend`.

Після цього завантаження сценарію не робить жодного зовнішнього запиту.

### Міграції схеми

`db/init.sql` виконується **лише** при створенні бази. Усі подальші зміни схеми — це файли
`backend/migrations/NNN_*.sql`, які бекенд застосовує при старті (таблиця `schema_migrations`).
Нову зміну додавайте туди, а не в `init.sql`.

### Резервне копіювання

Стан зберігається у **двох** томах — БД і архіви. Обидва треба резервувати:

```bash
# 1. Дамп БД
docker compose exec -T database pg_dump -U lab_user virtual_lab > backup-$(date +%F).sql

# 2. Архіви сценаріїв
docker run --rm -v virtual_lab_archives:/data -v "$PWD:/backup" alpine \
  tar czf /backup/archives-$(date +%F).tar.gz -C /data .

# Відновлення
docker compose down -v && docker compose up -d database
docker compose exec -T database psql -U lab_user -d virtual_lab < backup-2026-08-01.sql
docker run --rm -v virtual_lab_archives:/data -v "$PWD:/backup" alpine \
  tar xzf /backup/archives-2026-08-01.tar.gz -C /data
```

> Дамп БД без архівів марний: `scenario_url` вказуватиме на файли, яких немає.

---

## API-ендпоінти

| Метод | URL | Доступ | Опис |
|-------|-----|--------|------|
| GET | /api/catalog | публічний | Опубліковані сценарії. Параметри: `category`, `q`, `limit` (макс. 100), `offset` |
| GET | /api/catalog/:id | публічний | Один сценарій за ID |
| POST | /api/catalog | **адмін** | Додати новий сценарій |
| PUT | /api/catalog/:id | **адмін** | Оновити сценарій (у т.ч. `isPublished`) |
| DELETE | /api/catalog/:id | **адмін** | Видалити сценарій |
| GET | /api/admin/scenarios | **адмін** | Усі сценарії, включно з прихованими, зі станом сховища |
| POST | /api/scenarios/:id/archive | **адмін** | Завантажити ZIP-архів (multipart, поле `archive`) |
| POST | /api/scenarios/:id/archive/import | **адмін** | Перенести архів із зовнішнього посилання у локальне сховище |
| GET | /scenarios/&lt;sha256&gt;.zip | публічний | Архів сценарію (віддає nginx, не Express) |
| GET | /api/proxy-download?id=... | публічний | Legacy-проксі до Google Drive (вимикається `LEGACY_DRIVE_PROXY=false`) |
| GET | /api/health | публічний | Перевірка стану сервера та БД |

Адмін-ендпоінти вимагають заголовок `Authorization: Bearer $ADMIN_TOKEN`.
Без заголовка — 401, з невірним токеном — 403, якщо `ADMIN_TOKEN` не заданий у `.env` — 503.

### Формат каталогу (GET /api/catalog)

```json
{
  "version": "1",
  "scenarios": [
    {
      "id": "solar-system",
      "title": "Сонячна Система",
      "description": "Короткий опис...",
      "fullDescription": "Повний опис...",
      "category": "astronomy",
      "categoryLabel": "Астрономія",
      "imageUrl": "https://...",
      "scenarioUrl": "https://drive.google.com/file/d/.../view",
      "version": "1.0.0",
      "author": "HuGox"
    }
  ],
  "categories": [
    { "category": "astronomy", "categoryLabel": "Астрономія" }
  ],
  "total": 4,
  "limit": 24,
  "offset": 0
}
```

`total` — скільки сценаріїв відповідає фільтру загалом (для пагінації).

`categories` — це різні категорії опублікованих сценаріїв. Фільтри в каталозі будуються з цього
списку, тому нова категорія з'являється у фільтрах одразу після додавання сценарію, без
перезбірки фронтенду.

### Додавання сценарію (POST /api/catalog)

```bash
curl -X POST http://localhost/api/catalog \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "new-scenario",
    "title": "Новий Сценарій",
    "description": "Короткий опис",
    "fullDescription": "Повний опис",
    "category": "physics",
    "categoryLabel": "Фізика",
    "imageUrl": "https://example.com/image.jpg",
    "scenarioUrl": "https://drive.google.com/file/d/FILE_ID/view?usp=sharing",
    "version": "1.0.0",
    "author": "Автор"
  }'
```

---

## Завантаження сценаріїв із Google Drive

> ⚠️ **Тимчасове рішення.** Google Drive буде замінено власним сховищем із
> контентно-адресованими ассетами. Це потрібно для LOD-стрімінгу, прогресивного
> завантаження та передзавантаження — монолітний ZIP їх зробити не дозволяє.
> Поетапний план переходу: [`docs/scenario-delivery-migration.md`](docs/scenario-delivery-migration.md)
> (рушійна частина — `WebEngineTS/design/asset-streaming-proposal.md`).

### Як це працює

Браузер не може завантажити файл напряму з Google Drive через CORS-обмеження. Тому:

1. Фронтенд бачить, що `scenarioUrl` — зовнішнє посилання (не `/assets/...`).
2. Замість прямого `fetch()` він викликає бекенд: `GET /api/proxy-download?id=<id сценарію>`.
   **Посилання не передається з клієнта** — бекенд бере `scenario_url` із БД. Інакше цей
   ендпоінт був би відкритим релеєм для будь-якого об'єкта на дозволених хостах.
3. Бекенд перетворює sharing-посилання на пряме посилання для завантаження.
4. Бекенд завантажує ZIP на сервері (де немає CORS) і стрімить клієнту.
5. Для великих файлів (>100MB) бекенд автоматично обробляє сторінку підтвердження Google.

Захист проксі: редіректи обробляються вручну з перевіркою хоста **на кожному кроці** (максимум 5),
таймаут на заголовки, ліміт розміру відповіді, перевірка `Content-Type` (тільки архіви) та
обмеження частоти запитів.

### Вимоги до файлів на Google Drive

- Файл **повинен бути публічним** (доступ за посиланням).
- В базі зберігається звичайне sharing-посилання: `https://drive.google.com/file/d/FILE_ID/view?usp=sharing`.
- Бекенд автоматично перетворює його в пряме посилання для завантаження.

### Дозволені домени

З міркувань безпеки проксі дозволяє завантаження тільки з:
- `drive.google.com`
- `docs.google.com`
- `storage.googleapis.com`

Щоб додати інші домени, потрібно змінити масив `allowedDomains` в `backend/server.js`.

---

## Управління

### Корисні команди

```bash
# Запуск
docker compose up --build -d

# Зупинка
docker compose down

# Зупинка + видалення даних БД
docker compose down -v

# Перезапуск бекенду (після зміни server.js)
docker compose restart backend

# Перезбірка фронтенду (після зміни Angular-коду)
docker compose up --build frontend -d

# Логи всіх сервісів
docker compose logs -f

# Логи тільки бекенду
docker compose logs -f backend

# Підключення до БД
docker compose exec database psql -U lab_user -d virtual_lab
```

> Імена сервісів у compose: `database`, `backend`, `frontend`.

### SQL-запити для управління

```sql
-- Переглянути всі сценарії
SELECT id, title, category, is_published FROM scenarios;

-- Сховати сценарій (не видаляючи)
UPDATE scenarios SET is_published = false WHERE id = 'some-id';

-- Показати знову
UPDATE scenarios SET is_published = true WHERE id = 'some-id';

-- Змінити посилання на ZIP
UPDATE scenarios SET scenario_url = 'https://drive.google.com/...' WHERE id = 'solar-system';

-- Додати категорію (просто додати сценарій з новою категорією)
INSERT INTO scenarios (id, title, category, category_label, description)
VALUES ('test', 'Тест', 'math', 'Математика', 'Опис');
```

---

## Технології

| Компонент | Технологія | Версія |
|-----------|------------|--------|
| Frontend | Angular | 21 |
| 3D-движок | WebEngineTS (Three.js) | 0.1.0 |
| Backend | Express.js | 4.21 |
| База даних | PostgreSQL | 16 |
| Web-сервер | nginx | alpine |
| Контейнеризація | Docker Compose | v2 |
| Мова | TypeScript / JavaScript | 5.9 / ES2022 |

---

## Залежності

### Для збірки (build-time, всередині Docker)
- Node.js 20
- npm 11.6+
- Angular CLI 21
- Файл WebEngineTS-0.1.0.tgz

### Для запуску (runtime)
- Docker + Docker Compose — більше нічого
- Сервер не потребує Node.js, npm, або будь-чого іншого — все всередині контейнерів

### Для кінцевого користувача (браузер)
- Сучасний браузер з підтримкою WebGL 2.0 та ES Modules
- Chrome 90+, Firefox 90+, Edge 90+, Safari 15+
