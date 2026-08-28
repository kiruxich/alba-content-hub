import { createClient } from '@libsql/client';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeClient() {
    const url = process.env.TURSO_DATABASE_URL;
    if (url) {
        // Production (Vercel) and any dev session pointed at a real Turso db.
        return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
    }
    // Local dev fallback: a file-based libSQL db, no Turso account needed.
    // Vercel's filesystem is read-only/ephemeral per invocation, so this branch
    // must never be reached in production - set TURSO_DATABASE_URL there.
    const dataDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    return createClient({ url: `file:${path.join(dataDir, 'alba-content-hub.db')}` });
}

export const db = makeClient();

await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    desc TEXT DEFAULT '',
    format TEXT DEFAULT 'TG Пост',
    funnel TEXT DEFAULT 'TOFU',
    status TEXT DEFAULT 'idea',
    cta TEXT DEFAULT '',
    target_groups TEXT DEFAULT '[]',
    metrics_views INTEGER DEFAULT 0,
    metrics_saves INTEGER DEFAULT 0,
    metrics_clicks INTEGER DEFAULT 0,
    metrics_leads INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ideas_title ON ideas(title);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);

CREATE TABLE IF NOT EXISTS scheduled_events (
    id INTEGER PRIMARY KEY,
    idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    date_str TEXT,
    raw_date TEXT NOT NULL,
    color TEXT,
    format TEXT,
    cta TEXT,
    desc TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_raw_date ON scheduled_events(raw_date);

CREATE TABLE IF NOT EXISTS plan_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    daily INTEGER NOT NULL DEFAULT 1,
    weekly INTEGER NOT NULL DEFAULT 7
);
INSERT OR IGNORE INTO plan_settings (id, daily, weekly) VALUES (1, 1, 7);

CREATE TABLE IF NOT EXISTS telegram_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT DEFAULT '',
    chat_id TEXT DEFAULT ''
);
INSERT OR IGNORE INTO telegram_settings (id, token, chat_id) VALUES (1, '', '');

CREATE TABLE IF NOT EXISTS content_plan (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    blocks TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS niches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subtitle TEXT DEFAULT '',
    sections TEXT DEFAULT '[]',
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS project_info (
    product_id TEXT PRIMARY KEY,
    about TEXT DEFAULT ''
);
`);

// Seed content_plan once with the studio's actual annual plan, shaped for the
// quarterly-timeline UI: 'note' blocks are global strategy cards, 'quarter'
// blocks render as a horizontal roadmap ordered by array position.
// INSERT OR IGNORE is a no-op once row id=1 exists, so this never overwrites
// later edits - see server/routes/contentPlan.js for the one-time migration
// that upgrades any pre-timeline (flat, kind-less) blocks still on disk.
const defaultContentPlanBlocks = [
    {
        id: 'goal', kind: 'note', title: 'Главная бизнес-цель', color: '#0a84ff',
        text: 'Получение квалифицированных лидов (SQL) на заказную веб-разработку и сложные IT-системы.',
    },
    {
        id: 'distribution', kind: 'note', title: 'Модель дистрибуции (Content Multiplier)', color: '#bf5af2',
        text: '1 идея → Shorts / Reels / ВК Клипы → Threads → Telegram-канал с закрепом → Сайт alba-creation.ru / Лид-бот',
    },
    {
        id: 'prompt', kind: 'note', title: 'Промпт-шаблон для Claude (еженедельный генератор сценариев)', color: '#ff375f',
        text: 'Действуй как Chief Marketing Officer IT-студии Alba Creation. Нам нужно создать сценарий для short-video (30-45 сек) и текстовый пост для Telegram/Threads.\n\n- Продукт недели: [Укажи продукт текущего квартала]\n- Тема: [Укажи тему дня из матрицы]\n- Целевая аудитория: Владельцы бизнеса и ЛПР, ценящие окупаемость, безопасность и скорость.\n- Тон: Экспертный, без воды, без погружения в хардкорный код, на языке бизнес-метрик и ROI.\n- Структура:\n  1. Хук (первые 3 секунды, цепляющий боль или цифру).\n  2. Проблема (почему традиционные методы не работают).\n  3. Решение (как Alba Creation или наш продукт закрывает эту задачу).\n  4. CTA (призыв перейти в Telegram-канал за бесплатным аудитом/демо).',
    },
    {
        id: 'q1', kind: 'quarter', title: 'ДУЭТ', period: 'Январь — Март', color: '#bf5af2',
        text: 'Смысловой вектор: Веб-инфраструктура, скорость запуска сайтов, замена устаревшим конструкторам.\n\nB2B-оффер: Бесплатный аудит скорости и конверсии текущего сайта клиента + демо ДУЭТ.',
    },
    {
        id: 'q2', kind: 'quarter', title: 'InSights', period: 'Апрель — Июнь', color: '#0a84ff',
        text: 'Смысловой вектор: Сквозная аналитика, оцифровка показателей, принятие решений на основе данных.\n\nB2B-оффер: Экспресс-разбор системы аналитики бизнеса и поиск слепых зон в воронке.',
    },
    {
        id: 'q3', kind: 'quarter', title: '«Хранитель»', period: 'Июль — Сентябрь', color: '#30d158',
        text: 'Смысловой вектор: Автономные ИИ-архивы в закрытом контуре (152-ФЗ), безопасность данных, мгновенный RAG-поиск.\n\nB2B-оффер: Расчёт экономии человеко-часов и стоимости развёртывания On-Premise / Cloud.',
    },
    {
        id: 'q4', kind: 'quarter', title: 'Crista & Фантазия', period: 'Октябрь — Декабрь', color: '#ff9f0a',
        text: 'Смысловой вектор: Геймдев-бэкстейдж, виральный визуал, сложная 3D-графика и интерактивные WebGL-интерфейсы.\n\nB2B-оффер: Разработка иммерсивных промо-сайтов и сложных нестандартных сервисов под ключ.',
    },
];
await db.execute({
    sql: 'INSERT OR IGNORE INTO content_plan (id, blocks) VALUES (1, ?)',
    args: [JSON.stringify(defaultContentPlanBlocks)],
});

// Seed "О проекте" starters. Alba Creation gets a real description pulled
// from alba-creation.ru; the other (fictional demo) products get a short
// starter derived from their existing productsData fields for the user to
// expand on later.
const defaultProjectInfo = {
    'alba-creation': 'Alba Creation — цифровая студия, работающая в формате remote-first и создающая IT-решения для бизнеса в России и за рубежом: боты, сайты, приложения и целые цифровые экосистемы.\n\nПодход студии — превращать бизнес-задачу в тот формат, который решает её быстрее всего: иногда это Telegram-бот, иногда полноценный сайт или личный кабинет, иногда мини-игра.\n\nОсновные направления:\n— Экосистемы: платформы, боты, личные кабинеты и автоматизация\n— Решения для бизнеса: внутренние инструменты под специфику конкретной компании\n— Сайты: разработка с нуля и редизайн устаревших проектов\n— Игры: от полноценных шутеров до мини-игр в Telegram\n— Партнёрские проекты: реальные кейсы с визуальной презентацией\n\nВсе проекты в портфолио — это реальные продакшен-запуски, а не пилоты. Студия работает с клиентом до результата.\n\nКонтакты: @albacreation в Telegram, +7 (915) 495-42-93.',
    'insights': 'InSights — SaaS-платформа для анализа социальных сетей с использованием ИИ. Помогает маркетологам и B2B-клиентам находить релевантных блогеров и оценивать их аудиторию через AI-скоринг, экономя часы ручного подбора инфлюенсеров.',
    'hranitel': 'Хранитель — RAG-система для работы с корпоративными архивами в закрытом контуре, без выхода в интернет. Позволяет находить нужный документ по смыслу за секунды вместо ручного перебора сканов, что особенно критично для Enterprise и госсектора.',
    'duet': 'ДУЭТ — система автоматизации расписаний для образовательных учреждений. Убирает рутину и конфликты в сетке занятий, которые обычно ложатся на завучей и администрацию школ.',
    'crista': 'Crista — CRM для сегмента HoReCa (рестораны, отели), решающая проблему пропущенных бронирований и разрозненной коммуникации с гостями.',
    'fantaziya': 'Фантазия — сервис умных витрин с AI-рекомендациями для интернet-магазинов, подбирающий товары под интерес конкретного покупателя в реальном времени.',
    'legitagent': 'legitAgent — набор open-source npm-пакетов и CLI-инструментов для фронтенд-разработчиков, служащий точкой входа для знакомства разработчиков со студией.',
};
for (const [productId, about] of Object.entries(defaultProjectInfo)) {
    await db.execute({
        sql: 'INSERT OR IGNORE INTO project_info (product_id, about) VALUES (?, ?)',
        args: [productId, about],
    });
}

// Seed the first niche script as requested: cold-call script for building
// websites for hookah lounges. INSERT OR IGNORE on a fixed id keeps this
// idempotent across restarts without clobbering later edits.
const defaultNicheSections = [
    {
        id: 'opener', heading: 'Приветствие',
        text: 'Добрый день! Меня зовут [Ваше имя], я представляю веб-студию Alba Creation. Звоню в [название заведения] — подскажите, как к вам лучше обращаться? Есть пара минут? Хочу рассказать про идею, которая может привести вам новых гостей уже в эти выходные.',
    },
    {
        id: 'qualify', heading: 'Квалификация',
        text: '1. У вас сейчас есть отдельный сайт, или гости узнают о вас только через Instagram и 2ГИС/Яндекс.Карты?\n2. Как гости обычно бронируют столик — звонят, пишут в директ, или просто приходят?\n3. Бывает, что вечером в пятницу-субботу все столы заняты, и гости, которые не дозвонились, уезжают к конкурентам?\n4. Часто обновляете меню миксов? Успеваете доносить это до гостей?',
    },
    {
        id: 'pain', heading: 'Боль',
        text: 'Смотрите, в чём проблема: когда человек ищет кальянную в своём районе, он в 90% случаев сначала гуглит или смотрит Яндекс.Карты. Если там нет сайта — только страница в Instagram с разрозненными сторис — он не видит актуальное меню, цены, атмосферу и просто уходит к тому заведению, у которого сайт есть. Вы теряете гостя, даже не узнав о нём.',
    },
    {
        id: 'pitch', heading: 'Оффер / Питч',
        text: 'Мы в Alba Creation делаем сайты именно под кальянные:\n— Онлайн-меню миксов с фото и ценами, которое вы сами обновляете за 2 минуты\n— Онлайн-бронирование стола прямо с сайта или через Telegram-бота — без пропущенных звонков\n— Галерея интерьера и атмосферы, чтобы гость «прогрелся» ещё до визита\n— Интеграция с Яндекс.Картами, 2ГИС и отзывами\n— Адаптация под телефон — большинство гостей ищут вас с мобильного вечером\n\nОбычно сайт под ключ занимает 7–10 дней, всю техническую часть берём на себя.',
    },
    {
        id: 'objections', heading: 'Обработка возражений',
        text: '«У нас есть Instagram, зачем ещё сайт?» — Инста отлично работает на охват и картинку, но не даёт гостю за 10 секунд посмотреть меню и сразу забронировать стол — сайт закрывает именно эту задачу и работает как витрина 24/7, даже когда вы не постите сторис.\n\n«Это дорого» — Понимаю, давайте посчитаем: во сколько вам обходится один гость с рекламы? Сайт — разовая инвестиция, которая удерживает тех, кто УЖЕ вас искал, но не смог найти информацию или забронировать — это самая дешёвая аудитория, которую вы сейчас просто теряете.\n\n«Нет времени этим заниматься» — Мы понимаем, что у вас заведение, а не диджитал-агентство, поэтому всё делаем сами: от вас нужны только фото и меню, весь процесс занимает у вас максимум час суммарно.\n\n«Надо подумать» — Конечно. Давайте вышлю 2-3 примера готовых сайтов для кальянных, вы посмотрите в удобное время — и созвонимся, например, в четверг на 10 минут, чтобы обсудить детали?',
    },
    {
        id: 'close', heading: 'Закрытие',
        text: 'Отлично, тогда сейчас вышлю примеры работ в Telegram/WhatsApp — на какой номер удобнее? И давайте сразу зафиксируем короткий созвон на [день], чтобы я показал, как именно это будет выглядеть для вашего заведения.',
    },
];
await db.execute({
    sql: 'INSERT OR IGNORE INTO niches (id, name, subtitle, sections) VALUES (?, ?, ?, ?)',
    args: ['kalyannye', 'Кальянные', 'Создание сайтов для кальянных лаунджей', JSON.stringify(defaultNicheSections)],
});
