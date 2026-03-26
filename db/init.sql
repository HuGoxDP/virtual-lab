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
    'four-stroke-engine',
    'Чотиритактний Двигун',
    'Детальна 3D-візуалізація термодинамічних циклів двигуна внутрішнього згоряння (цикл Отто).',
    E'Цей навчальний сценарій присвячено вивченню принципів роботи двигуна внутрішнього згоряння.\n\nСтуденти мають можливість:\n• Спостерігати за рухом поршнів та роботою клапанів у розрізі.\n• Керувати швидкістю обертів колінчастого вала (RPM).',
    'physics',
    'Фізика',
    'https://images.unsplash.com/photo-1581093450021-4a7360e9a6b5?q=80&w=800&auto=format&fit=crop',
    '',
    '1.0.0',
    'KSU Physics Lab'
  ),
  (
    'animal-cell',
    'Будова Тваринної Клітини',
    'Інтерактивний атлас клітинних органел. Вивчення структури мембрани, ядра та мітохондрій.',
    E'Лабораторна робота з цитології. Сценарій дозволяє зануритися всередину еукаріотичної клітини.\n\nОсновні можливості:\n• Інтерактивний огляд органел: ЕПР, апарат Гольджі, лізосоми.\n• Анімація процесів транспорту речовин через мембрану.',
    'biology',
    'Біологія',
    'https://images.unsplash.com/photo-1576086213369-97a306d36557?q=80&w=800&auto=format&fit=crop',
    '',
    '1.0.0',
    'KSU Biology Lab'
  ),
  (
    'ancient-architecture',
    'Антична Архітектура',
    'Історична реконструкція архітектурного ансамблю Акрополя 5 століття до н.е.',
    E'Занурення в атмосферу Стародавньої Греції. Реконструкція базується на археологічних даних.\n\nВи зможете прогулятися навколо Парфенона у його первісному вигляді та дізнатися про архітектурні ордери.',
    'history',
    'Історія',
    'https://images.unsplash.com/photo-1555664424-778a18433566?q=80&w=800&auto=format&fit=crop',
    '',
    '1.0.0',
    'KSU History Dept'
  ),
  (
    'chemical-reactions',
    'Хімічні Реакції',
    'Візуалізація молекулярних зв''язків та агрегатних станів речовин.',
    E'Дослідження властивостей хімічних елементів. Симуляція показує, як поводяться молекули при зміні температури та тиску.',
    'chemistry',
    'Хімія',
    'https://images.unsplash.com/photo-1532094349884-543bc11b234d?q=80&w=800&auto=format&fit=crop',
    '',
    '1.0.0',
    'KSU Chemistry Lab'
  )
ON CONFLICT (id) DO NOTHING;
