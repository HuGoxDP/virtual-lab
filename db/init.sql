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
-- НАЧАЛЬНЫЕ ДАННЫЕ (seed)
-- ══════════════════════════════════════════════════════

INSERT INTO scenarios (id, title, description, full_description, category, category_label, image_url, scenario_url, version, author)
VALUES
  (
    'solar-system',
    'Сонячна Система',
    'Масштабна модель нашої планетарної системи. Орбіти планет, пояс астероїдів та супутники.',
    E'Вирушайте у віртуальну подорож Сонячною системою. Цей сценарій демонструє реальні співвідношення розмірів планет.\n\nФункціонал:\n• Переміщення камери, зупинка часу',
    'astronomy',
    'Астрономія',
    'https://images.unsplash.com/photo-1614730341194-75c607ae82b3?q=80&w=800&auto=format&fit=crop',
    'https://drive.google.com/file/d/1fGK4yN3VZnvRN9oPV-rVJckK3qrb98eC/view?usp=sharing',
    '1.0.0',
    'HuGox'
  ),
  (
    'Benchscene1_primitives',
    'Сцена з примітивами',
    '',
    E'',
    'test',
    'Test',
    '',
    'https://drive.google.com/file/d/1-wqMBqbPwYh1RfSwWZK8ZOPXa7_2LTCn/view?usp=sharing',
    '1.0.0',
    'HuGox'
  ),
  (
    'Benchscene2 complexmodel',
    'Сцена з комплексною моделею',
    '',
    E'',
    'test',
    'Test',
    '',
    'https://drive.google.com/file/d/1-wqMBqbPwYh1RfSwWZK8ZOPXa7_2LTCn/view?usp=sharing',
    '1.0.0',
    'HuGox'
  ),  (
    'Benchscene3 solarsystem',
    'Сцена з сонячною системою',
    '',
    E'',
    'test',
    'Test',
    '',
    'https://drive.google.com/file/d/1-wqMBqbPwYh1RfSwWZK8ZOPXa7_2LTCn/view?usp=sharing',
    '1.0.0',
    'HuGox'
  )


ON CONFLICT (id) DO NOTHING;
