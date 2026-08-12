-- db/init.sql
-- Выполняется автоматически при первом запуске PostgreSQL

-- ══════════════════════════════════════════════════════
-- ТАБЛИЦА СЦЕНАРИЕВ
-- ══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scenarios (
    id              VARCHAR(100)  PRIMARY KEY,
    title           VARCHAR(255)  NOT NULL,
    description     TEXT          NOT NULL DEFAULT '',
    full_description TEXT         NOT NULL DEFAULT '',
    category        VARCHAR(50)   NOT NULL,
    category_label  VARCHAR(100)  NOT NULL,
    image_url       TEXT          NOT NULL DEFAULT '',
    scenario_url    TEXT          NOT NULL DEFAULT '',
    version         VARCHAR(20)   DEFAULT '1.0.0',
    author          VARCHAR(255),
    upload_date     TIMESTAMPTZ   DEFAULT NOW(),
    is_published    BOOLEAN       DEFAULT true,

    created_at      TIMESTAMPTZ   DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- Индекс для фильтрации по категории
CREATE INDEX IF NOT EXISTS idx_scenarios_category ON scenarios(category);

-- ══════════════════════════════════════════════════════
-- НАЧАЛЬНЫЕ ДАННЫЕ (seed) — их здесь нет, и это намеренно
-- ══════════════════════════════════════════════════════
--
-- Раньше здесь лежали четыре строки со ссылками на Google Drive. Они удалены:
--
--   * архивы теперь хранятся локально и адресуются по содержимому
--     (`/scenarios/<sha256>.zip`), а SQL не может положить файл на том, поэтому
--     засеять рабочую строку отсюда всё равно невозможно — она указывала бы в
--     никуда;
--   * ссылки на Drive — ровно то, от чего уходит платформа;
--   * два id содержали пробел, который попадал в URL `/play/:id`.
--
-- Каталог наполняется из релиза ScenarioCreator:
--
--   cd backend && npm run publish:release -- --release <dir>
--
-- Метаданные (предмет, видимость) — `backend/scripts/catalog-metadata.mjs`;
-- название, описание и версия берутся из manifest.json внутри архива.
--
-- Пустой каталог на свежей установке — корректное состояние, а не сбой.
