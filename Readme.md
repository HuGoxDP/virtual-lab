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
3. Студент натискає «Запустити» → Angular завантажує ZIP-сценарій. Якщо ZIP на Google Drive — запит іде через `GET /api/proxy-download?url=...` → Express завантажує файл із Google Drive (обхід CORS) → стрімить клієнту.
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

### Змінні середовища (docker-compose.yml)

| Змінна | Значення | Опис |
|--------|----------|------|
| POSTGRES_DB | virtual_lab | Назва бази даних |
| POSTGRES_USER | lab_user | Користувач БД |
| POSTGRES_PASSWORD | lab_secret_123 | Пароль БД (змінити в проді!) |
| PORT | 3000 | Порт Express (внутрішній) |

### Безпека для production

В `docker-compose.yml`:
1. Змінити `POSTGRES_PASSWORD` на надійний пароль.
2. Видалити рядки `ports: - "5432:5432"` та `ports: - "3000:3000"` — вони потрібні лише для дебагу. Nginx і так проксірує API, а прямий доступ до БД ззовні небезпечний.

---

## API-ендпоінти

| Метод | URL | Опис |
|-------|-----|------|
| GET | /api/catalog | Список усіх сценаріїв (формат ScenarioCatalogManifest) |
| GET | /api/catalog/:id | Один сценарій за ID |
| POST | /api/catalog | Додати новий сценарій |
| DELETE | /api/catalog/:id | Видалити сценарій |
| GET | /api/proxy-download?url=... | Проксі для завантаження ZIP із Google Drive |
| GET | /api/health | Перевірка стану сервера та БД |

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
  ]
}
```

### Додавання сценарію (POST /api/catalog)

```bash
curl -X POST http://localhost/api/catalog \
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

### Як це працює

Браузер не може завантажити файл напряму з Google Drive через CORS-обмеження. Тому:

1. Фронтенд бачить, що `scenarioUrl` — зовнішнє посилання (не `/assets/...`).
2. Замість прямого `fetch()` він викликає бекенд: `GET /api/proxy-download?url=<google-drive-url>`.
3. Бекенд перетворює sharing-посилання на пряме посилання для завантаження.
4. Бекенд завантажує ZIP на сервері (де немає CORS) і стрімить клієнту.
5. Для великих файлів (>100MB) бекенд автоматично обробляє сторінку підтвердження Google.

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
docker compose restart api

# Перезбірка фронтенду (після зміни Angular-коду)
docker compose up --build web -d

# Логи всіх сервісів
docker compose logs -f

# Логи тільки бекенду
docker compose logs -f api

# Підключення до БД
docker compose exec db psql -U lab_user -d virtual_lab
```

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
