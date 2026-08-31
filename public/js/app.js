// --- ВСТРОЕННЫЕ ДАННЫЕ ПРОДУКТОВ (статическая конфигурация студии, не хранится в БД) ---
// target/value остаются здесь только как fallback на случай, если DB-запись
// (project_info.target_audience / value_proposition) ещё не загрузилась или
// для продукта нет строки в БД - см. projectInfoField() в этом файле. Основной
// источник правды для ЦА/посыла (и roadmap) теперь БД, см. server/db.js.
const productsData = [
    { id: 'insights', title: 'InSights', badge: 'Аналитика', badgeBg: 'rgba(10,132,255,0.15)', badgeColor: '#0a84ff', target: 'B2B, Маркетологи', value: 'Поиск блогеров и AI-скоринг', desc: 'SaaS платформа для анализа соцсетей с ИИ', synergies: [{ target: 'Alba Creation', type: 'Апсейл', text: 'B2B-клиенты InSights, которым нужна кастомная доработка платформы, ведутся на full-stack услуги студии' }] },
    { id: 'hranitel', title: 'Хранитель', badge: 'Документооборот', badgeBg: 'rgba(48,209,88,0.15)', badgeColor: '#30d158', target: 'Enterprise, Госсектор', value: 'Поиск по сканам в закрытом контуре', desc: 'RAG-система для работы с архивами', synergies: [{ target: 'Alba Creation', type: 'Апсейл', text: 'Enterprise-клиенты Хранителя конвертируются в контракты на доп. интеграции и поддержку от студии' }] },
    { id: 'duet', title: 'ДУЭТ', badge: 'Event Tech', badgeBg: 'rgba(191,90,242,0.15)', badgeColor: '#bf5af2', target: 'Молодожёны, ивент-агентства', value: 'Генерация сайтов и приглашений', desc: 'SaaS-конструктор сайтов-приглашений для свадеб и мероприятий', synergies: [{ target: 'legitAgent', type: 'Кросс-промо', text: 'Разработчики ДУЭТ используют open-source инструментарий legitAgent для проверки шаблонов сайтов на юридическое соответствие' }] },
    { id: 'crista', title: 'Crista', badge: 'Travel Tech', badgeBg: 'rgba(255,159,10,0.15)', badgeColor: '#ff9f0a', target: 'Путешественники, B2C', value: 'Геймификация планирования поездок', desc: 'Геймифицированное приложение для планирования путешествий', synergies: [] },
    { id: 'fantaziya', title: 'Фантазия', badge: 'Gamedev', badgeBg: 'rgba(255,55,95,0.15)', badgeColor: '#ff375f', target: 'Игроки, поклонники Pyrokinesis', value: 'Нарративный экшен-RPG по мотивам Pyrokinesis', desc: 'Сюжетная игра от первого лица на Godot: детектив Керриган, теневое измерение Изанка, 75+ квестов', synergies: [] },
    { id: 'legitagent', title: 'legitAgent', badge: 'Open Source', badgeBg: 'rgba(100,210,255,0.15)', badgeColor: '#64d2ff', target: 'Разработчики, веб-студии', value: 'Автопроверка сайта на 152-ФЗ/38-ФЗ/ЗоЗПП', desc: 'Сканер юридического соответствия сайтов + нагрузочное тестирование', synergies: [{ target: 'Alba Creation', type: 'Лид-магнит', text: 'Разработчики, познакомившиеся с open-source инструментами, заказывают кастомную разработку у студии' }] },
    { id: 'alba-creation', title: 'Alba Creation', badge: 'Студия', badgeBg: 'rgba(94,92,230,0.15)', badgeColor: '#5e5ce6', target: 'Все клиенты', value: 'Full-stack разработка', desc: 'Цифровая веб-студия полного цикла', synergies: [] }
];

let ideasBank = [];
let scheduledEvents = [];
let tgMeta = { chatId: '', hasToken: false, tokenPreview: '' };
let vkMeta = { groupId: '', hasToken: false, tokenPreview: '' };
let igMeta = { businessAccountId: '', hasToken: false, tokenPreview: '' };
let ytMeta = { clientId: '', channelTitle: '', hasClientSecret: false, hasRefreshToken: false, configured: false };
let thMeta = { userId: '', hasToken: false, tokenPreview: '' };
let pinMeta = { defaultBoardId: '', hasToken: false, tokenPreview: '' };
let telegramChannels = []; // [{ id, label, chatId }] - see server/routes/settings.js /telegram-channels
let pinterestBoards = []; // [{ id, name }] - see server/routes/settings.js /pinterest/boards
let publishModalState = { ideaId: null, platform: 'telegram', lang: 'ru', channelId: null, boardId: null };
let planSettings = { daily: 1, weekly: 7 };
let currentSelectedIdea = null;
let currentOpenProductId = null;
let contentPlanBlocks = [];
let niches = [];
let currentOpenNicheId = null;
let projectInfo = {};
let currentOpenDay = null;
let agentSettings = { weeklySchedule: [], postFormula: '' };
let contentRubrics = [];

function escapeHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener("DOMContentLoaded", () => {
    initApp();
    const schedInput = document.getElementById('schedule-date-input');
    if (schedInput) schedInput.value = new Date().toISOString().split('T')[0];
});

// --- API-КЛИЕНТ (все данные живут в SQLite на сервере, см. server/) ---
async function api(path, options = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (!res.ok) {
        let message = res.statusText;
        try { message = (await res.json()).error || message; } catch (_) {}
        throw new Error(message);
    }
    if (res.status === 204) return null;
    return res.json();
}

// ИНИЦИАЛИЗАЦИЯ: подтягиваем состояние с бэкенда вместо localStorage
async function initApp() {
    try {
        const [ideas, events, plan, telegram, vk, instagram, youtube, threads, contentPlan, nichesList, projectInfoMap, agentSettingsData, rubrics] = await Promise.all([
            api('/api/ideas'),
            api('/api/events'),
            api('/api/settings/plan'),
            api('/api/settings/telegram'),
            api('/api/settings/vk'),
            api('/api/settings/instagram'),
            api('/api/settings/youtube'),
            api('/api/settings/threads'),
            api('/api/content-plan'),
            api('/api/niches'),
            api('/api/project-info'),
            api('/api/agent-settings'),
            api('/api/content-rubrics?all=1'),
        ]);
        ideasBank = ideas;
        scheduledEvents = events;
        planSettings = plan;
        tgMeta = telegram;
        vkMeta = vk;
        igMeta = instagram;
        ytMeta = youtube;
        thMeta = threads;
        contentPlanBlocks = contentPlan.blocks;
        niches = nichesList;
        projectInfo = projectInfoMap;
        agentSettings = agentSettingsData;
        contentRubrics = rubrics;

        const dailyInput = document.getElementById('plan-daily-input');
        const weeklyInput = document.getElementById('plan-weekly-input');
        if (dailyInput) dailyInput.value = planSettings.daily;
        if (weeklyInput) weeklyInput.value = planSettings.weekly;

        renderProductsGrid();
        renderMatrixView();
        renderCalendar();
        renderKanbanView();
        renderAnalyticsView();
        renderContentPlan();
        renderClientsView();
        await renderBankView();
        updatePlanProgress();
    } catch (e) {
        console.error("Не удалось загрузить данные с сервера:", e);
        showToast('Нет связи с сервером. Запустите backend: pnpm run server');
    }
}

// УПРАВЛЕНИЕ ИНТЕРФЕЙСОМ И НАВИГАЦИЯ
function switchTab(tabName) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));

    const targetView = document.getElementById(`view-${tabName}`);
    if (targetView) targetView.classList.add('active');

    const tabMap = { 'products': 0, 'contentcreation': 1, 'bank': 2, 'kanban': 3, 'analytics': 4, 'graph': 5, 'calendar': 6, 'contentplan': 7, 'clients': 8, 'customers': 9, 'mediaassets': 10, 'urlchecker': 11, 'systeminfo': 12, 'agentcenter': 13 };
    if (tabMap[tabName] !== undefined) {
        const tabs = document.querySelectorAll('.tab-item');
        if (tabs[tabMap[tabName]]) tabs[tabMap[tabName]].classList.add('active');
    }

    if (tabName === 'contentcreation') renderContentCreationView();
    if (tabName === 'kanban') renderKanbanView();
    if (tabName === 'analytics') renderAnalyticsView();
    if (tabName === 'calendar') {
        renderCalendar();
        checkFunnelBalance();
    }
    if (tabName === 'contentplan') renderContentPlan();
    if (tabName === 'clients') renderClientsView();
    if (tabName === 'customers') renderParserNiches();
    if (tabName === 'mediaassets') renderMediaAssets();
    if (tabName === 'agentcenter') { renderAgentSettingsForm(); renderAgentCenter(); }
}

function openOverlay(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
}

function closeOverlay(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
}

function showToast(text) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerText = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

// Visible progress ticker for slow AI-generation requests (kie.ai covers/video
// can take up to ~3-7 minutes, ElevenLabs/Piper voiceovers a few seconds) -
// without this the UI was just a disabled button with a static "Генерируем…"
// label for the whole duration, which reads as broken/frozen on anything
// slower than a couple seconds. `stages` is [{afterSeconds, text}, ...],
// sorted ascending; the message shown is the last stage whose afterSeconds
// has elapsed. Returns a `finish(ok, message)` callback to stop the ticker
// and show a final success/error line - callers must call it exactly once.
function startGenerationTicker(statusElId, stages) {
    const el = document.getElementById(statusElId);
    if (!el) return () => {};
    const startedAt = Date.now();
    el.style.display = 'flex';
    el.classList.remove('error', 'success');

    function render() {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        const stage = [...stages].reverse().find(s => elapsed >= s.afterSeconds) || stages[0];
        el.innerHTML = `<span class="gs-dot"></span><span>${escapeHtml(stage.text)} (${elapsed}с)</span>`;
    }
    render();
    const intervalId = setInterval(render, 1000);

    return function finish(ok, message) {
        clearInterval(intervalId);
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        el.classList.add(ok ? 'success' : 'error');
        el.innerHTML = `<span class="gs-dot"></span><span>${escapeHtml(message)} (${elapsed}с)</span>`;
        setTimeout(() => { el.style.display = 'none'; }, ok ? 3000 : 6000);
    };
}

// НАСТРОЙКА ПЛАНА ПУБЛИКАЦИЙ И ПРОГРЕСС
async function savePlanSettings() {
    const dailyInput = document.getElementById('plan-daily-input');
    const weeklyInput = document.getElementById('plan-weekly-input');

    const daily = parseInt(dailyInput ? dailyInput.value : 1, 10) || 1;
    const weekly = parseInt(weeklyInput ? weeklyInput.value : 7, 10) || 7;

    try {
        planSettings = await api('/api/settings/plan', { method: 'PUT', body: JSON.stringify({ daily, weekly }) });
        updatePlanProgress();
        renderCalendar();
        showToast('План публикаций сохранен и применен!');
    } catch (e) {
        showToast('Не удалось сохранить план: ' + e.message);
    }
}

function updatePlanProgress() {
    const todayStr = new Date().toISOString().split('T')[0];

    const todayCount = scheduledEvents.filter(e => e.rawDate === todayStr).length;
    const todayPct = Math.min(100, Math.round((todayCount / planSettings.daily) * 100));

    const tText = document.getElementById('today-progress-text');
    const tFill = document.getElementById('today-progress-fill');
    if (tText) tText.innerText = `${todayCount} / ${planSettings.daily} (${todayPct}%)`;
    if (tFill) tFill.style.width = `${todayPct}%`;

    const now = new Date();
    const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - (dayOfWeek - 1));
    startOfWeek.setHours(0,0,0,0);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23,59,59,999);

    const weekCount = scheduledEvents.filter(e => {
        const eDate = new Date(e.rawDate);
        return eDate >= startOfWeek && eDate <= endOfWeek;
    }).length;

    const weekPct = Math.min(100, Math.round((weekCount / planSettings.weekly) * 100));

    const wText = document.getElementById('week-progress-text');
    const wFill = document.getElementById('week-progress-fill');
    if (wText) wText.innerText = `${weekCount} / ${planSettings.weekly} (${weekPct}%)`;
    if (wFill) wFill.style.width = `${weekPct}%`;
}

// БАНК ИДЕЙ (поиск делегирован в SQLite FTS5 на сервере)
async function renderBankView() {
    const countBadge = document.getElementById('tab-bank-count');
    if (countBadge) countBadge.innerText = ideasBank.filter(i => (i.status || 'idea') !== 'idea').length;

    const container = document.getElementById('bank-list-content');
    if (!container) return;

    const searchQuery = (document.getElementById('search-input')?.value || '').trim();

    let filtered;
    if (searchQuery) {
        try {
            filtered = await api(`/api/ideas?q=${encodeURIComponent(searchQuery)}`);
        } catch (e) {
            const q = searchQuery.toLowerCase();
            filtered = ideasBank.filter(i =>
                i.title.toLowerCase().includes(q) ||
                (i.desc && i.desc.toLowerCase().includes(q)) ||
                (i.format && i.format.toLowerCase().includes(q)) ||
                (i.funnel && i.funnel.toLowerCase().includes(q))
            );
        }
    } else {
        filtered = ideasBank;
    }
    // Ideas still at status='idea' are unreviewed drafts (manually created on
    // Создание контента but not yet promoted, or written by the agent
    // Generator and awaiting approval) - they live on that page instead of
    // here. Kanban's own "💡 Идеи" column is untouched by this filter and
    // still shows them - this only narrows this one list view.
    filtered = filtered.filter(i => (i.status || 'idea') !== 'idea');

    if (filtered.length === 0) {
        container.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Идеи не найдены или банк пуст</div>`;
        return;
    }

    let html = '';
    filtered.forEach(idea => {
        const charCount = (idea.desc || '').length;
        const readTime = Math.max(1, Math.ceil(charCount / 500));
        const statusMap = { 'idea': '💡 Идея', 'in_progress': '⚙️ В работе', 'ready': '✅ Готово', 'published': '🚀 Опубликовано' };
        const funnelColor = idea.funnel === 'TOFU' ? '#30d158' : idea.funnel === 'MOFU' ? '#ff9f0a' : '#ff453a';

        html += `
        <div class="idea-card" draggable="true" ondragstart="handleDragStart(event, '${idea.id}')">
            <div class="idea-header">
                <div class="idea-title">${idea.title}</div>
                <div>
                    <span class="funnel-badge" style="background:${funnelColor}22; color:${funnelColor};">${idea.funnel || 'TOFU'}</span>
                    <span class="format-tag">${idea.format || 'TG Пост'}</span>
                </div>
            </div>
            ${idea.desc ? `<div class="idea-desc-text">${idea.desc}</div>` : ''}
            <div class="idea-cta">CTA: ${idea.cta || '—'}</div>

            <div class="meta-stats">
                <span>📏 ${charCount} симв.</span>
                <span>⏱ ~${readTime} мин.</span>
                <span>Статус: <strong>${statusMap[idea.status || 'idea']}</strong></span>
            </div>

            <div style="margin-top:8px; padding-top:8px; border-top:0.5px solid var(--separator);">
                <span style="font-size:11px; color:var(--text-secondary); font-weight:600; text-transform:uppercase;">Продукты:</span>
                <div>`;

        productsData.forEach(p => {
            const isFavorited = idea.targetGroups && idea.targetGroups.includes(p.id);
            html += `
                <button class="group-chip ${isFavorited ? 'active' : ''}" onclick="toggleGroupForIdea('${idea.id}', '${p.id}')">
                    ${isFavorited ? '✓ ' : ''}${p.title}
                </button>`;
        });

        html += `</div>
            </div>

            <div class="action-btn-row">
                <button class="edit-btn" onclick="openEditIdeaModal('${idea.id}')">✏️ Изменить</button>
                <button class="tg-btn" style="background:var(--accent-purple);" onclick="toggleAutogenPanel('${idea.id}')">✨ Медиа (обложка/озвучка/видео)</button>
                <button class="tg-btn" style="background:var(--accent-blue);" onclick="openPublishModal('${idea.id}')">📤 Опубликовать</button>
                <button class="schedule-btn" onclick="openScheduleForIdea('${idea.id}')">📅 В календарь</button>
                <button class="edit-btn" onclick="openMetricsModal('${idea.id}')">📊 ROI</button>
                <button class="delete-btn" onclick="deleteIdea('${idea.id}')">🗑</button>
            </div>
            <div id="idea-gen-status-${idea.id}" class="generation-status" style="display:none;"></div>
            <div id="autogen-panel-${idea.id}" style="display:none; margin-top:10px;"></div>
        </div>`;
    });

    container.innerHTML = html;
}

// СОЗДАНИЕ КОНТЕНТА - генерация с нуля (4 формата из одной темы), затем
// перевод на английский, затем перенос отдельных форматов в Хранилище.
// Черновики хранятся только в памяти вкладки (contentDrafts) до нажатия
// "Добавить в хранилище" - как и раньше при ручном создании идеи, ничего не
// пишется на сервер, пока пользователь явно не решит сохранить конкретный
// формат/язык.
let contentDrafts = [];
const CONTENT_FORMAT_DEFS = [
    { key: 'tgPost', label: 'ТГ Публикация', ideaFormat: 'TG Пост' },
    { key: 'reelsScript', label: 'Сценарий Reels/Shorts', ideaFormat: 'Reels' },
    { key: 'threads', label: 'Threads', ideaFormat: 'Threads' },
    { key: 'pinterest', label: 'Pinterest', ideaFormat: 'Pinterest' },
];

function addContentDraft() {
    contentDrafts.push({
        id: `cd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        topic: '', productId: '',
        status: 'draft', // draft | generating | generated | translating
        activeFormat: 'tgPost', activeLang: 'ru',
        ru: null, en: null,
    });
    renderContentCreationView();
}

function removeContentDraft(id) {
    contentDrafts = contentDrafts.filter(d => d.id !== id);
    renderContentCreationView();
}

function setContentDraftFormat(id, key) {
    const draft = contentDrafts.find(d => d.id === id);
    if (draft) draft.activeFormat = key;
    renderContentCreationView();
}

function setContentDraftLang(id, lang) {
    const draft = contentDrafts.find(d => d.id === id);
    if (draft && (lang === 'ru' || draft.en)) draft.activeLang = lang;
    renderContentCreationView();
}

function setContentDraftBlockField(id, lang, key, field, value) {
    const draft = contentDrafts.find(d => d.id === id);
    if (draft && draft[lang] && draft[lang][key]) draft[lang][key][field] = value;
}

async function generateContentDraft(id) {
    const draft = contentDrafts.find(d => d.id === id);
    if (!draft) return;
    const topicInput = document.getElementById(`cd-topic-${id}`);
    const productSelect = document.getElementById(`cd-product-${id}`);
    draft.topic = topicInput ? topicInput.value.trim() : draft.topic;
    draft.productId = productSelect ? productSelect.value : draft.productId;
    if (!draft.topic) return showToast('Укажите тему');

    draft.status = 'generating';
    renderContentCreationView();
    try {
        draft.ru = await api('/api/content-drafts/generate', { method: 'POST', body: JSON.stringify({ topic: draft.topic, productId: draft.productId || null }) });
        draft.status = 'generated';
        showToast('Черновик сгенерирован');
    } catch (e) {
        draft.status = 'draft';
        showToast('Не удалось сгенерировать: ' + e.message);
    }
    renderContentCreationView();
}

async function translateContentDraft(id) {
    const draft = contentDrafts.find(d => d.id === id);
    if (!draft || !draft.ru) return;
    draft.status = 'translating';
    renderContentCreationView();
    try {
        draft.en = await api('/api/content-drafts/translate', { method: 'POST', body: JSON.stringify({ items: draft.ru }) });
        draft.activeLang = 'en';
        draft.status = 'generated';
        showToast('Переведено на английский');
    } catch (e) {
        draft.status = 'generated';
        showToast('Не удалось перевести: ' + e.message);
    }
    renderContentCreationView();
}

async function promoteContentDraftFormat(id) {
    const draft = contentDrafts.find(d => d.id === id);
    if (!draft) return;
    const formatDef = CONTENT_FORMAT_DEFS.find(f => f.key === draft.activeFormat);
    const ruBlock = draft.ru?.[draft.activeFormat];
    const enBlock = draft.activeLang === 'en' ? draft.en?.[draft.activeFormat] : null;
    if (!ruBlock) return;

    const body = enBlock
        ? { title: ruBlock.title, desc: ruBlock.desc, cta: ruBlock.cta,
            titleEn: enBlock.title, descEn: enBlock.desc, ctaEn: enBlock.cta,
            format: formatDef.ideaFormat, status: 'ready', source: 'manual',
            targetGroups: draft.productId ? [draft.productId] : [] }
        : { title: ruBlock.title, desc: ruBlock.desc, cta: ruBlock.cta,
            format: formatDef.ideaFormat, status: 'ready', source: 'manual',
            targetGroups: draft.productId ? [draft.productId] : [] };

    try {
        const created = await api('/api/ideas', { method: 'POST', body: JSON.stringify(body) });
        ideasBank.push(created);
        renderBankView();
        showToast(`Добавлено в хранилище: ${formatDef.label}${enBlock ? ' (RU+EN)' : ''}`);
    } catch (e) {
        showToast('Не удалось добавить: ' + e.message);
    }
}

function renderContentDraftCard(draft) {
    const isGenerating = draft.status === 'generating';
    const isTranslating = draft.status === 'translating';
    const hasRu = Boolean(draft.ru);
    const hasEn = Boolean(draft.en);
    const lang = draft.activeLang;
    const block = hasRu ? (lang === 'en' ? draft.en?.[draft.activeFormat] : draft.ru[draft.activeFormat]) : null;

    return `
    <div class="idea-card" style="margin-bottom:16px;">
        <div style="display:flex; gap:8px; align-items:flex-start; margin-bottom:10px;">
            <input type="text" class="form-input" style="margin:0;" id="cd-topic-${draft.id}" placeholder="Тема поста..." value="${escapeHtml(draft.topic)}" ${hasRu ? 'readonly' : ''}>
            <select class="form-select" style="margin:0; max-width:220px;" id="cd-product-${draft.id}" ${hasRu ? 'disabled' : ''}>
                <option value="">— без привязки —</option>
                ${productsData.map(p => `<option value="${p.id}" ${draft.productId === p.id ? 'selected' : ''}>${escapeHtml(p.title)}</option>`).join('')}
            </select>
            <button class="delete-btn" onclick="removeContentDraft('${draft.id}')">🗑</button>
        </div>

        ${!hasRu ? `
            <button class="submit-btn" ${isGenerating ? 'disabled' : ''} onclick="generateContentDraft('${draft.id}')">${isGenerating ? '⏳ Генерируем через ИИ (Sonnet)...' : '✨ Сгенерировать 4 формата'}</button>
        ` : `
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;">
                ${CONTENT_FORMAT_DEFS.map(f => `<button class="edit-btn" style="${draft.activeFormat === f.key ? 'background:var(--accent-blue); color:#fff;' : ''}" onclick="setContentDraftFormat('${draft.id}', '${f.key}')">${f.label}</button>`).join('')}
            </div>
            ${hasEn ? `
                <div style="display:flex; gap:6px; margin-bottom:10px;">
                    <button class="edit-btn" style="${lang === 'ru' ? 'background:var(--accent-blue); color:#fff;' : ''}" onclick="setContentDraftLang('${draft.id}', 'ru')">🇷🇺 RU</button>
                    <button class="edit-btn" style="${lang === 'en' ? 'background:var(--accent-blue); color:#fff;' : ''}" onclick="setContentDraftLang('${draft.id}', 'en')">🇬🇧 EN</button>
                </div>` : ''}
            ${block ? `
                <input type="text" class="form-input" value="${escapeHtml(block.title)}" oninput="setContentDraftBlockField('${draft.id}', '${lang}', '${draft.activeFormat}', 'title', this.value)">
                <textarea class="form-textarea" oninput="setContentDraftBlockField('${draft.id}', '${lang}', '${draft.activeFormat}', 'desc', this.value)">${escapeHtml(block.desc)}</textarea>
                <input type="text" class="form-input" placeholder="CTA" value="${escapeHtml(block.cta)}" oninput="setContentDraftBlockField('${draft.id}', '${lang}', '${draft.activeFormat}', 'cta', this.value)">
            ` : ''}
            <div class="action-btn-row">
                ${!hasEn ? `<button class="edit-btn" ${isTranslating ? 'disabled' : ''} onclick="translateContentDraft('${draft.id}')">${isTranslating ? '⏳ Переводим...' : '🇬🇧 Перевести на английский'}</button>` : ''}
                <button class="tg-btn" style="background:var(--accent-blue);" onclick="promoteContentDraftFormat('${draft.id}')">➕ Добавить в хранилище (${lang === 'en' ? 'RU+EN' : 'RU'})</button>
            </div>
        `}
    </div>`;
}

// Всё в статусе 'idea' - и то, что написал агент Generator (source='agent'),
// и любая идея, созданная вручную и ещё не добавленная в Хранилище (source=
// 'manual' - включая идеи, заведённые ещё до этой страницы, которые иначе
// стали бы невидимы: скрыты из Хранилище фильтром в renderBankView(), но не
// на этой странице). idea.id - это строка из Date.now(), так что момент
// создания читается прямо из него, без отдельного поля в API.
function renderAgentContentDrafts() {
    const list = document.getElementById('content-agent-drafts-list');
    if (!list) return;
    const drafts = ideasBank.filter(i => (i.status || 'idea') === 'idea');
    if (drafts.length === 0) {
        list.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Нет черновиков на проверке.</div>`;
        return;
    }
    const todayStr = new Date().toDateString();
    list.innerHTML = drafts.map(idea => {
        const isAgent = idea.source === 'agent';
        const isToday = new Date(Number(idea.id)).toDateString() === todayStr;
        return `
        <div class="idea-card" style="margin-bottom:14px;">
            <div class="idea-header">
                <div class="idea-title">${escapeHtml(idea.title)}</div>
                <div>
                    <span class="format-tag" style="background:${isAgent ? 'rgba(191,90,242,0.15)' : 'rgba(255,255,255,0.08)'}; color:${isAgent ? 'var(--accent-purple)' : 'var(--text-secondary)'};">${isAgent ? `🤖 От генератора${isToday ? ' · сегодня' : ''}` : '✍️ Черновик'}</span>
                    <span class="format-tag">${escapeHtml(idea.format || 'TG Пост')}</span>
                </div>
            </div>
            ${idea.desc ? `<div class="idea-desc-text">${escapeHtml(idea.desc)}</div>` : ''}
            <div class="idea-cta">CTA: ${escapeHtml(idea.cta || '—')}</div>
            <div class="action-btn-row">
                <button class="edit-btn" onclick="openEditIdeaModal('${idea.id}')">✏️ Изменить</button>
                <button class="tg-btn" style="background:var(--accent-blue);" onclick="promoteAgentDraft('${idea.id}')">➕ Добавить в хранилище</button>
                <button class="delete-btn" onclick="deleteIdea('${idea.id}')">🗑 Отклонить</button>
            </div>
        </div>`;
    }).join('');
}

async function promoteAgentDraft(ideaId) {
    try {
        const updated = await api(`/api/ideas/${ideaId}`, { method: 'PUT', body: JSON.stringify({ status: 'ready' }) });
        ideasBank = ideasBank.map(i => i.id === ideaId ? updated : i);
        renderBankView();
        renderContentCreationView();
        showToast('Добавлено в хранилище');
    } catch (e) {
        showToast('Не удалось добавить: ' + e.message);
    }
}

function renderContentCreationView() {
    const list = document.getElementById('content-drafts-list');
    if (list) {
        list.innerHTML = contentDrafts.length === 0
            ? `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Черновиков пока нет — нажмите «+ Новая тема».</div>`
            : contentDrafts.map(renderContentDraftCard).join('');
    }
    renderAgentContentDrafts();
}

// КАНБАН-ДОСКА (DRAG AND DROP)
function renderKanbanView() {
    const container = document.getElementById('kanban-board-container');
    if (!container) return;

    const columns = [
        { id: 'idea', title: '💡 Идеи' },
        { id: 'in_progress', title: '⚙️ В работе' },
        { id: 'ready', title: '✅ Готово' },
        { id: 'published', title: '🚀 Опубликовано' }
    ];

    let html = '';
    columns.forEach(col => {
        const items = ideasBank.filter(i => (i.status || 'idea') === col.id);
        html += `
        <div class="kanban-column" ondragover="allowDrop(event)" ondrop="handleDrop(event, '${col.id}')">
            <div class="kanban-column-header">
                <span>${col.title}</span>
                <span class="kanban-count">${items.length}</span>
            </div>
            <div class="kanban-cards">`;

        items.forEach(idea => {
            html += `
            <div class="kanban-card" draggable="true" ondragstart="handleDragStart(event, '${idea.id}')">
                <div style="font-weight:600; font-size:14px; margin-bottom:4px;">${idea.title}</div>
                <div style="font-size:12px; color:var(--text-secondary); margin-bottom:8px;">${idea.format} • ${idea.funnel || 'TOFU'}</div>
                <button class="edit-btn" style="width:100%; font-size:11px;" onclick="openEditIdeaModal('${idea.id}')">Изменить</button>
            </div>`;
        });

        html += `</div></div>`;
    });

    container.innerHTML = html;
}

function handleDragStart(e, ideaId) {
    e.dataTransfer.setData("text/plain", ideaId);
}

function allowDrop(e) { e.preventDefault(); }

async function handleDrop(e, targetStatus) {
    e.preventDefault();
    const ideaId = e.dataTransfer.getData("text/plain");
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    try {
        const updated = await api(`/api/ideas/${ideaId}`, { method: 'PUT', body: JSON.stringify({ status: targetStatus }) });
        ideasBank = ideasBank.map(i => i.id === ideaId ? updated : i);
        renderKanbanView();
        renderBankView();
        renderContentCreationView();
        showToast(`Статус изменен на ${targetStatus}`);
    } catch (err) {
        showToast('Не удалось изменить статус: ' + err.message);
    }
}

// AI ПРОМПТ ГЕНЕРАТОР
// ДАШБОРД И АНАЛИТИКА
function renderAnalyticsView() {
    const container = document.getElementById('analytics-content');
    if (!container) return;

    let productStats = productsData.map(p => {
        const count = ideasBank.filter(i => i.targetGroups && i.targetGroups.includes(p.id)).length;
        return { title: p.title, count, color: p.badgeColor };
    });

    const formats = ['TG Пост', 'Threads ветка', 'Insta Reels', 'Insta Публикация', 'Insta История', 'YouTube Shorts', 'VK Клип'];
    let formatStats = formats.map(f => {
        const count = ideasBank.filter(i => i.format === f).length;
        return { format: f, count };
    });

    let topROI = [...ideasBank].sort((a,b) => ((b.metrics?.leads || 0) - (a.metrics?.leads || 0))).slice(0, 3);

    let html = `
    <div class="analytics-card">
        <h3>📊 Дашборд баланса продуктов</h3>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">Распределение контент-гипотез по направлениям студии</p>`;

    productStats.forEach(p => {
        const pct = ideasBank.length ? Math.round((p.count / ideasBank.length) * 100) : 0;
        html += `
        <div style="margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:600; margin-bottom:4px;">
                <span>${p.title}</span>
                <span>${p.count} идей (${pct}%)</span>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill" style="width:${pct}%; background:${p.color}"></div>
            </div>
        </div>`;
    });

    html += `</div>

    <div class="analytics-card">
        <h3>🎯 Сплит форматов</h3>
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:10px; margin-top:12px;">`;

    formatStats.forEach(fs => {
        html += `
        <div class="stat-box">
            <div style="font-size:20px; font-weight:700; color:var(--accent-blue);">${fs.count}</div>
            <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">${fs.format}</div>
        </div>`;
    });

    html += `</div></div>

    <div class="analytics-card">
        <h3>🏆 Рейтинг конверсий & ROI (Топ по B2B лидам)</h3>
        <div style="margin-top:10px;">`;

    topROI.forEach((item, idx) => {
        const leads = item.metrics?.leads || 0;
        const clicks = item.metrics?.clicks || 0;
        html += `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:0.5px solid var(--separator);">
            <div>
                <strong>#${idx+1} ${item.title}</strong>
                <div style="font-size:12px; color:var(--text-secondary);">${item.format} • ${item.funnel || 'TOFU'}</div>
            </div>
            <div style="text-align:right;">
                <span class="funnel-badge" style="background:rgba(48,209,88,0.2); color:var(--accent-green); font-size:13px;">🎯 ${leads} лидов</span>
                <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${clicks} кликов</div>
            </div>
        </div>`;
    });

    html += `</div></div>`;
    container.innerHTML = html;
}

// ЭКСПОРТ И TELEGRAM
function copyTelegramFormatted(ideaId) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    const formattedText = `*${idea.title}*\n\n${idea.desc || ''}\n\n👉 _${idea.cta || ''}_\n\n#${(idea.funnel || 'TOFU')} #AlbaCreation`;
    navigator.clipboard.writeText(formattedText);
    showToast('Скопировано с разметкой!');
}

// АВТО-ГЕНЕРАЦИЯ МЕДИА ДЛЯ ИДЕИ ("✨ Сгенерировать" на карточке в Банке идей)
//
// Renders inline right under the idea card (in #autogen-panel-<ideaId>, part
// of the card markup - see renderIdeasBank) rather than a modal, so you keep
// the card's context in view. toggleAutogenPanel() opens/closes it and shows
// the voiceover-provider picker first (ElevenLabs looking "configured" via a
// present API key doesn't mean it actually works - e.g. an unpaid plan 403s
// at call time - so defaulting silently to it and failing was the old,
// confusing behavior). confirmAutoGenerate() then calls
// POST /api/ideas/:id/auto-generate (server/routes/ideas.js), which runs
// cover-image + voiceover generation (and, for 'Reels / Shorts' ideas, a
// shot-list+voiceover script via local-claude-agent, then video + assembly)
// server-side and returns per-step results. Assembly is job-based
// (video-worker), so once that job is kicked off this polls
// GET /api/video-assembly/:jobId the same way parser niches poll their own
// job status (see startParserPolling above) until it reaches done/error.
//
// The "terminal" log is simulated client-side staged progress, not truly
// live server output - the actual generation happens in one blocking
// request server-side, there's no streaming/SSE wired up for it. Framed as
// such (see the log lines below) rather than pretending otherwise.
function toggleAutogenPanel(ideaId) {
    const panel = document.getElementById(`autogen-panel-${ideaId}`);
    if (!panel) return;
    if (panel.style.display === 'none' || !panel.style.display) {
        panel.style.display = '';
        panel.innerHTML = `
            <div class="info-box" style="padding:14px 16px;">
                <label class="form-label" style="margin-top:0; font-size:11px;">Озвучка:</label>
                <select id="autogen-provider-${ideaId}" class="form-select" style="margin-bottom:10px;">
                    <option value="piper">Piper (бесплатно, self-hosted)</option>
                    <option value="elevenlabs">ElevenLabs (платно, выше качество)</option>
                </select>
                <button class="submit-btn" style="margin-top:0;" onclick="confirmAutoGenerate('${ideaId}')">✨ Сгенерировать</button>
            </div>`;
    } else {
        panel.style.display = 'none';
        panel.innerHTML = '';
    }
}

function logToAutogen(ideaId, text) {
    const log = document.getElementById(`autogen-log-${ideaId}`);
    if (!log) return;
    const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
    log.innerHTML += `[${time}] ${escapeHtml(text)}\n`;
    log.scrollTop = log.scrollHeight;
}

async function confirmAutoGenerate(ideaId) {
    const provider = document.getElementById(`autogen-provider-${ideaId}`).value;
    const panel = document.getElementById(`autogen-panel-${ideaId}`);
    panel.innerHTML = `
        <div id="autogen-log-${ideaId}" class="parser-niche-console" style="min-height:70px; margin-bottom:8px;"></div>
        <div id="autogen-result-${ideaId}"></div>`;

    await autoGenerateIdeaMedia(ideaId, provider);
}

async function autoGenerateIdeaMedia(ideaId, voiceoverProvider) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    const statusElId = `idea-gen-status-${ideaId}`;
    const isReels = idea.format === 'Reels / Shorts';
    logToAutogen(ideaId, isReels
        ? 'Запускаем: обложка (kie.ai Flux), сценарий Reels, озвучка…'
        : 'Запускаем: обложка (kie.ai Flux), озвучка…');
    logToAutogen(ideaId, `Провайдер озвучки: ${voiceoverProvider === 'piper' ? 'Piper' : 'ElevenLabs'} (симулированный прогресс — реальный лог сервера сюда не транслируется)`);
    const finishTicker = startGenerationTicker(statusElId, [
        { afterSeconds: 15, text: 'kie.ai и провайдер озвучки всё ещё работают…' },
        { afterSeconds: 90, text: isReels ? 'Обложка и озвучка почти готовы, дальше — видео…' : 'Почти готово…' },
        { afterSeconds: 240, text: 'Видео (kie.ai Kling) может генерироваться до 7 минут…' },
    ]);

    try {
        const result = await api(`/api/ideas/${ideaId}/auto-generate`, { method: 'POST', body: JSON.stringify({ voiceoverProvider }) });
        if (result.idea) {
            ideasBank = ideasBank.map(i => i.id === ideaId ? result.idea : i);
        }

        if (result.cover?.asset) logToAutogen(ideaId, '✅ Обложка готова');
        if (result.cover?.error) logToAutogen(ideaId, '❌ Обложка: ' + result.cover.error);
        if (result.reelsScript) logToAutogen(ideaId, '✅ Сценарий Reels сгенерирован');
        if (result.voiceover?.asset) {
            logToAutogen(ideaId, `✅ Озвучка готова${result.voiceover.usedFallback ? ` (запрошенный провайдер не сработал, использован ${result.voiceover.provider === 'piper' ? 'Piper' : 'ElevenLabs'})` : ''}`);
        }
        if (result.voiceover?.error) logToAutogen(ideaId, '❌ Озвучка: ' + result.voiceover.error);
        if (result.video?.asset) logToAutogen(ideaId, '✅ Видео-клип готов');
        if (result.video?.error) logToAutogen(ideaId, '❌ Видео: ' + result.video.error);

        if (result.assembly && result.assembly.jobId) {
            logToAutogen(ideaId, 'Обложка и озвучка готовы — собираем ролик через video-worker…');
            finishTicker(true, 'Собираем ролик…');
            startIdeaAssemblyPolling(ideaId, result.assembly.jobId, result, statusElId);
        } else {
            if (result.assembly?.error) logToAutogen(ideaId, '❌ Сборка: ' + result.assembly.error);
            const hasAnyError = result.cover?.error || result.voiceover?.error || result.video?.error || result.assembly?.error;
            finishTicker(!hasAnyError, hasAnyError ? 'Готово частично' : 'Готово');
            renderAutogenResult(ideaId, result);
        }
        renderMediaAssets();
    } catch (e) {
        logToAutogen(ideaId, '❌ Ошибка запроса: ' + e.message);
        finishTicker(false, 'Ошибка: ' + e.message);
        showToast('Не удалось сгенерировать медиа: ' + e.message);
    }
}

function startIdeaAssemblyPolling(ideaId, jobId, resultSoFar, statusElId) {
    const timer = setInterval(async () => {
        try {
            const job = await api(`/api/video-assembly/${jobId}`);
            if (job.status === 'done') {
                clearInterval(timer);
                logToAutogen(ideaId, '✅ Ролик собран');
                showToast('Ролик для идеи готов!');
                renderAutogenResult(ideaId, { ...resultSoFar, assembly: { ...resultSoFar.assembly, status: 'done' } });
                renderMediaAssets();
            } else if (job.status === 'error') {
                clearInterval(timer);
                logToAutogen(ideaId, '❌ Ошибка сборки: ' + (job.error || 'неизвестная ошибка'));
                renderAutogenResult(ideaId, resultSoFar);
            }
            // queued/running - keep polling
        } catch (e) {
            clearInterval(timer);
            logToAutogen(ideaId, '❌ Ошибка опроса статуса сборки: ' + e.message);
            renderAutogenResult(ideaId, resultSoFar);
        }
    }, 4000);
}

// Final view after generation - the Reels shot list/voiceover script if one
// was generated, and the media itself inline (image/audio/video), so
// there's one place to see everything that came out of a generation run
// instead of hunting through Медиатека. The post text itself is already
// visible right above on the card, so it's not repeated here.
function renderAutogenResult(ideaId, result) {
    const box = document.getElementById(`autogen-result-${ideaId}`);
    if (!box) return;

    let html = '';

    if (result.reelsScript) {
        html += `<div class="p-section-title" style="margin-top:16px;">СЦЕНАРИЙ REELS</div>
            <div class="info-box">
                <div style="font-size:12px; color:var(--text-secondary); font-weight:700; text-transform:uppercase; margin-bottom:6px;">Раскадровка</div>
                <ul style="margin:0 0 12px; padding-left:18px;">${(result.reelsScript.shotList || []).map(s => `<li style="margin-bottom:4px;">${escapeHtml(s)}</li>`).join('')}</ul>
                <div style="font-size:12px; color:var(--text-secondary); font-weight:700; text-transform:uppercase; margin-bottom:6px;">Текст озвучки</div>
                <p style="margin:0; white-space:pre-wrap;">${escapeHtml(result.reelsScript.voiceoverText || '')}</p>
            </div>`;
    }

    if (result.cover?.asset) {
        html += `<div class="p-section-title" style="margin-top:16px;">ОБЛОЖКА</div><img src="${result.cover.asset.url}" style="width:100%; border-radius:12px; display:block;">`;
    }
    if (result.voiceover?.asset) {
        html += `<div class="p-section-title" style="margin-top:16px;">ОЗВУЧКА</div><audio controls style="width:100%;" src="${result.voiceover.asset.url}"></audio>`;
    }
    if (result.video?.asset) {
        html += `<div class="p-section-title" style="margin-top:16px;">ВИДЕО-КЛИП</div><video controls style="width:100%; border-radius:12px;" src="${result.video.asset.url}"></video>`;
    }
    if (result.assembly?.status === 'done') {
        html += `<div class="p-section-title" style="margin-top:16px;">ГОТОВЫЙ РОЛИК</div><p style="color:var(--text-secondary); font-size:13px;">Собран и сохранён в Медиатеке.</p>`;
    } else if (result.assembly?.jobId) {
        html += `<div class="p-section-title" style="margin-top:16px;">ГОТОВЫЙ РОЛИК</div><p style="color:var(--text-secondary); font-size:13px;">Ещё собирается — смотрите лог выше.</p>`;
    }

    box.innerHTML = html;
    box.style.display = '';
}

function checkFunnelBalance() {
    const warningBox = document.getElementById('funnel-warning-box');
    if (!warningBox) return;

    const tofuCount = scheduledEvents.filter(e => e.desc && e.desc.includes('TOFU')).length;
    const bofuCount = scheduledEvents.filter(e => e.desc && e.desc.includes('BOFU')).length;

    if (bofuCount > 0 && tofuCount === 0) {
        warningBox.innerHTML = `
        <div class="warning-banner">
            ⚠️ <strong>Дисбаланс воронки:</strong> В календаре есть продающие посты (BOFU), но отсутствует охватный контент (TOFU). Добавьте привлекающие публикации!
        </div>`;
    } else {
        warningBox.innerHTML = '';
    }
}

function validateLimits() {
    const formatEl = document.getElementById('edit-idea-format-input');
    const descEl = document.getElementById('edit-idea-desc-input');
    const badge = document.getElementById('limit-validator-badge');

    if (!formatEl || !descEl || !badge) return;

    const format = formatEl.value;
    const desc = descEl.value;

    let limit = 4096;
    if (format.includes('Reels') || format.includes('Shorts') || format.includes('Клип')) limit = 1000;
    if (format.includes('Threads')) limit = 500;
    if (format.includes('История')) limit = 200;

    const current = desc.length;
    badge.innerText = `${current} / ${limit} симв.`;

    if (current > limit) {
        badge.style.color = "var(--accent-red)";
        badge.style.borderColor = "var(--accent-red)";
    } else {
        badge.style.color = "var(--accent-green)";
        badge.style.borderColor = "var(--accent-green)";
    }
}

// МЕТРИКИ И РЕДАКТИРОВАНИЕ
function openMetricsModal(ideaId) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    document.getElementById('metrics-idea-id').value = idea.id;
    document.getElementById('metrics-idea-title').innerText = idea.title;
    document.getElementById('m-views').value = idea.metrics?.views || 0;
    document.getElementById('m-saves').value = idea.metrics?.saves || 0;
    document.getElementById('m-clicks').value = idea.metrics?.clicks || 0;
    document.getElementById('m-leads').value = idea.metrics?.leads || 0;

    openOverlay('metrics-overlay');
}

async function saveMetrics() {
    const id = document.getElementById('metrics-idea-id').value;
    const idea = ideasBank.find(i => i.id === id);
    if (!idea) return;

    const metrics = {
        views: parseInt(document.getElementById('m-views').value, 10) || 0,
        saves: parseInt(document.getElementById('m-saves').value, 10) || 0,
        clicks: parseInt(document.getElementById('m-clicks').value, 10) || 0,
        leads: parseInt(document.getElementById('m-leads').value, 10) || 0
    };

    try {
        const updated = await api(`/api/ideas/${id}`, { method: 'PUT', body: JSON.stringify({ metrics }) });
        ideasBank = ideasBank.map(i => i.id === id ? updated : i);
        showToast('Метрики сохранены!');
        closeOverlay('metrics-overlay');
        renderBankView();
        renderAnalyticsView();
    } catch (e) {
        showToast('Не удалось сохранить метрики: ' + e.message);
    }
}

async function toggleGroupForIdea(ideaId, groupId) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    const targetGroups = idea.targetGroups || [];
    const exists = targetGroups.includes(groupId);
    const nextGroups = exists ? targetGroups.filter(g => g !== groupId) : [...targetGroups, groupId];

    try {
        const updated = await api(`/api/ideas/${ideaId}`, { method: 'PUT', body: JSON.stringify({ targetGroups: nextGroups }) });
        ideasBank = ideasBank.map(i => i.id === ideaId ? updated : i);
        renderBankView();
        if (currentOpenProductId) renderProductDetailContent(currentOpenProductId);
    } catch (e) {
        showToast('Не удалось обновить продукт идеи: ' + e.message);
    }
}

function openEditIdeaModal(ideaId) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    document.getElementById('edit-modal-title').innerText = "Редактировать идею";
    document.getElementById('edit-idea-id').value = idea.id;
    document.getElementById('edit-idea-title-input').value = idea.title;
    document.getElementById('edit-idea-desc-input').value = idea.desc || '';
    document.getElementById('edit-idea-format-input').value = idea.format || 'TG Пост';
    document.getElementById('edit-idea-funnel-input').value = idea.funnel || 'TOFU';
    document.getElementById('edit-idea-status-input').value = idea.status || 'idea';
    document.getElementById('edit-idea-cta-input').value = idea.cta || '';
    populateRubricPickerSelect(idea.rubricId || '');

    document.getElementById('edit-idea-en-section').style.display = 'block';
    document.getElementById('edit-idea-title-en-input').value = idea.titleEn || '';
    document.getElementById('edit-idea-desc-en-input').value = idea.descEn || '';
    document.getElementById('edit-idea-cta-en-input').value = idea.ctaEn || '';

    setCoverAssetField(idea.coverAssetId || '');

    validateLimits();
    openOverlay('edit-idea-overlay');
}

function openNewIdeaModal() {
    document.getElementById('edit-modal-title').innerText = "Создать новую идею";
    document.getElementById('edit-idea-id').value = "";
    document.getElementById('edit-idea-title-input').value = "";
    document.getElementById('edit-idea-desc-input').value = "";
    document.getElementById('edit-idea-format-input').value = "TG Пост";
    document.getElementById('edit-idea-funnel-input').value = "TOFU";
    document.getElementById('edit-idea-status-input').value = "idea";
    document.getElementById('edit-idea-cta-input').value = "Консультация Alba Creation";
    populateRubricPickerSelect('');

    document.getElementById('edit-idea-en-section').style.display = 'none';

    setCoverAssetField('');

    validateLimits();
    openOverlay('edit-idea-overlay');
}

// COVER PICKER (choose a media_assets row as the idea's cover) - reuses the
// same .media-asset-card look as the Медиатека grid, just without the delete button.
function setCoverAssetField(assetId) {
    document.getElementById('edit-idea-cover-asset-id').value = assetId || '';
    const preview = document.getElementById('edit-idea-cover-preview');
    if (!assetId) {
        preview.innerHTML = 'Не выбрана';
        return;
    }
    const asset = mediaAssets.find(a => a.id === assetId);
    preview.innerHTML = asset
        ? `<div style="display:flex; align-items:center; gap:8px;">${mediaAssetPreviewHtml(asset)}<span style="max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(asset.url)}</span></div>`
        : `выбрано: ${escapeHtml(assetId)}`;
    // The inline preview above is small - cap it with a style override rather
    // than a second CSS class just for the 40px thumbnail case.
    const img = preview.querySelector('img, video');
    if (img) { img.style.width = '40px'; img.style.height = '40px'; img.style.borderRadius = '8px'; img.style.flexShrink = '0'; }
}

function clearCoverAsset() {
    setCoverAssetField('');
}

async function openCoverPickerModal() {
    const grid = document.getElementById('cover-picker-grid');
    grid.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Загрузка...</div>`;
    openOverlay('cover-picker-overlay');
    try {
        // Always fetch fresh - the picker can be opened before the user ever
        // visits the Медиатека tab, so the module-level cache may be empty.
        mediaAssets = await api('/api/media-assets');
    } catch (e) {
        grid.innerHTML = `<div class="info-box" style="text-align:center; color:var(--accent-red);">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
        return;
    }
    if (mediaAssets.length === 0) {
        grid.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">В медиатеке пока пусто — добавьте медиа во вкладке «Медиатека».</div>`;
        return;
    }
    grid.innerHTML = mediaAssets.map(asset => `
        <div class="media-asset-card" style="cursor:pointer;" onclick="selectCoverAsset('${asset.id}')">
            ${mediaAssetPreviewHtml(asset)}
            <div class="media-asset-body">
                <div class="media-asset-meta-row"><span class="format-tag">${escapeHtml(asset.type)}</span></div>
                ${mediaAssetSubtextHtml(asset)}
            </div>
        </div>
    `).join('');
}

async function selectCoverAsset(assetId) {
    setCoverAssetField(assetId);
    closeOverlay('cover-picker-overlay');
}

async function saveIdeaChanges() {
    const id = document.getElementById('edit-idea-id').value;
    const title = document.getElementById('edit-idea-title-input').value.trim();
    const desc = document.getElementById('edit-idea-desc-input').value.trim();
    const format = document.getElementById('edit-idea-format-input').value;
    const funnel = document.getElementById('edit-idea-funnel-input').value;
    const status = document.getElementById('edit-idea-status-input').value;
    const cta = document.getElementById('edit-idea-cta-input').value.trim();
    const rubricId = document.getElementById('edit-idea-rubric-input').value || null;
    const coverAssetId = document.getElementById('edit-idea-cover-asset-id').value || null;

    if (!title) return alert('Укажите название идеи');

    try {
        const existingIdea = id ? ideasBank.find(i => i.id === id) : null;
        const coverChanged = coverAssetId && coverAssetId !== (existingIdea ? existingIdea.coverAssetId : null);

        if (id) {
            const titleEn = document.getElementById('edit-idea-title-en-input').value.trim();
            const descEn = document.getElementById('edit-idea-desc-en-input').value.trim();
            const ctaEn = document.getElementById('edit-idea-cta-en-input').value.trim();
            const updated = await api(`/api/ideas/${id}`, { method: 'PUT', body: JSON.stringify({ title, desc, format, funnel, status, cta, titleEn, descEn, ctaEn, rubricId, coverAssetId }) });
            ideasBank = ideasBank.map(item => item.id === id ? updated : item);
            showToast('Идея обновлена!');
        } else {
            const created = await api('/api/ideas', { method: 'POST', body: JSON.stringify({ title, desc, format, funnel, status, cta, rubricId, coverAssetId }) });
            ideasBank.unshift(created);
            showToast('Новая идея создана!');
        }

        // Best-effort usage counter bump - never blocks the save if it fails.
        if (coverChanged) {
            try { await api(`/api/media-assets/${coverAssetId}/use`, { method: 'POST' }); } catch (_) {}
        }

        renderBankView();
        renderKanbanView();
        renderAnalyticsView();
        renderContentCreationView();
        if (currentOpenProductId) renderProductDetailContent(currentOpenProductId);
        closeOverlay('edit-idea-overlay');
    } catch (e) {
        showToast('Не удалось сохранить идею: ' + e.message);
    }
}

async function translateIdeaToEnglish() {
    const id = document.getElementById('edit-idea-id').value;
    if (!id) return;
    const btn = event.target;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Перевожу...';
    try {
        const updated = await api(`/api/ideas/${id}/translate`, { method: 'POST' });
        document.getElementById('edit-idea-title-en-input').value = updated.titleEn || '';
        document.getElementById('edit-idea-desc-en-input').value = updated.descEn || '';
        document.getElementById('edit-idea-cta-en-input').value = updated.ctaEn || '';
        ideasBank = ideasBank.map(item => item.id === id ? updated : item);
        showToast('Переведено на английский!');
    } catch (e) {
        showToast('Не удалось перевести: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function deleteIdea(ideaId) {
    if (!confirm('Удалить эту идею?')) return;

    try {
        await api(`/api/ideas/${ideaId}`, { method: 'DELETE' });
        ideasBank = ideasBank.filter(i => i.id !== ideaId);
        scheduledEvents = scheduledEvents.filter(e => e.ideaId !== ideaId);

        renderBankView();
        renderKanbanView();
        renderAnalyticsView();
        renderCalendar();
        renderContentCreationView();
        showToast('Идея удалена');
    } catch (e) {
        showToast('Не удалось удалить идею: ' + e.message);
    }
}

function exportIdeasJSON() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(ideasBank, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "ideas.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast('Экспортировано!');
}

function processImportJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!Array.isArray(data)) throw new Error('Ожидался массив идей');
            ideasBank = await api('/api/ideas/import', { method: 'POST', body: JSON.stringify(data) });
            renderBankView();
            renderKanbanView();
            renderAnalyticsView();
            renderContentCreationView();
            showToast('Импортировано успешно!');
        } catch (err) { alert('Ошибка чтения JSON файла: ' + err.message); }
    };
    reader.readAsText(file);
}

// CONSOLIDATED PUBLISH SETTINGS (Task 4 - one modal, one tab per platform, replacing the
// previous 5 separate ⚙️ buttons/overlays). Secrets never round-trip back to the browser
// in full, only a masked preview + whether they're configured; see server/routes/settings.js
// for the write-mostly PUT pattern each save*Settings function below hits.
async function openPublishSettingsModal() {
    try {
        const [telegram, vk, instagram, youtube, threads, pinterest] = await Promise.all([
            api('/api/settings/telegram'),
            api('/api/settings/vk'),
            api('/api/settings/instagram'),
            api('/api/settings/youtube'),
            api('/api/settings/threads'),
            api('/api/settings/pinterest'),
        ]);
        tgMeta = telegram; vkMeta = vk; igMeta = instagram; ytMeta = youtube; thMeta = threads; pinMeta = pinterest;
    } catch (e) {
        showToast('Не удалось получить настройки публикаций: ' + e.message);
    }

    const tokenInput = document.getElementById('tg-token-input');
    const chatInput = document.getElementById('tg-chat-input');
    if (tokenInput) {
        tokenInput.value = '';
        tokenInput.placeholder = tgMeta.hasToken
            ? `Сохранён токен ${tgMeta.tokenPreview} — введите новый, чтобы заменить`
            : '123456789:ABCdefGHI...';
    }
    if (chatInput) chatInput.value = tgMeta.chatId || '';

    const vkTokenInput = document.getElementById('vk-token-input');
    const vkGroupInput = document.getElementById('vk-group-input');
    if (vkTokenInput) {
        vkTokenInput.value = '';
        vkTokenInput.placeholder = vkMeta.hasToken
            ? `Сохранён токен ${vkMeta.tokenPreview} — введите новый, чтобы заменить`
            : 'vk1.a.xxxxxxxx...';
    }
    if (vkGroupInput) vkGroupInput.value = vkMeta.groupId || '';

    const igTokenInput = document.getElementById('ig-token-input');
    const igAccountInput = document.getElementById('ig-account-input');
    if (igTokenInput) {
        igTokenInput.value = '';
        igTokenInput.placeholder = igMeta.hasToken
            ? `Сохранён токен ${igMeta.tokenPreview} — введите новый, чтобы заменить`
            : 'EAAxxxxxxxx...';
    }
    if (igAccountInput) igAccountInput.value = igMeta.businessAccountId || '';

    const ytClientIdInput = document.getElementById('yt-client-id-input');
    const ytClientSecretInput = document.getElementById('yt-client-secret-input');
    const ytRefreshTokenInput = document.getElementById('yt-refresh-token-input');
    const ytChannelTitleInput = document.getElementById('yt-channel-title-input');
    if (ytClientIdInput) ytClientIdInput.value = ytMeta.clientId || '';
    if (ytClientSecretInput) {
        ytClientSecretInput.value = '';
        ytClientSecretInput.placeholder = ytMeta.hasClientSecret ? 'Сохранён — введите новый, чтобы заменить' : 'GOCSPX-xxxxxxxx...';
    }
    if (ytRefreshTokenInput) {
        ytRefreshTokenInput.value = '';
        ytRefreshTokenInput.placeholder = ytMeta.hasRefreshToken ? 'Сохранён — введите новый, чтобы заменить' : '1//0gxxxxxxxx...';
    }
    if (ytChannelTitleInput) ytChannelTitleInput.value = ytMeta.channelTitle || '';

    const thTokenInput = document.getElementById('th-token-input');
    const thUserInput = document.getElementById('th-user-input');
    if (thTokenInput) {
        thTokenInput.value = '';
        thTokenInput.placeholder = thMeta.hasToken
            ? `Сохранён токен ${thMeta.tokenPreview} — введите новый, чтобы заменить`
            : 'THQVJ...xxxxxxxx...';
    }
    if (thUserInput) thUserInput.value = thMeta.userId || '';

    const pinTokenInput = document.getElementById('pin-token-input');
    if (pinTokenInput) {
        pinTokenInput.value = '';
        pinTokenInput.placeholder = pinMeta.hasToken
            ? `Сохранён токен ${pinMeta.tokenPreview} — введите новый, чтобы заменить`
            : 'pina_xxxxxxxx...';
    }
    await loadPinterestBoards();
    renderPinterestBoardSelect('pin-board-select', pinMeta.defaultBoardId);

    await loadTelegramChannels();
    switchPublishSettingsTab('tg');
    openOverlay('publish-settings-overlay');
}

// Pinterest boards - shared between the settings tab's "default board" select
// and the publish modal's per-post board select. Silently empties the list
// (rather than toasting) when Pinterest isn't configured yet, since this is
// called eagerly every time either modal opens.
async function loadPinterestBoards() {
    if (!pinMeta.hasToken) { pinterestBoards = []; return; }
    try {
        pinterestBoards = await api('/api/settings/pinterest/boards');
    } catch (e) {
        pinterestBoards = [];
    }
}

function renderPinterestBoardSelect(selectId, selectedId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.innerHTML = pinterestBoards.length === 0
        ? `<option value="">— нет досок —</option>`
        : pinterestBoards.map(b => `<option value="${b.id}" ${b.id === selectedId ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('');
}

async function savePinSettings() {
    const accessToken = document.getElementById('pin-token-input').value.trim();
    const defaultBoardId = document.getElementById('pin-board-select').value;
    try {
        pinMeta = await api('/api/settings/pinterest', { method: 'PUT', body: JSON.stringify({ accessToken, defaultBoardId }) });
        await loadPinterestBoards();
        renderPinterestBoardSelect('pin-board-select', pinMeta.defaultBoardId);
        showToast('Настройки Pinterest сохранены');
        renderBankView();
    } catch (e) {
        showToast('Не удалось сохранить настройки Pinterest: ' + e.message);
    }
}

async function createPinterestBoard() {
    const nameInput = document.getElementById('pin-new-board-name');
    const name = nameInput.value.trim();
    if (!name) { showToast('Укажите название доски'); return; }
    try {
        await api('/api/settings/pinterest/boards', { method: 'POST', body: JSON.stringify({ name }) });
        nameInput.value = '';
        await loadPinterestBoards();
        renderPinterestBoardSelect('pin-board-select', pinMeta.defaultBoardId);
        showToast('Доска создана');
    } catch (e) {
        showToast('Не удалось создать доску: ' + e.message);
    }
}

function switchPublishSettingsTab(tab) {
    ['tg', 'vk', 'ig', 'yt', 'th', 'pin'].forEach(t => {
        const content = document.getElementById(`ps-tab-${t}`);
        if (content) content.style.display = t === tab ? '' : 'none';
        const btn = document.querySelector(`.ps-tab-btn[data-ps-tab="${t}"]`);
        if (btn) btn.classList.toggle('active', t === tab);
    });
}

// TELEGRAM (bot token, used server-side only, see server/routes/telegram.js)
async function saveTgSettings() {
    const token = document.getElementById('tg-token-input').value.trim();
    const chatId = document.getElementById('tg-chat-input').value.trim();
    try {
        tgMeta = await api('/api/settings/telegram', { method: 'PUT', body: JSON.stringify({ token, chatId }) });
        showToast('Токен Telegram сохранён');
    } catch (e) {
        showToast('Не удалось сохранить настройки Telegram: ' + e.message);
    }
}

// TELEGRAM CHANNELS CRUD (publish targets the bot can post to - distinct from the bot
// token above, see telegram_channels in server/db.js and server/routes/settings.js).
async function loadTelegramChannels() {
    try {
        telegramChannels = await api('/api/settings/telegram-channels');
    } catch (e) {
        telegramChannels = [];
        showToast('Не удалось получить список каналов: ' + e.message);
    }
    renderTelegramChannelsList();
}

function renderTelegramChannelsList() {
    const container = document.getElementById('tg-channels-list');
    if (!container) return;
    if (telegramChannels.length === 0) {
        container.innerHTML = `<p style="color:var(--text-secondary); font-size:13px; margin:0;">Каналов пока нет — добавьте первый ниже.</p>`;
        return;
    }
    container.innerHTML = telegramChannels.map(ch => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:0.5px solid var(--separator);">
            <div>
                <div style="font-weight:600; font-size:13px;">${escapeHtml(ch.label)}</div>
                <div style="font-size:12px; color:var(--text-secondary);">${escapeHtml(ch.chatId)}</div>
            </div>
            <button class="delete-btn" onclick="deleteTelegramChannel(${ch.id})">🗑</button>
        </div>`).join('');
}

async function addTelegramChannel() {
    const labelInput = document.getElementById('tg-new-channel-label');
    const chatIdInput = document.getElementById('tg-new-channel-chatid');
    const label = labelInput.value.trim();
    const chatId = chatIdInput.value.trim();
    if (!label || !chatId) {
        showToast('Укажите название и chat_id канала');
        return;
    }
    try {
        await api('/api/settings/telegram-channels', { method: 'POST', body: JSON.stringify({ label, chatId }) });
        labelInput.value = '';
        chatIdInput.value = '';
        await loadTelegramChannels();
        showToast('Канал добавлен');
    } catch (e) {
        showToast('Не удалось добавить канал: ' + e.message);
    }
}

async function deleteTelegramChannel(id) {
    try {
        await api(`/api/settings/telegram-channels/${id}`, { method: 'DELETE' });
        await loadTelegramChannels();
        showToast('Канал удалён');
    } catch (e) {
        showToast('Не удалось удалить канал: ' + e.message);
    }
}

// VK (community wall.post)
async function saveVkSettings() {
    const accessToken = document.getElementById('vk-token-input').value.trim();
    const groupId = document.getElementById('vk-group-input').value.trim();
    try {
        vkMeta = await api('/api/settings/vk', { method: 'PUT', body: JSON.stringify({ accessToken, groupId }) });
        showToast('Настройки VK сохранены');
        renderBankView();
    } catch (e) {
        showToast('Не удалось сохранить настройки VK: ' + e.message);
    }
}

// Instagram (Content Publishing API: create media container, then publish)
async function saveIgSettings() {
    const accessToken = document.getElementById('ig-token-input').value.trim();
    const businessAccountId = document.getElementById('ig-account-input').value.trim();
    try {
        igMeta = await api('/api/settings/instagram', { method: 'PUT', body: JSON.stringify({ accessToken, businessAccountId }) });
        showToast('Настройки Instagram сохранены');
        renderBankView();
    } catch (e) {
        showToast('Не удалось сохранить настройки Instagram: ' + e.message);
    }
}

// YouTube (Data API v3 videos.insert via OAuth2 refresh token)
async function saveYtSettings() {
    const clientId = document.getElementById('yt-client-id-input').value.trim();
    const clientSecret = document.getElementById('yt-client-secret-input').value.trim();
    const refreshToken = document.getElementById('yt-refresh-token-input').value.trim();
    const channelTitle = document.getElementById('yt-channel-title-input').value.trim();
    try {
        ytMeta = await api('/api/settings/youtube', { method: 'PUT', body: JSON.stringify({ clientId, clientSecret, refreshToken, channelTitle }) });
        showToast('Настройки YouTube сохранены');
        renderBankView();
    } catch (e) {
        showToast('Не удалось сохранить настройки YouTube: ' + e.message);
    }
}

// Threads (Publishing API: create media container, then publish - text-only allowed)
async function saveThSettings() {
    const accessToken = document.getElementById('th-token-input').value.trim();
    const userId = document.getElementById('th-user-input').value.trim();
    try {
        thMeta = await api('/api/settings/threads', { method: 'PUT', body: JSON.stringify({ accessToken, userId }) });
        showToast('Настройки Threads сохранены');
        renderBankView();
    } catch (e) {
        showToast('Не удалось сохранить настройки Threads: ' + e.message);
    }
}

// PUBLISH MODAL (Task 3 - the "Опубликовать" confirmation flow, one entry point per idea
// card replacing the previous one-click-per-platform buttons). Selecting a platform,
// channel or language below only updates local state and re-renders the preview - the
// only click that fires a real API call is confirmPublish() on "Подтвердить публикацию".
const PUBLISH_PLATFORMS = [
    { id: 'telegram', label: '✈️ Telegram', isConfigured: () => tgMeta.hasToken, notConfiguredMsg: 'Telegram бот не настроен. Укажите Bot Token в настройках публикаций.' },
    { id: 'vk', label: '🔵 VK', isConfigured: () => vkMeta.hasToken, notConfiguredMsg: 'VK не настроен. Укажите Access Token и ID сообщества в настройках публикаций.' },
    { id: 'instagram', label: '📸 Instagram', isConfigured: () => igMeta.hasToken, notConfiguredMsg: 'Instagram не настроен. Укажите Page Access Token и Business Account ID в настройках публикаций.' },
    { id: 'youtube', label: '▶️ YouTube', isConfigured: () => ytMeta.configured, notConfiguredMsg: 'YouTube не настроен. Укажите Client ID, Client Secret и Refresh Token в настройках публикаций.' },
    { id: 'threads', label: '🧵 Threads', isConfigured: () => thMeta.hasToken, notConfiguredMsg: 'Threads не настроен. Укажите Access Token и User ID в настройках публикаций.' },
    { id: 'pinterest', label: '📌 Pinterest', isConfigured: () => pinMeta.hasToken, notConfiguredMsg: 'Pinterest не настроен. Укажите Access Token в настройках публикаций.' },
];

function getPublishModalIdea() {
    return ideasBank.find(i => i.id === publishModalState.ideaId) || null;
}

// Client-side mirror of server/lib/resolveIdeaLang.js's pickLangFields, for the live
// preview only - the actual publish request still sends just {ideaId, lang}; the server
// re-derives title/desc/cta itself as the source of truth.
function pickLangFieldsClient(idea, lang) {
    if (lang !== 'en') return { title: idea.title, desc: idea.desc, cta: idea.cta };
    return {
        title: idea.titleEn || idea.title,
        desc: idea.descEn || idea.desc,
        cta: idea.ctaEn || idea.cta,
    };
}

// Shared by the immediate-publish modal and the schedule (auto-publish)
// modal - both need the same platform-configured flags and channel/board
// lists to let the user pick where a post goes.
async function loadPublishMeta() {
    try {
        const [telegram, vk, instagram, youtube, threads, pinterest] = await Promise.all([
            api('/api/settings/telegram'),
            api('/api/settings/vk'),
            api('/api/settings/instagram'),
            api('/api/settings/youtube'),
            api('/api/settings/threads'),
            api('/api/settings/pinterest'),
        ]);
        tgMeta = telegram; vkMeta = vk; igMeta = instagram; ytMeta = youtube; thMeta = threads; pinMeta = pinterest;
    } catch (e) {
        showToast('Не удалось получить настройки публикаций: ' + e.message);
    }
    await loadTelegramChannels();
    await loadPinterestBoards();
}

async function openPublishModal(ideaId) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    publishModalState = { ideaId, platform: 'telegram', lang: 'ru', channelId: null, boardId: null };
    await loadPublishMeta();
    if (telegramChannels.length > 0) publishModalState.channelId = telegramChannels[0].id;
    publishModalState.boardId = pinMeta.defaultBoardId || (pinterestBoards[0] && pinterestBoards[0].id) || null;

    document.getElementById('publish-idea-title').innerText = idea.title;
    openOverlay('publish-overlay');
    renderPublishModal();
}

function setPublishPlatform(platformId) {
    publishModalState.platform = platformId;
    if (platformId === 'telegram' && !publishModalState.channelId && telegramChannels.length > 0) {
        publishModalState.channelId = telegramChannels[0].id;
    }
    renderPublishModal();
}

function setPublishLang(lang) {
    const idea = getPublishModalIdea();
    if (lang === 'en' && (!idea || !idea.titleEn)) return; // greyed out - defense in depth against a stray click
    publishModalState.lang = lang;
    renderPublishModal();
}

function onPublishChannelChange() {
    const select = document.getElementById('publish-channel-select');
    publishModalState.channelId = select.value ? Number(select.value) : null;
}

function onPublishBoardChange() {
    const select = document.getElementById('publish-board-select');
    publishModalState.boardId = select.value || null;
}

function renderPublishModal() {
    const idea = getPublishModalIdea();
    if (!idea) return;

    const platformRow = document.getElementById('publish-platform-row');
    platformRow.innerHTML = PUBLISH_PLATFORMS.map(p => {
        const configured = p.isConfigured();
        const active = publishModalState.platform === p.id;
        const activeStyle = active ? 'background:var(--accent-blue); color:#fff;' : '';
        const dimStyle = configured ? '' : 'opacity:0.55;';
        return `<button class="edit-btn" style="${activeStyle}${dimStyle}" onclick="setPublishPlatform('${p.id}')">${p.label}${configured ? '' : ' (не настроено)'}</button>`;
    }).join('');

    const currentPlatform = PUBLISH_PLATFORMS.find(p => p.id === publishModalState.platform);
    const configured = currentPlatform.isConfigured();

    const channelRow = document.getElementById('publish-channel-row');
    const channelSelect = document.getElementById('publish-channel-select');
    if (publishModalState.platform === 'telegram') {
        channelRow.style.display = '';
        channelSelect.innerHTML = telegramChannels.length === 0
            ? `<option value="">— нет каналов —</option>`
            : telegramChannels.map(ch => `<option value="${ch.id}" ${ch.id === publishModalState.channelId ? 'selected' : ''}>${escapeHtml(ch.label)}</option>`).join('');
    } else {
        channelRow.style.display = 'none';
    }

    const boardRow = document.getElementById('publish-board-row');
    const boardSelect = document.getElementById('publish-board-select');
    if (publishModalState.platform === 'pinterest') {
        boardRow.style.display = '';
        boardSelect.innerHTML = pinterestBoards.length === 0
            ? `<option value="">— нет досок —</option>`
            : pinterestBoards.map(b => `<option value="${b.id}" ${b.id === publishModalState.boardId ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('');
    } else {
        boardRow.style.display = 'none';
    }

    const warnBox = document.getElementById('publish-not-configured-box');
    let warnMsg = '';
    if (!configured) {
        warnMsg = currentPlatform.notConfiguredMsg;
    } else if (publishModalState.platform === 'telegram' && telegramChannels.length === 0) {
        warnMsg = 'Нет добавленных каналов для публикации. Добавьте хотя бы один канал в настройках публикаций.';
    } else if (publishModalState.platform === 'pinterest' && pinterestBoards.length === 0) {
        warnMsg = 'Нет ни одной доски в Pinterest. Создайте доску в настройках публикаций.';
    } else if (publishModalState.platform === 'pinterest' && !idea.coverAssetId) {
        warnMsg = 'У этой идеи нет обложки — Pinterest требует изображение для каждого пина. Сгенерируйте или добавьте обложку.';
    }
    if (warnMsg) {
        warnBox.style.display = '';
        warnBox.innerHTML = `<p style="margin:0 0 8px;">${escapeHtml(warnMsg)}</p><button class="edit-btn" onclick="closeOverlay('publish-overlay'); openPublishSettingsModal();">Открыть настройки публикаций</button>`;
    } else {
        warnBox.style.display = 'none';
        warnBox.innerHTML = '';
    }

    const hasEn = Boolean(idea.titleEn);
    if (!hasEn && publishModalState.lang === 'en') publishModalState.lang = 'ru';
    const ruBtn = document.getElementById('publish-lang-ru-btn');
    const enBtn = document.getElementById('publish-lang-en-btn');
    ruBtn.style.background = publishModalState.lang === 'ru' ? 'var(--accent-blue)' : '';
    ruBtn.style.color = publishModalState.lang === 'ru' ? '#fff' : '';
    enBtn.style.background = publishModalState.lang === 'en' ? 'var(--accent-blue)' : '';
    enBtn.style.color = publishModalState.lang === 'en' ? '#fff' : '';
    enBtn.disabled = !hasEn;
    enBtn.style.opacity = hasEn ? '1' : '0.4';
    enBtn.style.cursor = hasEn ? 'pointer' : 'not-allowed';
    document.getElementById('publish-lang-hint').innerText = hasEn
        ? ''
        : 'У этой идеи нет перевода на английский — сначала переведите её («Перевести на английский» в карточке идеи).';

    const { title, desc, cta } = pickLangFieldsClient(idea, publishModalState.lang);
    document.getElementById('publish-preview-title').innerText = title;
    document.getElementById('publish-preview-desc').innerText = desc || '';
    document.getElementById('publish-preview-cta').innerText = cta ? `👉 ${cta}` : '';

    const canPublish = configured
        && (publishModalState.platform !== 'telegram' || publishModalState.channelId)
        && (publishModalState.platform !== 'pinterest' || (publishModalState.boardId && idea.coverAssetId));
    document.getElementById('publish-confirm-btn').disabled = !canPublish;
}

async function confirmPublish() {
    const idea = getPublishModalIdea();
    if (!idea) return;
    const { platform, lang, channelId, boardId, ideaId } = publishModalState;

    try {
        if (platform === 'telegram') {
            if (!channelId) { showToast('Выберите канал для публикации'); return; }
            await api('/api/telegram/post', { method: 'POST', body: JSON.stringify({ ideaId, channelId, lang }) });
        } else if (platform === 'pinterest') {
            if (!boardId) { showToast('Выберите доску для публикации'); return; }
            await api('/api/publish/pinterest', { method: 'POST', body: JSON.stringify({ ideaId, boardId, lang }) });
        } else {
            await api(`/api/publish/${platform}`, { method: 'POST', body: JSON.stringify({ ideaId, lang }) });
        }
        const platformLabel = (PUBLISH_PLATFORMS.find(p => p.id === platform) || {}).label || platform;
        showToast(`Опубликовано: ${platformLabel}`);
        closeOverlay('publish-overlay');
    } catch (e) {
        alert('Ошибка публикации: ' + e.message);
    }
}

// МАТРИЦА СИНЕРГИИ И СТРУКТУРА ПРОДУКТОВ
function renderMatrixView() {
    const container = document.getElementById('matrix-grid');
    if (!container) return;
    let html = '';

    productsData.forEach(p => {
        html += `
        <div class="matrix-card">
            <div class="card-header">
                <span class="card-title" style="font-size:18px;">${p.title}</span>
                <span class="card-badge" style="background:${p.badgeBg}; color:${p.badgeColor}">${p.badge}</span>
            </div>
            <p style="font-size:13px; color:var(--text-secondary); margin-bottom:12px;">${p.desc}</p>
            <div style="font-size:11px; font-weight:700; color:var(--text-secondary); text-transform:uppercase; margin-top:14px;">Синергия и лиды:</div>`;

        if (p.synergies && p.synergies.length > 0) {
            p.synergies.forEach(syn => {
                html += `
                <div class="matrix-flow-item">
                    <span class="matrix-flow-arrow">→</span>
                    <div>
                        <strong>${syn.target}</strong> <span style="font-size:10px; color:${p.badgeColor}; border:1px solid ${p.badgeColor}; border-radius:4px; padding:1px 4px; margin-left:4px;">${syn.type}</span>
                        <div style="color:var(--text-secondary); font-size:12px; margin-top:2px;">${syn.text}</div>
                    </div>
                </div>`;
            });
        } else {
            html += `<div style="font-size:12px; color:var(--text-secondary); margin-top:6px;">Конечный хаб студии.</div>`;
        }
        html += `</div>`;
    });

    container.innerHTML = html;
}

// Reads one project_info field for a product, preferring the DB-backed value
// once it's loaded and falling back to the hardcoded productsData value only
// when there's no DB row yet (or the initial fetch hasn't completed) - see
// initApp(), which populates `projectInfo` from GET /api/project-info before
// any product detail page can be opened.
function projectInfoField(productId, key, fallback) {
    const info = projectInfo[productId];
    if (!info) return fallback;
    return info[key] !== undefined ? info[key] : fallback;
}

async function saveProjectInfo(productId) {
    const about = document.getElementById('pi-about-input')?.value ?? '';
    const targetAudience = document.getElementById('pi-target-audience-input')?.value ?? '';
    const valueProposition = document.getElementById('pi-value-proposition-input')?.value ?? '';
    const keyDifferentiators = document.getElementById('pi-key-differentiators-input')?.value ?? '';
    const commonObjections = document.getElementById('pi-common-objections-input')?.value ?? '';
    const keywords = document.getElementById('pi-keywords-input')?.value ?? '';

    try {
        const updated = await api(`/api/project-info/${productId}`, {
            method: 'PUT',
            body: JSON.stringify({ about, targetAudience, valueProposition, keyDifferentiators, commonObjections, keywords }),
        });
        projectInfo[productId] = updated;
        showToast('Информация о проекте сохранена!');
    } catch (e) {
        showToast('Не удалось сохранить информацию: ' + e.message);
    }
}

// РОАДМАП ПРОДУКТА (редактируемый список этапов, хранится в project_info.roadmap_json)
const ROADMAP_STATUS_LABELS = { planned: 'Запланировано', in_progress: 'В работе', done: 'Готово' };

function currentRoadmap(productId) {
    return (projectInfo[productId]?.roadmap) || [];
}

async function persistRoadmap(productId, roadmap) {
    const updated = await api(`/api/project-info/${productId}/roadmap`, {
        method: 'PUT',
        body: JSON.stringify({ roadmap }),
    });
    if (!projectInfo[productId]) projectInfo[productId] = { productId };
    projectInfo[productId].roadmap = updated.roadmap;
}

function openAddRoadmapItemForm() {
    const form = document.getElementById('roadmap-item-form');
    if (!form) return;
    form.style.display = 'block';
    document.getElementById('ri-id-input').value = '';
    document.getElementById('ri-title-input').value = '';
    document.getElementById('ri-description-input').value = '';
    document.getElementById('ri-status-input').value = 'planned';
}

function closeRoadmapItemForm() {
    const form = document.getElementById('roadmap-item-form');
    if (form) form.style.display = 'none';
}

function editRoadmapItem(productId, itemId) {
    const item = currentRoadmap(productId).find(r => r.id === itemId);
    if (!item) return;
    const form = document.getElementById('roadmap-item-form');
    if (!form) return;
    form.style.display = 'block';
    document.getElementById('ri-id-input').value = item.id;
    document.getElementById('ri-title-input').value = item.title;
    document.getElementById('ri-description-input').value = item.description || '';
    document.getElementById('ri-status-input').value = item.status || 'planned';
}

async function submitRoadmapItem(productId) {
    const id = document.getElementById('ri-id-input').value;
    const title = document.getElementById('ri-title-input').value.trim();
    const description = document.getElementById('ri-description-input').value.trim();
    const status = document.getElementById('ri-status-input').value;

    if (!title) return alert('Укажите название этапа');

    const roadmap = currentRoadmap(productId);
    let nextRoadmap;
    if (id) {
        nextRoadmap = roadmap.map(r => r.id === id ? { ...r, title, description, status } : r);
    } else {
        const newItem = { id: `${productId}-${Date.now()}`, title, description, status };
        nextRoadmap = [...roadmap, newItem];
    }

    try {
        await persistRoadmap(productId, nextRoadmap);
        showToast(id ? 'Этап роадмапа обновлён!' : 'Этап роадмапа добавлен!');
        closeRoadmapItemForm();
        renderProductDetailContent(productId);
    } catch (e) {
        showToast('Не удалось сохранить этап: ' + e.message);
    }
}

async function deleteRoadmapItem(productId, itemId) {
    if (!confirm('Удалить этот этап роадмапа?')) return;
    const nextRoadmap = currentRoadmap(productId).filter(r => r.id !== itemId);
    try {
        await persistRoadmap(productId, nextRoadmap);
        renderProductDetailContent(productId);
    } catch (e) {
        showToast('Не удалось удалить этап: ' + e.message);
    }
}

function renderProductsGrid() {
    const container = document.getElementById('products-grid');
    if (!container) return;
    let html = '';

    productsData.forEach(p => {
        html += `
        <div class="product-card" onclick="openProductDetail('${p.id}')">
            <div>
                <div class="card-header">
                    <div class="card-title">${p.title}</div>
                    <span class="card-badge" style="background:${p.badgeBg}; color:${p.badgeColor}">${p.badge}</span>
                </div>
                <div class="card-desc">${p.desc}</div>
            </div>
            <div class="card-footer">
                <span>Роадмап и идеи</span>
                <span>→</span>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}

function openProductDetail(productId) {
    currentOpenProductId = productId;
    renderProductDetailContent(productId);
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-product-detail').classList.add('active');
}

function closeProductDetailPage() {
    currentOpenProductId = null;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-products').classList.add('active');
}

function renderProductDetailContent(productId) {
    const product = productsData.find(p => p.id === productId);
    if (!product) return;

    const navTitle = document.getElementById('product-detail-title');
    if (navTitle) navTitle.innerText = product.title;

    const about = projectInfoField(productId, 'about', '');
    const targetAudience = projectInfoField(productId, 'targetAudience', product.target);
    const valueProposition = projectInfoField(productId, 'valueProposition', product.value);
    const keyDifferentiators = projectInfoField(productId, 'keyDifferentiators', '');
    const commonObjections = projectInfoField(productId, 'commonObjections', '');
    const keywords = projectInfoField(productId, 'keywords', '');
    const roadmap = currentRoadmap(productId);

    let html = `
        <h2 style="font-size:26px; font-weight:700; margin:0 0 6px 0;">${product.title}</h2>
        <div style="font-size:14px; color:var(--text-secondary); margin-bottom:20px;">${product.desc}</div>

        <div class="p-section-title">О ПРОЕКТЕ</div>

        <label class="form-label">Описание проекта:</label>
        <textarea id="pi-about-input" class="form-textarea" style="min-height:140px;" placeholder="Расскажите про проект: что это, для кого, как устроено...">${escapeHtml(about)}</textarea>

        <label class="form-label">Целевая аудитория (ЦА):</label>
        <input type="text" id="pi-target-audience-input" class="form-input" placeholder="Кто клиент этого продукта" value="${escapeHtml(targetAudience)}">

        <label class="form-label">Главный посыл (value proposition):</label>
        <input type="text" id="pi-value-proposition-input" class="form-input" placeholder="Какую ценность продукт даёт клиенту" value="${escapeHtml(valueProposition)}">

        <label class="form-label">Что отличает от конкурентов:</label>
        <textarea id="pi-key-differentiators-input" class="form-textarea" style="min-height:80px;" placeholder="Чем продукт объективно лучше или отличается от альтернатив">${escapeHtml(keyDifferentiators)}</textarea>

        <label class="form-label">Частые возражения клиентов:</label>
        <textarea id="pi-common-objections-input" class="form-textarea" style="min-height:80px;" placeholder="С какими сомнениями чаще всего сталкиваетесь на продажах">${escapeHtml(commonObjections)}</textarea>

        <label class="form-label">Ключевые слова (через запятую):</label>
        <input type="text" id="pi-keywords-input" class="form-input" placeholder="ключевое слово 1, ключевое слово 2, ..." value="${escapeHtml(keywords)}">

        <button class="submit-btn" style="margin-top:4px;" onclick="saveProjectInfo('${productId}')">💾 Сохранить</button>

        <div class="controls-row" style="margin-top:28px;">
            <div class="p-section-title" style="margin:0;">ROADMAP ПРОДВИЖЕНИЯ</div>
            <button class="schedule-btn" onclick="openAddRoadmapItemForm()">+ Добавить этап</button>
        </div>

        <div id="roadmap-item-form" class="info-box" style="display:none; margin-bottom:16px;">
            <input type="hidden" id="ri-id-input">
            <label class="form-label">Название этапа:</label>
            <input type="text" id="ri-title-input" class="form-input" placeholder="MVP">

            <label class="form-label">Описание:</label>
            <textarea id="ri-description-input" class="form-textarea" style="min-height:60px;" placeholder="Что входит в этот этап"></textarea>

            <label class="form-label">Статус:</label>
            <select id="ri-status-input" class="form-select">
                <option value="planned">Запланировано</option>
                <option value="in_progress">В работе</option>
                <option value="done">Готово</option>
            </select>

            <div style="display:flex; gap:8px; margin-top:14px;">
                <button class="submit-btn" style="margin-top:0;" onclick="submitRoadmapItem('${productId}')">Сохранить</button>
                <button class="edit-btn" onclick="closeRoadmapItemForm()">Отмена</button>
            </div>
        </div>

        <div class="roadmap-list">`;

    if (roadmap.length === 0) {
        html += `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Этапов роадмапа пока нет — добавьте первый кнопкой выше.</div>`;
    } else {
        roadmap.forEach(r => {
            const status = r.status || 'planned';
            html += `
            <div class="roadmap-step" style="border-left-color:${product.badgeColor}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                    <div class="step-title">${escapeHtml(r.title)}</div>
                    <span class="roadmap-status ${status}">${escapeHtml(ROADMAP_STATUS_LABELS[status] || status)}</span>
                </div>
                ${r.description ? `<div class="step-desc">${escapeHtml(r.description)}</div>` : ''}
                <div class="action-btn-row" style="margin-top:10px;">
                    <button class="edit-btn" onclick="editRoadmapItem('${productId}', '${r.id}')">✏️ Изменить</button>
                    <button class="delete-btn" onclick="deleteRoadmapItem('${productId}', '${r.id}')">Удалить</button>
                </div>
            </div>`;
        });
    }

    html += `</div>`;
    const body = document.getElementById('product-detail-body');
    if (body) body.innerHTML = html;
}

// ИНТЕРАКТИВНЫЙ КАЛЕНДАРЬ И ПИКЕР ИДЕЙ
let scheduleModalState = { ideaId: null, platform: 'telegram', lang: 'ru', channelId: null, boardId: null };
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // matches Date.getDay(), see agentSettings.weeklySchedule's day field

async function openScheduleForIdea(ideaId) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    const targetProduct = productsData.find(p => idea.targetGroups && idea.targetGroups.includes(p.id));
    const pTitle = targetProduct ? targetProduct.title : "Alba Creation";

    currentSelectedIdea = idea;
    scheduleModalState = { ideaId, platform: 'telegram', lang: 'ru', channelId: null, boardId: null };

    const sTitle = document.getElementById('schedule-title');
    const sCat = document.getElementById('schedule-category');
    if (sTitle) sTitle.innerText = idea.title;
    if (sCat) sCat.innerText = `Продукт: ${pTitle}`;
    document.getElementById('schedule-date-input').value = '';
    document.getElementById('schedule-time-input').value = '12:00';
    document.getElementById('schedule-day-theme').textContent = '';

    await loadPublishMeta();
    if (telegramChannels.length > 0) scheduleModalState.channelId = telegramChannels[0].id;
    scheduleModalState.boardId = pinMeta.defaultBoardId || (pinterestBoards[0] && pinterestBoards[0].id) || null;

    openOverlay('schedule-overlay');
    renderScheduleModal();
}

// Shows the weekly-schedule's "Фокус дня" for whatever date is picked, so
// the user can see at a glance whether this idea fits the day's planned
// theme before confirming.
function onScheduleDateChange() {
    const chosenDate = document.getElementById('schedule-date-input').value;
    const box = document.getElementById('schedule-day-theme');
    if (!chosenDate || !box) return;
    const weekday = WEEKDAY_KEYS[new Date(chosenDate + 'T00:00:00').getDay()];
    const entry = (agentSettings.weeklySchedule || []).find(d => d.day === weekday);
    box.textContent = entry ? `Тема дня (${entry.label}): ${entry.focus}` : '';
}

function setSchedulePlatform(platformId) {
    scheduleModalState.platform = platformId;
    if (platformId === 'telegram' && !scheduleModalState.channelId && telegramChannels.length > 0) {
        scheduleModalState.channelId = telegramChannels[0].id;
    }
    renderScheduleModal();
}

function setScheduleLang(lang) {
    if (lang === 'en' && (!currentSelectedIdea || !currentSelectedIdea.titleEn)) return;
    scheduleModalState.lang = lang;
    renderScheduleModal();
}

function onScheduleChannelChange() {
    const select = document.getElementById('schedule-channel-select');
    scheduleModalState.channelId = select.value ? Number(select.value) : null;
}

function onScheduleBoardChange() {
    const select = document.getElementById('schedule-board-select');
    scheduleModalState.boardId = select.value || null;
}

function renderScheduleModal() {
    if (!currentSelectedIdea) return;

    const platformRow = document.getElementById('schedule-platform-row');
    platformRow.innerHTML = PUBLISH_PLATFORMS.map(p => {
        const configured = p.isConfigured();
        const active = scheduleModalState.platform === p.id;
        const activeStyle = active ? 'background:var(--accent-blue); color:#fff;' : '';
        const dimStyle = configured ? '' : 'opacity:0.55;';
        return `<button class="edit-btn" style="${activeStyle}${dimStyle}" onclick="setSchedulePlatform('${p.id}')">${p.label}${configured ? '' : ' (не настроено)'}</button>`;
    }).join('');

    const currentPlatform = PUBLISH_PLATFORMS.find(p => p.id === scheduleModalState.platform);
    const configured = currentPlatform.isConfigured();

    const channelRow = document.getElementById('schedule-channel-row');
    const channelSelect = document.getElementById('schedule-channel-select');
    if (scheduleModalState.platform === 'telegram') {
        channelRow.style.display = '';
        channelSelect.innerHTML = telegramChannels.length === 0
            ? `<option value="">— нет каналов —</option>`
            : telegramChannels.map(ch => `<option value="${ch.id}" ${ch.id === scheduleModalState.channelId ? 'selected' : ''}>${escapeHtml(ch.label)}</option>`).join('');
    } else {
        channelRow.style.display = 'none';
    }

    const boardRow = document.getElementById('schedule-board-row');
    const boardSelect = document.getElementById('schedule-board-select');
    if (scheduleModalState.platform === 'pinterest') {
        boardRow.style.display = '';
        boardSelect.innerHTML = pinterestBoards.length === 0
            ? `<option value="">— нет досок —</option>`
            : pinterestBoards.map(b => `<option value="${b.id}" ${b.id === scheduleModalState.boardId ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('');
    } else {
        boardRow.style.display = 'none';
    }

    const warnBox = document.getElementById('schedule-not-configured-box');
    let warnMsg = '';
    if (!configured) {
        warnMsg = currentPlatform.notConfiguredMsg;
    } else if (scheduleModalState.platform === 'telegram' && telegramChannels.length === 0) {
        warnMsg = 'Нет добавленных каналов для публикации. Добавьте хотя бы один канал в настройках публикаций.';
    } else if (scheduleModalState.platform === 'pinterest' && pinterestBoards.length === 0) {
        warnMsg = 'Нет ни одной доски в Pinterest. Создайте доску в настройках публикаций.';
    }
    warnBox.style.display = warnMsg ? '' : 'none';
    warnBox.textContent = warnMsg;

    const hasEn = Boolean(currentSelectedIdea.titleEn);
    if (!hasEn && scheduleModalState.lang === 'en') scheduleModalState.lang = 'ru';
    const ruBtn = document.getElementById('schedule-lang-ru-btn');
    const enBtn = document.getElementById('schedule-lang-en-btn');
    ruBtn.style.background = scheduleModalState.lang === 'ru' ? 'var(--accent-blue)' : '';
    ruBtn.style.color = scheduleModalState.lang === 'ru' ? '#fff' : '';
    enBtn.style.background = scheduleModalState.lang === 'en' ? 'var(--accent-blue)' : '';
    enBtn.style.color = scheduleModalState.lang === 'en' ? '#fff' : '';
    enBtn.disabled = !hasEn;
    enBtn.style.opacity = hasEn ? '1' : '0.4';

    const canConfirm = configured
        && (scheduleModalState.platform !== 'telegram' || scheduleModalState.channelId)
        && (scheduleModalState.platform !== 'pinterest' || scheduleModalState.boardId);
    document.getElementById('schedule-confirm-btn').disabled = !canConfirm;
}

async function confirmSchedule() {
    const chosenDate = document.getElementById('schedule-date-input').value;
    const chosenTime = document.getElementById('schedule-time-input').value || '12:00';
    if (!chosenDate || !currentSelectedIdea) return;

    const targetProduct = productsData.find(p => currentSelectedIdea.targetGroups && currentSelectedIdea.targetGroups.includes(p.id));
    const pTitle = targetProduct ? targetProduct.title : "Alba Creation";
    const pColor = targetProduct ? targetProduct.badgeColor : "#0a84ff";

    const d = new Date(chosenDate);
    const dayNames = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
    const monthNames = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
    const dateStr = `${dayNames[d.getDay()]}, ${d.getDate()} ${monthNames[d.getMonth()]}`;
    const publishAt = Math.floor(new Date(`${chosenDate}T${chosenTime}:00`).getTime() / 1000);

    try {
        const created = await api('/api/events', { method: 'POST', body: JSON.stringify({
            ideaId: currentSelectedIdea.id,
            title: `${pTitle}: ${currentSelectedIdea.title}`,
            dateStr,
            rawDate: chosenDate,
            color: pColor,
            format: currentSelectedIdea.format || 'TG Пост',
            cta: currentSelectedIdea.cta || 'Консультация Alba Creation',
            desc: currentSelectedIdea.desc || `Запланировано (${pTitle})`,
            platform: scheduleModalState.platform,
            channelId: scheduleModalState.channelId,
            boardId: scheduleModalState.boardId,
            lang: scheduleModalState.lang,
            publishAt,
        }) });

        scheduledEvents.push(created);
        scheduledEvents.sort((a,b) => new Date(a.rawDate) - new Date(b.rawDate));
        renderCalendar();
        updatePlanProgress();
        checkFunnelBalance();

        closeOverlay('schedule-overlay');
        showToast(`Запланировано на ${d.getDate()} ${monthNames[d.getMonth()]}, ${chosenTime}`);
        switchTab('calendar');
    } catch (e) {
        showToast('Не удалось запланировать публикацию: ' + e.message);
    }
}

async function retryScheduledEvent(id) {
    try {
        const updated = await api(`/api/events/${id}/retry`, { method: 'POST' });
        scheduledEvents = scheduledEvents.map(e => e.id === updated.id ? updated : e);
        if (currentOpenDay) renderDayDetailPage(currentOpenDay);
        else renderCalendar();
        showToast('Публикация поставлена в очередь повторно');
    } catch (e) {
        showToast('Не удалось повторить: ' + e.message);
    }
}

function renderCalendar() {
    const gridContainer = document.getElementById('calendar-month-grid');
    const listContainer = document.getElementById('calendar-list-content');
    if (!gridContainer || !listContainer) return;

    let gridHtml = '';
    const daysInMonth = 31;
    const weekDays = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];

    weekDays.forEach(wd => gridHtml += `<div class="cal-day-header">${wd}</div>`);

    for (let day = 1; day <= daysInMonth; day++) {
        const dateFormatted = `2026-08-${day < 10 ? '0' + day : day}`;
        const eventsOnDay = scheduledEvents.filter(e => e.rawDate === dateFormatted);
        const hasEvent = eventsOnDay.length > 0;

        const reelsCount = eventsOnDay.filter(e => (e.format || '').includes('Reels') || (e.format || '').includes('Shorts') || (e.format || '').includes('Клип')).length;
        const postsCount = eventsOnDay.filter(e => (e.format || '').includes('TG') || (e.format || '').includes('Пост') || (e.format || '').includes('Публикация')).length;
        const totalCount = eventsOnDay.length;

        gridHtml += `
            <div class="cal-day-cell ${hasEvent ? 'has-event' : ''}">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:600;" onclick="openDayDetailPage('${dateFormatted}')">${day}</span>
                    <span style="font-size:10px; color:var(--text-secondary);">${totalCount}/${planSettings.daily}</span>
                </div>

                <div class="cal-slot-picker" onclick="openDayDetailPage('${dateFormatted}')" title="Нажмите, чтобы открыть день">
                    ${totalCount > 0 ? `
                        <div class="slot-badges">
                            ${reelsCount > 0 ? `<span class="slot-badge reels">🎬 ${reelsCount}</span>` : ''}
                            ${postsCount > 0 ? `<span class="slot-badge posts">📝 ${postsCount}</span>` : ''}
                            ${(totalCount - reelsCount - postsCount) > 0 ? `<span class="slot-badge other">📌 ${totalCount - reelsCount - postsCount}</span>` : ''}
                        </div>
                    ` : `
                        <span class="slot-add-text">+ Добавить</span>
                    `}
                </div>
            </div>`;
    }
    gridContainer.innerHTML = gridHtml;

    updatePlanProgress();

    if (scheduledEvents.length === 0) {
        listContainer.innerHTML = `<div style="padding:20px; text-align:center; color:var(--text-secondary);">Нет запланированных постов</div>`;
        return;
    }

    let listHtml = `<div class="list-container">`;
    scheduledEvents.forEach(item => {
        const dateParts = item.rawDate.split('-');
        const dayNum = parseInt(dateParts[2], 10);
        const dayName = item.dateStr.split(',')[0];

        listHtml += `
        <div class="list-item" onclick="openDayDetailPage('${item.rawDate}')">
            <div class="date-block">
                <div class="date-day" style="color:${item.color}">${dayName}</div>
                <div class="date-num">${dayNum}</div>
            </div>
            <div class="content-block">
                <div class="item-title">
                    <span class="dot" style="background-color: ${item.color}"></span>
                    <span>${item.title}</span>
                </div>
                <div class="item-desc">${item.desc}</div>
            </div>
        </div>`;
    });
    listHtml += `</div>`;
    listContainer.innerHTML = listHtml;
}

// СТРАНИЦА ДНЯ (объединяет запланированные публикации и выбор идеи из банка)
function openDayDetailPage(dateStr) {
    currentOpenDay = dateStr;
    renderDayDetailPage(dateStr);
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-day-detail').classList.add('active');
}

function closeDayDetailPage() {
    currentOpenDay = null;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-calendar').classList.add('active');
    renderCalendar();
}

function renderDayDetailPage(dateStr) {
    const events = scheduledEvents.filter(e => e.rawDate === dateStr);
    const dateParts = dateStr.split('-');
    const dayNum = parseInt(dateParts[2], 10);
    const monthNames = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
    const monthNum = parseInt(dateParts[1], 10) - 1;

    const titleEl = document.getElementById('day-detail-title');
    if (titleEl) titleEl.innerText = `${dayNum} ${monthNames[monthNum]}`;

    let html = `<div class="p-section-title" style="margin-top:0;">ПУБЛИКАЦИИ НА ЭТОТ ДЕНЬ (${events.length})</div>`;

    if (events.length === 0) {
        html += `<div class="info-box" style="text-align:center; margin-bottom:24px;">На этот день публикаций пока нет.</div>`;
    } else {
        events.forEach(item => {
            const statusInfo = {
                pending: { label: `⏳ Автопубликация в ${item.publishAt ? new Date(item.publishAt * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'}`, color: 'var(--text-secondary)' },
                published: { label: '✅ Опубликовано', color: 'var(--accent-green)' },
                failed: { label: '❌ Ошибка публикации', color: 'var(--accent-red)' },
            }[item.publishStatus];
            html += `
            <div class="day-large-card" style="border-left: 4px solid ${item.color}; background: var(--bg-grouped); border-radius: 14px; padding: 16px; margin-bottom: 14px; border: 1px solid rgba(255,255,255,0.08);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-weight:700; font-size:15px; color:var(--text-primary);">Публикация</span>
                    <span class="slot-badge" style="background:${item.color}22; color:${item.color}; font-size:11px; padding:3px 8px; border-radius:6px; font-weight:600;">${item.format || 'Пост'}</span>
                </div>
                <div style="font-size:16px; font-weight:600; margin-bottom:6px;">${item.title}</div>
                <div style="font-size:13px; color:var(--text-secondary); margin-bottom:10px;">${item.desc}</div>
                <div class="info-box" style="font-size:12px; margin-bottom:10px; padding:8px;"><strong>CTA:</strong> ${item.cta}</div>
                ${item.publishAt && statusInfo ? `<div style="font-size:12px; color:${statusInfo.color}; margin-bottom:8px;">${statusInfo.label} — ${(PUBLISH_PLATFORMS.find(p => p.id === item.platform) || {}).label || item.platform}</div>` : ''}
                ${item.publishStatus === 'failed' && item.publishError ? `<div class="warning-banner" style="font-size:12px; margin-bottom:10px;">${escapeHtml(item.publishError)}</div>` : ''}
                <div style="display:flex; gap:8px;">
                    ${item.publishStatus === 'failed' ? `<button class="edit-btn" style="flex:1;" onclick="retryScheduledEvent(${item.id})">↻ Повторить</button>` : ''}
                    <button class="delete-btn" style="flex:1; justify-content:center; padding:8px;" onclick="deleteEvent(${item.id}, '${dateStr}')">🗑 Удалить публикацию</button>
                </div>
            </div>`;
        });
    }

    html += `<div class="p-section-title" style="margin-top:28px;">ДОБАВИТЬ ПУБЛИКАЦИЮ ИЗ БАНКА</div>`;

    // Исключаем идеи, которые УЖЕ есть в календаре
    const scheduledIdeaIds = scheduledEvents.map(e => e.ideaId);
    const availableIdeas = ideasBank.filter(idea => !scheduledIdeaIds.includes(idea.id));

    if (availableIdeas.length === 0) {
        html += `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Все идеи из банка уже запланированы или банк пуст</div>`;
    } else {
        availableIdeas.forEach(idea => {
            html += `
            <div class="idea-card">
                <div class="idea-header">
                    <div class="idea-title">${idea.title}</div>
                    <span class="format-tag">${idea.format || 'TG Пост'}</span>
                </div>
                ${idea.desc ? `<div class="idea-desc-text">${idea.desc}</div>` : ''}
                <button class="schedule-btn" style="width:100%; margin-top:8px;" onclick="attachIdeaToDay('${idea.id}', '${dateStr}')">+ Запланировать публикацию</button>
            </div>`;
        });
    }

    const body = document.getElementById('day-detail-body');
    if (body) body.innerHTML = html;
}

// Opens the same schedule modal as "📅 В календарь" on an idea card
// (openScheduleForIdea), pre-filled with the day already being viewed - so
// every path into the calendar goes through one place that captures
// platform/channel/lang/time, instead of this having its own separate
// direct-POST shortcut that skipped all of that (and so never had a
// publish_at, making auto-publish silently not apply to it).
async function attachIdeaToDay(ideaId, dateStr) {
    await openScheduleForIdea(ideaId);
    document.getElementById('schedule-date-input').value = dateStr;
    onScheduleDateChange();
}

// УДАЛЕНИЕ ЗАПЛАНИРОВАННОЙ ПУБЛИКАЦИИ
async function deleteEvent(eventId, dateStr) {
    try {
        await api(`/api/events/${eventId}`, { method: 'DELETE' });
        scheduledEvents = scheduledEvents.filter(e => e.id !== eventId);
        renderCalendar();
        updatePlanProgress();
        checkFunnelBalance();

        if (dateStr) renderDayDetailPage(dateStr); // Обновляем страницу дня на месте
        showToast('Публикация удалена из календаря');
    } catch (e) {
        showToast('Не удалось удалить публикацию: ' + e.message);
    }
}

// КОНТЕНТ ПЛАН (квартальный таймлайн + глобальные заметки стратегии)
const PLAN_PALETTE = ['#0a84ff', '#30d158', '#bf5af2', '#ff9f0a', '#ff453a', '#64d2ff', '#ff375f', '#5e5ce6'];

function renderContentPlan() {
    renderPlanNotes();
    renderPlanTimeline();
    renderWeeklySchedule();
    renderPostFormula();
    growTextareasIn(document.getElementById('plan-notes-row'));
    growTextareasIn(document.getElementById('plan-timeline'));
}

function renderWeeklySchedule() {
    const container = document.getElementById('weekly-schedule-wrap');
    if (!container) return;

    const schedule = agentSettings.weeklySchedule || [];
    if (schedule.length === 0) {
        container.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Расписание пока не задано.</div>`;
        return;
    }

    container.innerHTML = `
        <table class="weekly-schedule-table">
            <thead><tr><th>День</th><th>Продукт</th><th>Фокус дня</th></tr></thead>
            <tbody>
                ${schedule.map(day => {
                    const product = productsData.find(p => p.id === day.product);
                    const accent = product ? product.badgeColor : 'var(--text-secondary)';
                    const accentBg = product ? product.badgeBg : 'rgba(255,255,255,0.08)';
                    return `
                    <tr style="--card-accent:${accent}; --card-accent-bg:${accentBg}">
                        <td><div class="wsd-day"><span class="wsd-day-dot"></span>${escapeHtml(day.label)}</div></td>
                        <td>${product ? `<span class="wsd-product-badge">${escapeHtml(product.title)}</span>` : '<span class="wsd-product-badge">Разное</span>'}</td>
                        <td class="wsd-focus">${escapeHtml(day.focus)}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>`;
}

function renderPostFormula() {
    const container = document.getElementById('post-formula-callout');
    if (!container) return;

    const formula = agentSettings.postFormula || '';
    if (!formula) {
        container.innerHTML = '';
        return;
    }

    const lines = formula.split('\n').filter(Boolean);
    const title = lines[0] || '';
    const steps = lines.slice(1).map(line => {
        const m = line.match(/^\d+\.\s*([^:]+):\s*(.+)$/);
        return m ? { label: m[1], text: m[2] } : { label: '', text: line };
    });

    container.innerHTML = `
        <div class="formula-callout-title">⚖️ ${escapeHtml(title)}</div>
        <div class="formula-steps">
            ${steps.map((s, i) => `
                <div class="formula-step">
                    <div class="formula-step-num">${i + 1}</div>
                    <div class="formula-step-text">${s.label ? `<b>${escapeHtml(s.label)}:</b> ` : ''}${escapeHtml(s.text)}</div>
                </div>`).join('')}
        </div>`;
}

// Textareas auto-grow to fit their content instead of showing an internal
// scrollbar - the fixed-height boxes with a scroll-and-resize-handle look
// were the main "ugly form" complaint about this board.
function autoGrowTextarea(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
}

function growTextareasIn(container) {
    if (!container) return;
    container.querySelectorAll('textarea').forEach(autoGrowTextarea);
}

function planSwatchesHtml(block) {
    return `<div class="plan-card-swatches">${PLAN_PALETTE.map(c =>
        `<button class="swatch ${c === block.color ? 'active' : ''}" style="background:${c}" title="${c}" onclick="setPlanBlockField('${block.id}','color','${c}')"></button>`
    ).join('')}</div>`;
}

function renderPlanNotes() {
    const container = document.getElementById('plan-notes-row');
    if (!container) return;

    const notes = contentPlanBlocks.filter(b => b.kind !== 'quarter');
    if (notes.length === 0) {
        container.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Заметок пока нет — добавьте первую.</div>`;
        return;
    }

    container.innerHTML = notes.map(block => `
        <div class="plan-card" style="--card-accent:${block.color || '#0a84ff'}">
            <div class="plan-card-head">
                <input type="text" class="plan-card-title" value="${escapeHtml(block.title)}" title="${escapeHtml(block.title)}" placeholder="Заголовок заметки" oninput="setPlanBlockField('${block.id}','title',this.value)">
                <div class="plan-card-actions">
                    <button class="icon-btn" title="Копировать" onclick="copyPlanBlock('${block.id}')">📋</button>
                    <button class="icon-btn" title="Удалить" onclick="removePlanBlock('${block.id}')">🗑</button>
                </div>
            </div>
            ${planSwatchesHtml(block)}
            <textarea class="plan-card-text" placeholder="Текст заметки..." oninput="autoGrowTextarea(this); setPlanBlockField('${block.id}','text',this.value)">${escapeHtml(block.text)}</textarea>
        </div>`).join('');
}

function renderPlanTimeline() {
    const container = document.getElementById('plan-timeline');
    if (!container) return;

    const quarters = contentPlanBlocks.filter(b => b.kind === 'quarter');
    if (quarters.length === 0) {
        container.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Кварталов пока нет — добавьте первый.</div>`;
        return;
    }

    container.innerHTML = quarters.map((block, idx) => {
        const qLabel = `Q${idx + 1}`;
        const isLast = idx === quarters.length - 1;
        const accent = block.color || '#0a84ff';
        return `
        <div class="timeline-row">
            <div class="timeline-marker">
                <span class="timeline-marker-dot" style="--card-accent:${accent}">${qLabel}</span>
                ${isLast ? '' : `<span class="timeline-marker-line" style="--card-accent:${accent}"></span>`}
            </div>
            <div class="timeline-card" style="--card-accent:${accent}">
                <div class="timeline-card-head">
                    <input type="text" class="timeline-card-title" value="${escapeHtml(block.title)}" title="${escapeHtml(block.title)}" placeholder="Продукт квартала" oninput="setPlanBlockField('${block.id}','title',this.value)">
                    <input type="text" class="timeline-card-period" value="${escapeHtml(block.period || '')}" placeholder="Например: Январь — Март" oninput="setPlanBlockField('${block.id}','period',this.value)">
                    <div class="plan-card-actions">
                        <button class="icon-btn" title="Копировать" onclick="copyPlanBlock('${block.id}')">📋</button>
                        <button class="icon-btn" title="Удалить" onclick="removePlanBlock('${block.id}')">🗑</button>
                    </div>
                </div>
                ${planSwatchesHtml(block)}
                <textarea class="timeline-card-text" placeholder="Смысловой вектор и B2B-оффер..." oninput="autoGrowTextarea(this); setPlanBlockField('${block.id}','text',this.value)">${escapeHtml(block.text)}</textarea>
            </div>
        </div>`;
    }).join('');
}

function setPlanBlockField(id, field, value) {
    const block = contentPlanBlocks.find(b => b.id === id);
    if (!block) return;
    block[field] = value;
    if (field === 'color') renderContentPlan();
}

function addPlanNote() {
    contentPlanBlocks.push({ id: String(Date.now()), kind: 'note', title: 'Новая заметка', color: '#0a84ff', text: '' });
    renderContentPlan();
}

function addPlanQuarter() {
    contentPlanBlocks.push({ id: String(Date.now()), kind: 'quarter', title: 'Новый квартал', period: '', color: '#0a84ff', text: '' });
    renderContentPlan();
}

function removePlanBlock(id) {
    contentPlanBlocks = contentPlanBlocks.filter(b => b.id !== id);
    renderContentPlan();
}

function copyPlanBlock(id) {
    const block = contentPlanBlocks.find(b => b.id === id);
    if (!block) return;
    const header = block.kind === 'quarter' ? `${block.title} (${block.period || ''})` : block.title;
    navigator.clipboard.writeText(`${header}\n\n${block.text}`);
    showToast('Блок скопирован в буфер!');
}

async function saveContentPlan() {
    try {
        const result = await api('/api/content-plan', { method: 'PUT', body: JSON.stringify({ blocks: contentPlanBlocks }) });
        contentPlanBlocks = result.blocks;
        renderContentPlan();
        showToast('Контент-план сохранён!');
    } catch (e) {
        showToast('Не удалось сохранить план: ' + e.message);
    }
}

// ЗАКАЗЧИКИ (скрипты живых звонков по нишам)
const NEW_NICHE_SECTIONS_TEMPLATE = [
    { id: 's1', heading: 'Приветствие', text: '' },
    { id: 's2', heading: 'Квалификация', text: '' },
    { id: 's3', heading: 'Боль', text: '' },
    { id: 's4', heading: 'Оффер / Питч', text: '' },
    { id: 's5', heading: 'Обработка возражений', text: '' },
    { id: 's6', heading: 'Закрытие', text: '' },
];

function renderClientsView() {
    const container = document.getElementById('niches-grid');
    if (!container) return;

    if (niches.length === 0) {
        container.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Ниш пока нет — добавьте первую.</div>`;
        return;
    }

    let html = '';
    niches.forEach(n => {
        const sectionsCount = (n.sections || []).length;
        html += `
        <div class="product-card" onclick="openNicheDetail('${n.id}')">
            <div>
                <div class="card-header">
                    <div class="card-title">${n.name}</div>
                    <span class="card-badge" style="background:rgba(10,132,255,0.15); color:var(--accent-blue)">${sectionsCount} раздел.</span>
                </div>
                <div class="card-desc">${n.subtitle || 'Без описания'}</div>
            </div>
            <div class="card-footer">
                <span>Открыть скрипт звонка</span>
                <span>→</span>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}

let nicheSectionCollapse = {}; // sectionId -> true (collapsed) - accordion state, edit mode only
let callMode = false; // false = edit (accordion), true = read-only "call mode"

function openNicheDetail(id) {
    currentOpenNicheId = id;
    callMode = false;
    const niche = niches.find(n => n.id === id);
    (niche?.sections || []).forEach(s => {
        if (!(s.id in nicheSectionCollapse)) nicheSectionCollapse[s.id] = true; // accordion starts collapsed
    });
    renderNicheDetailContent(id);
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-niche-detail').classList.add('active');
}

function closeNicheDetailPage() {
    currentOpenNicheId = null;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-clients').classList.add('active');
    renderClientsView();
}

function toggleCallMode() {
    callMode = !callMode;
    renderNicheDetailContent(currentOpenNicheId);
}

function renderNicheDetailContent(id) {
    const niche = niches.find(n => n.id === id);
    if (!niche) return;

    const titleEl = document.getElementById('niche-detail-title');
    if (titleEl) titleEl.innerText = niche.name;

    const toggleBtn = document.getElementById('niche-mode-toggle-btn');
    if (toggleBtn) toggleBtn.innerText = callMode ? '✏️ Редактировать' : '🎙 Режим звонка';

    const body = document.getElementById('niche-detail-body');
    if (!body) return;

    body.innerHTML = callMode ? renderCallModeHtml(niche) : renderEditModeHtml(niche);
}

// РЕЖИМ ЗВОНКА: крупный шрифт, только чтение, быстрые якоря по разделам
function renderCallModeHtml(niche) {
    const sections = niche.sections || [];
    let html = `
        <div class="call-mode-header">
            <div class="call-niche-name">${escapeHtml(niche.name)}</div>
            ${niche.subtitle ? `<div class="call-niche-subtitle">${escapeHtml(niche.subtitle)}</div>` : ''}
        </div>
        <div class="call-mode-nav">
            ${sections.map(s => `<button class="call-nav-pill" onclick="scrollToCallSection('${s.id}')">${escapeHtml(s.heading)}</button>`).join('')}
        </div>`;

    sections.forEach(s => {
        html += `
        <div class="call-section" id="call-section-${s.id}">
            <h2>${escapeHtml(s.heading)}</h2>
            <p>${escapeHtml(s.text)}</p>
        </div>`;
    });

    if (sections.length === 0) {
        html += `<div class="info-box" style="text-align:center; color:var(--text-secondary);">В скрипте пока нет разделов.</div>`;
    }
    return html;
}

function scrollToCallSection(id) {
    document.getElementById(`call-section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// РЕЖИМ РЕДАКТИРОВАНИЯ: аккордеон, чтобы длинные разделы не превращали страницу в стену textarea
function renderEditModeHtml(niche) {
    let html = `
        <label class="form-label" style="margin-top:0;">Название ниши:</label>
        <input type="text" id="niche-name-input" class="form-input" value="${escapeHtml(niche.name)}">

        <label class="form-label">Описание / когда использовать:</label>
        <input type="text" id="niche-subtitle-input" class="form-input" value="${escapeHtml(niche.subtitle || '')}" placeholder="Например: холодные звонки владельцам кальянных">

        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:24px;">
            <div class="p-section-title" style="margin:0;">СКРИПТ ЖИВОГО ЗВОНКА</div>
            <div style="display:flex; gap:6px;">
                <button class="edit-btn" style="font-size:11px; padding:6px 10px;" onclick="expandAllNicheSections(true)">Развернуть все</button>
                <button class="edit-btn" style="font-size:11px; padding:6px 10px;" onclick="expandAllNicheSections(false)">Свернуть все</button>
            </div>
        </div>
        <div id="niche-sections-list">`;

    (niche.sections || []).forEach((s, idx) => {
        const collapsed = Boolean(nicheSectionCollapse[s.id]);
        html += `
        <div class="script-section-card">
            <div class="script-section-head ${collapsed ? '' : 'expanded'}" onclick="toggleNicheSection('${s.id}')">
                <span class="section-chevron">${collapsed ? '▶' : '▼'}</span>
                <input type="text" class="form-input script-section-heading" value="${escapeHtml(s.heading)}" placeholder="Название раздела" onclick="event.stopPropagation()" oninput="setNicheSectionField(${idx}, 'heading', this.value)">
                <button class="delete-btn" onclick="event.stopPropagation(); removeNicheSection(${idx})">🗑</button>
            </div>
            ${collapsed ? '' : `
                <textarea class="form-textarea script-section-text" placeholder="Текст раздела скрипта..." onclick="event.stopPropagation()" oninput="setNicheSectionField(${idx}, 'text', this.value)">${escapeHtml(s.text)}</textarea>
                <div style="display:flex; gap:8px; margin:-6px 0 10px;" onclick="event.stopPropagation()">
                    <input type="text" class="form-input" id="niche-section-prompt-${s.id}" style="margin:0;" placeholder="Что сгенерировать для этого раздела...">
                    <button class="edit-btn" style="flex-shrink:0;" title="Сгенерировать через local-claude-agent на вашем ПК" onclick="generateNicheSectionText(${idx}, '${s.id}')">✨</button>
                </div>
                <div id="niche-section-status-${s.id}" style="font-size:11px; color:var(--text-secondary); min-height:14px; margin:-6px 0 10px;"></div>`}
        </div>`;
    });

    html += `</div>
        <button class="edit-btn" style="width:100%; margin-top:8px;" onclick="addNicheSection()">+ Добавить раздел</button>
        <div class="info-box" style="margin-top:16px; font-size:12px; color:var(--text-secondary);">
            Генерация каждого раздела использует общий «Тон голоса» из настроек Центра агентов плюс промпт, который вы укажете для конкретного раздела — так стиль остаётся единым по всему скрипту, даже если разделы генерируются по отдельности.
        </div>
        <button class="submit-btn" style="margin-top:16px;" onclick="saveNicheDetail()">Сохранить скрипт</button>
        <button class="delete-btn" style="width:100%; margin-top:8px; justify-content:center;" onclick="deleteNiche('${niche.id}')">🗑 Удалить нишу</button>`;

    return html;
}

function toggleNicheSection(id) {
    nicheSectionCollapse[id] = !nicheSectionCollapse[id];
    renderNicheDetailContent(currentOpenNicheId);
}

function expandAllNicheSections(expand) {
    const niche = niches.find(n => n.id === currentOpenNicheId);
    if (!niche) return;
    (niche.sections || []).forEach(s => { nicheSectionCollapse[s.id] = !expand; });
    renderNicheDetailContent(currentOpenNicheId);
}

function setNicheSectionField(idx, field, value) {
    const niche = niches.find(n => n.id === currentOpenNicheId);
    if (niche && niche.sections[idx]) niche.sections[idx][field] = value;
}

// Fills a section's text via local-claude-agent from the per-section prompt
// input next to it - only updates the in-memory niche.sections (same as
// typing directly into the textarea), still requires the page's own
// "Сохранить скрипт" to persist, consistent with how every other edit here
// works.
async function generateNicheSectionText(idx, sectionId) {
    const niche = niches.find(n => n.id === currentOpenNicheId);
    if (!niche || !niche.sections[idx]) return;
    const promptInput = document.getElementById(`niche-section-prompt-${sectionId}`);
    const prompt = promptInput ? promptInput.value.trim() : '';
    if (!prompt) return showToast('Опишите, что сгенерировать для этого раздела');

    const btn = event && event.target;
    const status = document.getElementById(`niche-section-status-${sectionId}`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    if (status) status.textContent = 'Генерируем через ИИ на вашем ПК...';
    try {
        const result = await api(`/api/niches/${niche.id}/sections/${sectionId}/generate`, { method: 'POST', body: JSON.stringify({ prompt }) });
        niche.sections[idx].text = result.text;
        renderNicheDetailContent(currentOpenNicheId);
        showToast('Текст раздела сгенерирован — не забудьте сохранить скрипт');
    } catch (e) {
        if (status) status.textContent = 'Ошибка: ' + e.message;
        showToast('Не удалось сгенерировать: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✨'; }
    }
}

function addNicheSection() {
    const niche = niches.find(n => n.id === currentOpenNicheId);
    if (!niche) return;
    niche.sections = niche.sections || [];
    const newSection = { id: String(Date.now()), heading: 'Новый раздел', text: '' };
    niche.sections.push(newSection);
    nicheSectionCollapse[newSection.id] = false; // open the freshly added section
    renderNicheDetailContent(currentOpenNicheId);
}

function removeNicheSection(idx) {
    const niche = niches.find(n => n.id === currentOpenNicheId);
    if (!niche) return;
    niche.sections.splice(idx, 1);
    renderNicheDetailContent(currentOpenNicheId);
}

async function saveNicheDetail() {
    const niche = niches.find(n => n.id === currentOpenNicheId);
    if (!niche) return;

    const name = document.getElementById('niche-name-input').value.trim();
    const subtitle = document.getElementById('niche-subtitle-input').value.trim();
    if (!name) return alert('Укажите название ниши');

    try {
        const updated = await api(`/api/niches/${niche.id}`, { method: 'PUT', body: JSON.stringify({ name, subtitle, sections: niche.sections }) });
        niches = niches.map(n => n.id === niche.id ? updated : n);
        const titleEl = document.getElementById('niche-detail-title');
        if (titleEl) titleEl.innerText = updated.name;
        showToast('Скрипт сохранён!');
    } catch (e) {
        showToast('Не удалось сохранить: ' + e.message);
    }
}

async function deleteNiche(id) {
    if (!confirm('Удалить эту нишу вместе со скриптом?')) return;
    try {
        await api(`/api/niches/${id}`, { method: 'DELETE' });
        niches = niches.filter(n => n.id !== id);
        closeNicheDetailPage();
        showToast('Ниша удалена');
    } catch (e) {
        showToast('Не удалось удалить: ' + e.message);
    }
}

function openNewNicheModal() {
    document.getElementById('new-niche-name-input').value = '';
    document.getElementById('new-niche-subtitle-input').value = '';
    openOverlay('new-niche-overlay');
}

async function createNiche() {
    const name = document.getElementById('new-niche-name-input').value.trim();
    const subtitle = document.getElementById('new-niche-subtitle-input').value.trim();
    if (!name) return alert('Укажите название ниши');

    try {
        const created = await api('/api/niches', {
            method: 'POST',
            body: JSON.stringify({ name, subtitle, sections: NEW_NICHE_SECTIONS_TEMPLATE }),
        });
        niches.push(created);
        closeOverlay('new-niche-overlay');
        renderClientsView();
        showToast('Ниша создана!');
        openNicheDetail(created.id);
    } catch (e) {
        showToast('Не удалось создать нишу: ' + e.message);
    }
}

// ПРОВЕРКА САЙТА (legitAgent legal scan + load test)
let urlCheckerLastReport = null;

async function runUrlCheck() {
    const input = document.getElementById('url-checker-input');
    const btn = document.getElementById('url-checker-scan-btn');
    const requestCountInput = document.getElementById('url-checker-requestcount-input');
    const concurrencyInput = document.getElementById('url-checker-concurrency-input');
    const durationInput = document.getElementById('url-checker-duration-input');
    const modeInput = document.getElementById('url-checker-mode-input');
    const url = input.value.trim();
    if (!url) return showToast('Введите URL');

    const mode = modeInput?.value === 'live' ? 'live' : 'fast';
    const requestCount = Math.max(1, Math.min(5000, Number(requestCountInput?.value) || 100));
    // Empty concurrency field = let the server auto-scale it to the request
    // count (see urlChecker.js) - only send a value when the user actually
    // typed one, to keep that auto behavior as the default.
    const concurrency = concurrencyInput?.value ? Math.max(1, Math.min(50, Number(concurrencyInput.value))) : undefined;
    const durationMs = Math.max(1000, Math.min(120000, (Number(durationInput?.value) || 15) * 1000));

    btn.disabled = true;
    btn.textContent = 'Проверяю...';
    const loadingText = mode === 'live'
        ? 'Открываю сайт в браузере (полная проверка), это займёт больше времени...'
        : 'Сканирую сайт и запускаю нагрузочный тест...';
    document.getElementById('url-checker-results').innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary); margin-top:20px;">${loadingText}</div>`;

    const liveView = document.getElementById('url-checker-live-view');
    if (mode === 'live') {
        // Live browser session runs on parser-worker's own Xvfb/Chromium - the
        // iframe just points at the existing noVNC endpoint so you can watch
        // it work, not something this request drives directly.
        document.getElementById('url-checker-live-iframe').src = '/vnc/vnc.html?autoconnect=true&resize=scale&view_only=true';
        liveView.style.display = '';
    } else {
        liveView.style.display = 'none';
    }

    try {
        const report = await api('/api/url-checker/scan', { method: 'POST', body: JSON.stringify({ url, mode, requestCount, concurrency, durationMs }) });
        urlCheckerLastReport = report;
        renderUrlCheckReport(report);
    } catch (e) {
        document.getElementById('url-checker-results').innerHTML = `<div class="info-box" style="text-align:center; color:var(--accent-red); margin-top:20px;">Ошибка: ${escapeHtml(e.message)}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Проверить';
        if (mode === 'live') {
            liveView.style.display = 'none';
            document.getElementById('url-checker-live-iframe').src = '';
        }
    }
}

// Horizontal CSS bar (no chart library / no SVG) - width is a percentage of
// the largest value in the set, floored so a non-zero value always shows a
// sliver of color.
function ucBarRow(label, value, maxValue, unit, color) {
    const pct = maxValue > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / maxValue) * 100)) : 0;
    return `
        <div class="uc-bar-row">
            <span class="uc-bar-label">${escapeHtml(label)}</span>
            <div class="uc-bar-track"><div class="uc-bar-fill" style="width:${pct}%; background:${color || 'var(--accent-blue)'};"></div></div>
            <span class="uc-bar-value">${value ?? '—'}${unit || ''}</span>
        </div>`;
}

function renderResponseTimeChart(lt) {
    const rows = [
        ['Min', lt.minMs],
        ['Avg', lt.avgMs],
        ['p50', lt.p50Ms],
        ['p95', lt.p95Ms],
        ['Max', lt.maxMs],
    ];
    const maxValue = Math.max(1, ...rows.map(([, v]) => v || 0));
    return `<div class="uc-chart">${rows.map(([label, v]) => ucBarRow(label, v || 0, maxValue, ' мс')).join('')}</div>`;
}

function renderStatusCodeChart(lt) {
    const counts = lt.statusCounts || {};
    const entries = Object.entries(counts).filter(([, c]) => c > 0);
    if (entries.length === 0) return '';
    const maxValue = Math.max(1, ...entries.map(([, c]) => c));
    const colorFor = (status) => {
        const code = Number(status);
        if (code >= 200 && code < 300) return 'var(--accent-green)';
        if (code >= 300 && code < 400) return 'var(--accent-blue)';
        if (code >= 400 && code < 500) return 'var(--accent-orange)';
        return 'var(--accent-red)'; // 5xx and 0 (network error)
    };
    const rowsHtml = entries
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([status, count]) => ucBarRow(status === '0' ? 'err' : status, count, maxValue, '', colorFor(status)))
        .join('');
    return `<div class="uc-chart">${rowsHtml}</div>`;
}

function renderUrlCheckReport(report) {
    const container = document.getElementById('url-checker-results');
    const health = report.health || {};
    const findings = report.findings || [];
    const summary = report.findingsSummary || {};
    const lt = report.loadTest || {};

    const healthStats = health.ok !== undefined ? `
        <div class="uc-stat"><span class="uc-stat-label">Статус</span><span class="uc-stat-value">${health.status ?? '—'}</span></div>
        <div class="uc-stat"><span class="uc-stat-label">HTTPS</span><span class="uc-stat-value" style="color:${health.https ? 'var(--accent-green)' : 'var(--accent-red)'}">${health.https ? 'да' : 'нет'}</span></div>
        <div class="uc-stat"><span class="uc-stat-label">Ответ</span><span class="uc-stat-value">${health.responseTimeMs ?? '—'} мс</span></div>
    ` : `<div class="uc-stat"><span class="uc-stat-label">Ошибка</span><span class="uc-stat-value" style="color:var(--accent-red)">${escapeHtml(health.error || 'нет данных')}</span></div>`;

    const missingHeaders = health.securityHeaders
        ? Object.entries(health.securityHeaders).filter(([, v]) => !v).map(([k]) => k)
        : [];

    const severityColor = { high: 'var(--accent-red)', medium: 'var(--accent-orange)', low: 'var(--text-secondary)' };
    const severityBg = { high: 'rgba(255,69,58,0.15)', medium: 'rgba(255,159,10,0.15)', low: 'rgba(255,255,255,0.08)' };

    const verdictInfoFor = (v) => ({
        confirm: { label: 'ИИ подтверждает нарушение', color: 'var(--accent-red)' },
        reject: { label: 'ИИ считает ложным срабатыванием', color: 'var(--text-secondary)' },
        ask_human: { label: 'ИИ рекомендует проверить вручную', color: 'var(--accent-orange)' },
    }[v]);

    const findingsHtml = findings.length === 0
        ? `<div class="info-box" style="color:var(--text-secondary);">Находок не обнаружено статическим анализом HTML.</div>`
        : findings.map(f => {
            const verdictInfo = verdictInfoFor(f.verdict);
            return `
            <div class="uc-finding">
                <div class="uc-finding-head">
                    <span class="format-tag" style="background:${severityBg[f.severity] || severityBg.low}; color:${severityColor[f.severity] || severityColor.low}">${escapeHtml(String(f.severity || '').toUpperCase())}</span>
                    <b>${escapeHtml(f.ruleId || '')}</b>
                </div>
                <div class="idea-desc-text">${escapeHtml(f.message || '')}</div>
                ${f.fix ? `<div style="color:var(--accent-green); font-size:12px;">Исправление: ${escapeHtml(f.fix)}</div>` : ''}
                ${f.legalExcerpt ? `<div style="color:var(--text-secondary); font-size:11px; margin-top:4px;">${escapeHtml(f.legalExcerpt.law || '')}${f.legalExcerpt.article ? ' ' + escapeHtml(f.legalExcerpt.article) : ''}: «${escapeHtml(f.legalExcerpt.text || '')}»</div>` : ''}
                ${verdictInfo ? `<div style="color:${verdictInfo.color}; font-size:11px; margin-top:4px;">${verdictInfo.label}${f.verdictReason ? ': ' + escapeHtml(f.verdictReason) : ''}</div>` : ''}
            </div>`;
        }).join('');

    const loadTestHtml = lt.error
        ? `<div class="info-box" style="color:var(--accent-red);">Ошибка нагрузочного теста: ${escapeHtml(lt.error)}</div>`
        : `<div class="uc-stats-row" style="margin-bottom:12px;">
            <div class="uc-stat"><span class="uc-stat-label">Запросов</span><span class="uc-stat-value">${lt.totalRequests ?? '—'}</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Ошибок</span><span class="uc-stat-value">${lt.errors ?? 0} (${Math.round((lt.errorRate || 0) * 100)}%)</span></div>
            <div class="uc-stat"><span class="uc-stat-label">RPS</span><span class="uc-stat-value">${lt.requestsPerSecond ?? '—'}</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Средний</span><span class="uc-stat-value">${lt.avgMs ?? '—'} мс</span></div>
            <div class="uc-stat"><span class="uc-stat-label">p95</span><span class="uc-stat-value">${lt.p95Ms ?? '—'} мс</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Макс</span><span class="uc-stat-value">${lt.maxMs ?? '—'} мс</span></div>
        </div>
        <div class="uc-stats-row" style="align-items:flex-start;">
            <div style="flex:1; min-width:260px;">
                <div class="uc-stat-label" style="margin-bottom:6px;">Время ответа, мс</div>
                ${renderResponseTimeChart(lt)}
            </div>
            ${renderStatusCodeChart(lt) ? `<div style="flex:1; min-width:200px;">
                <div class="uc-stat-label" style="margin-bottom:6px;">Коды ответов</div>
                ${renderStatusCodeChart(lt)}
            </div>` : ''}
        </div>`;

    const cookieBanner = report.cookieBanner;
    const cookieBannerHtml = cookieBanner ? `
        <div class="info-box" style="margin-top:10px; color:${cookieBanner.clicked ? 'var(--accent-green)' : 'var(--text-secondary)'};">
            ${cookieBanner.clicked
                ? `Баннер cookie обнаружен, нажата кнопка отклонения: «${escapeHtml(cookieBanner.buttonText || '')}»`
                : cookieBanner.detected
                    ? 'Баннер cookie обнаружен, но кнопка отклонения не найдена с уверенностью — не нажималась.'
                    : 'Баннер cookie не обнаружен.'}
        </div>` : '';

    container.innerHTML = `
        <div class="p-section-title" style="margin-top:20px;">ДОСТУПНОСТЬ${report.mode === 'live' ? ' (полная проверка, с браузером)' : ''}</div>
        <div class="uc-stats-row">${healthStats}</div>
        ${missingHeaders.length ? `<div class="warning-banner" style="margin-top:10px;">Отсутствуют заголовки безопасности: ${missingHeaders.join(', ')}</div>` : ''}
        ${cookieBannerHtml}

        <div class="p-section-title" style="margin-top:24px;">ЮРИДИЧЕСКИЕ РИСКИ (152-ФЗ / 38-ФЗ / ЗоЗПП) — найдено ${findings.length}</div>
        <div class="uc-stats-row" style="margin-bottom:12px;">
            <div class="uc-stat"><span class="uc-stat-label">Критично</span><span class="uc-stat-value" style="color:var(--accent-red)">${summary.high || 0}</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Средне</span><span class="uc-stat-value" style="color:var(--accent-orange)">${summary.medium || 0}</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Низко</span><span class="uc-stat-value">${summary.low || 0}</span></div>
        </div>
        ${report.legalReview?.available ? `<div style="color:var(--text-secondary); font-size:11px; margin-bottom:8px;">✓ Находки проверены ИИ (снижает число ложных срабатываний)</div>` : ''}
        <div class="uc-findings-list">${findingsHtml}</div>

        <div class="p-section-title" style="margin-top:24px;">НАГРУЗОЧНЫЙ ТЕСТ</div>
        ${lt.hitDurationCap ? `<div class="warning-banner" style="margin-bottom:10px;">Остановлено по таймауту (${Math.round((lt.durationMs || 0) / 1000)} сек, задано в «Макс. время теста») — не дошли до заданного числа запросов (${lt.requestCount}), успели сделать ${lt.totalRequests}. При ${lt.concurrency} одновременных запросах это физический предел — увеличьте лимит времени или конкурентность, если нужно больше.</div>` : ''}
        ${loadTestHtml}

        <div class="controls-row" style="margin-top:24px;">
            <p style="color:var(--text-secondary); font-size:11px; margin:0;">Эвристическая проверка, не юридическое заключение. Нагрузочный тест — только для своих/клиентских проектов.</p>
            <button class="edit-btn" id="url-checker-pdf-btn" onclick="generateUrlCheckPdf()">📄 Сформировать и скачать PDF</button>
        </div>
    `;
}

async function generateUrlCheckPdf() {
    if (!urlCheckerLastReport) return;
    const btn = document.getElementById('url-checker-pdf-btn');
    if (btn) {
        btn.disabled = true;
        btn.dataset.originalText = btn.textContent;
        btn.textContent = 'Формирую...';
    }
    try {
        const res = await fetch('/api/url-checker/pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(urlCheckerLastReport),
        });
        if (!res.ok) throw new Error('Не удалось сформировать PDF');
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `site-check-${Date.now()}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
        showToast('PDF готов, скачивание началось!');
    } catch (e) {
        showToast('Ошибка: ' + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = btn.dataset.originalText || '📄 Сформировать и скачать PDF';
        }
    }
}

// ЗАКАЗЧИКИ (2ГИС-парсер по нишам)
let parserNiches = [];
let parserPollTimers = {};
// Version history is fetched lazily (only once a card's "История версий" is
// expanded) rather than joined into every /api/parser-niches poll - the grid
// re-fetches/re-draws every 4s while any niche is active, and most cards
// never open their history, so eagerly loading it would be wasted work on
// every single poll tick for the common case.
let parserNicheVersions = {};     // niche id -> array of version rows, once fetched
let parserNicheVersionsOpen = {}; // niche id -> bool, whether the section is expanded
let parserNichePitchOpen = {}; // niche id -> bool, whether the cold-call pitch section is expanded

async function renderParserNiches() {
    const container = document.getElementById('parser-niches-grid');
    if (!container) return;
    try {
        parserNiches = await api('/api/parser-niches');
    } catch (e) {
        container.innerHTML = `<div class="info-box" style="text-align:center; color:var(--accent-red);">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
        return;
    }
    drawParserNiches();
    parserNiches.forEach(n => {
        if (['queued', 'running', 'captcha', 'dedupe_running'].includes(n.status)) startParserPolling(n.id);
    });
}

function drawParserNiches() {
    const container = document.getElementById('parser-niches-grid');
    if (!container) return;

    // Polling ticks re-run this every 4s while any niche is active - skip the
    // rebuild if the user is mid-edit in any card's text input, otherwise a
    // status refresh wipes their unsaved keystrokes and steals focus.
    const activeEl = document.activeElement;
    if (activeEl && container.contains(activeEl) && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        return;
    }

    if (parserNiches.length === 0) {
        container.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Ниш пока нет — добавьте первую кнопкой выше.</div>`;
        return;
    }

    const statusLabels = {
        idle: 'Не запущено', queued: 'В очереди', running: 'Парсинг идёт',
        captcha: 'Ждёт капчу', dedupe_running: 'Чистка дублей', done: 'Готово', error: 'Ошибка', cancelled: 'Остановлено',
    };
    const isActive = n => ['queued', 'running', 'captcha', 'dedupe_running'].includes(n);

    container.innerHTML = parserNiches.map(n => `
        <div class="parser-niche-card" id="parser-card-${n.id}">
            <div class="parser-niche-head">
                <input type="text" class="form-input" style="font-weight:700;" value="${escapeHtml(n.category)}"
                    placeholder="Например: кальянные" onblur="saveParserNicheField('${n.id}','category',this.value)">
                <input type="text" class="form-input" style="margin:0; max-width:180px;" value="${escapeHtml(n.city || 'Москва')}"
                    placeholder="Город (любой)" title="Город для поиска в 2ГИС — определяется автоматически при первом запуске для этого города"
                    onblur="saveParserNicheField('${n.id}','city',this.value)">
                <span class="parser-niche-status ${n.status}">${statusLabels[n.status] || n.status}</span>
            </div>
            <div style="display:flex; gap:8px; align-items:flex-start;">
                <textarea class="form-textarea" style="margin-bottom:0; min-height:52px;" id="parser-desc-${n.id}"
                    placeholder="Ключевые слова/синонимы для 2ГИС через запятую (первые 8 уникальных слов реально используются в поиске — не пишите связным текстом)"
                    onblur="saveParserNicheField('${n.id}','description',this.value)">${escapeHtml(n.description)}</textarea>
                <button class="edit-btn" style="flex-shrink:0;" title="Сгенерировать через local-claude-agent на вашем ПК" onclick="generateNicheDescription('${n.id}')">✨</button>
            </div>
            <div id="parser-desc-status-${n.id}" style="font-size:11px; color:var(--text-secondary); min-height:14px; margin-top:2px;"></div>

            <div class="parser-niche-console" id="parser-log-${n.id}">${escapeHtml(n.log || '')}</div>

            <div class="parser-niche-files">
                ${n.files.raw ? `<div class="parser-file-badge" onclick="downloadParserFile('${n.id}','raw')">📊 raw.xlsx</div>` : ''}
                ${n.files.dedup ? `<div class="parser-file-badge" onclick="downloadParserFile('${n.id}','dedup')">✨ dedup.xlsx</div>` : ''}
                ${n.files.archive ? `<div class="parser-file-badge" onclick="downloadParserFile('${n.id}','archive')">🗄 archive.zip</div>` : ''}
            </div>

            <div class="parser-niche-versions">
                <button type="button" class="parser-niche-versions-toggle" onclick="toggleParserNicheVersions('${n.id}')">
                    📜 История версий ${parserNicheVersionsOpen[n.id] ? '▴' : '▾'}
                </button>
                ${parserNicheVersionsOpen[n.id] ? renderParserNicheVersionsList(n.id) : ''}
            </div>

            <div class="parser-niche-versions">
                <button type="button" class="parser-niche-versions-toggle" onclick="toggleParserNichePitch('${n.id}')">
                    💬 Предложение для холодных звонков ${parserNichePitchOpen[n.id] ? '▴' : '▾'}
                </button>
                ${parserNichePitchOpen[n.id] ? `
                    <div style="margin-top:8px;">
                        <div style="display:flex; gap:8px; margin-bottom:6px;">
                            <input type="text" class="form-input" style="margin:0;" id="parser-pitch-prompt-${n.id}" placeholder="Что учесть при генерации (кейс из портфолио, акцент)...">
                            <button class="edit-btn" style="flex-shrink:0;" title="Сгенерировать через local-claude-agent на вашем ПК" onclick="generateParserNichePitch('${n.id}')">✨</button>
                        </div>
                        <div id="parser-pitch-status-${n.id}" style="font-size:11px; color:var(--text-secondary); min-height:14px; margin-bottom:4px;"></div>
                        <textarea class="form-textarea" style="min-height:160px; font-size:12.5px;" id="parser-pitch-text-${n.id}"
                            placeholder="Текст сообщения, которое отправляете лиду в Telegram, если он ещё думает..."
                            onblur="saveParserNicheField('${n.id}','coldCallPitch',this.value)">${escapeHtml(n.coldCallPitch || '')}</textarea>
                        <button class="edit-btn" style="margin-top:6px;" onclick="copyParserNichePitch('${n.id}')">📋 Скопировать</button>
                    </div>
                ` : ''}
            </div>

            <div class="parser-niche-actions">
                <button class="schedule-btn" onclick="runParserNiche('${n.id}')" ${isActive(n.status) ? 'disabled' : ''}>▶ Обновить парсер</button>
                ${isActive(n.status) ? `<button class="delete-btn" onclick="cancelParserNiche('${n.id}')">⏹ Стоп</button>` : ''}
                ${n.status === 'captcha' ? `<a class="edit-btn" href="/vnc/vnc.html?autoconnect=true" target="_blank" style="text-decoration:none;">🖥 Открыть VNC</a>` : ''}
                <label class="edit-btn parser-upload-btn" ${isActive(n.status) ? 'style="opacity:.5; pointer-events:none;"' : ''}>
                    📤 Загрузить Excel
                    <input type="file" accept=".xlsx" style="display:none;" onchange="uploadParserNicheFile('${n.id}', this)">
                </label>
                ${n.files.raw && n.jobId && !n.files.dedup ? `<button class="edit-btn" onclick="dedupeParserNiche('${n.id}')">🧹 Удалить дубликаты</button>` : ''}
                ${n.canDedupeUpload && !n.files.dedup ? `<button class="edit-btn" onclick="dedupeParserNicheUpload('${n.id}')">🧹 Удалить дубликаты</button>` : ''}
                ${n.files.raw && n.jobId ? `<button class="edit-btn" onclick="archiveParserNiche('${n.id}')">🗄 Архивировать</button>` : ''}
                <button class="delete-btn" onclick="removeParserNiche('${n.id}')">Удалить</button>
            </div>
        </div>
    `).join('');

    parserNiches.forEach(n => {
        const logEl = document.getElementById(`parser-log-${n.id}`);
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
}

async function addParserNicheCard() {
    try {
        const created = await api('/api/parser-niches', {
            method: 'POST',
            body: JSON.stringify({ category: 'Новая ниша', description: '' }),
        });
        parserNiches.push(created);
        drawParserNiches();
    } catch (e) {
        showToast('Не удалось создать нишу: ' + e.message);
    }
}

async function saveParserNicheField(id, field, value) {
    const niche = parserNiches.find(n => n.id === id);
    if (!niche || niche[field] === value) return;
    const previous = niche[field];
    niche[field] = value;
    try {
        await api(`/api/parser-niches/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) });
    } catch (e) {
        niche[field] = previous;
        drawParserNiches();
        showToast('Не удалось сохранить: ' + e.message);
    }
}

// "✨" рядом с описанием ниши - просит local-claude-agent (на ПК пользователя)
// написать описание по названию ниши. Подставляет текст в поле, но не
// сохраняет сам - saveParserNicheField сработает как обычно по onblur/явному
// сохранению, чтобы пользователь успел поправить текст перед сохранением.
async function generateNicheDescription(id) {
    const input = document.getElementById(`parser-desc-${id}`);
    if (!input) return;
    const btn = event && event.target;
    const status = document.getElementById(`parser-desc-status-${id}`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    // Separate from the parser-run console below it (parser-log-${id}) - that
    // one only reflects 2ГИС scrape progress and stays empty/unrelated during
    // this call, which was confusing when they sat right next to each other.
    if (status) status.textContent = 'Генерируем через ИИ на вашем ПК (local-claude-agent)...';
    try {
        const result = await api(`/api/parser-niches/${id}/generate-description`, { method: 'POST' });
        input.value = result.description;
        await saveParserNicheField(id, 'description', result.description);
        if (status) status.textContent = 'Готово.';
        showToast('Описание сгенерировано');
    } catch (e) {
        if (status) status.textContent = 'Ошибка: ' + e.message;
        showToast('Не удалось сгенерировать: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✨'; }
        if (status) setTimeout(() => { status.textContent = ''; }, 4000);
    }
}

function toggleParserNichePitch(id) {
    parserNichePitchOpen[id] = !parserNichePitchOpen[id];
    drawParserNiches();
}

async function generateParserNichePitch(id) {
    const textarea = document.getElementById(`parser-pitch-text-${id}`);
    if (!textarea) return;
    const promptInput = document.getElementById(`parser-pitch-prompt-${id}`);
    const prompt = promptInput ? promptInput.value.trim() : '';
    const btn = event && event.target;
    const status = document.getElementById(`parser-pitch-status-${id}`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    if (status) status.textContent = 'Генерируем через ИИ на вашем ПК (Sonnet)...';
    try {
        const result = await api(`/api/parser-niches/${id}/generate-pitch`, { method: 'POST', body: JSON.stringify({ prompt }) });
        textarea.value = result.text;
        await saveParserNicheField(id, 'coldCallPitch', result.text);
        if (status) status.textContent = 'Готово.';
        showToast('Предложение сгенерировано');
    } catch (e) {
        if (status) status.textContent = 'Ошибка: ' + e.message;
        showToast('Не удалось сгенерировать: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✨'; }
        if (status) setTimeout(() => { status.textContent = ''; }, 4000);
    }
}

function copyParserNichePitch(id) {
    const textarea = document.getElementById(`parser-pitch-text-${id}`);
    if (!textarea || !textarea.value.trim()) return showToast('Сначала сгенерируйте или напишите текст');
    navigator.clipboard.writeText(textarea.value);
    showToast('Скопировано в буфер обмена');
}

async function runParserNiche(id) {
    const btn = event && event.target;
    if (btn) btn.disabled = true;
    try {
        const updated = await api(`/api/parser-niches/${id}/run`, { method: 'POST' });
        const idx = parserNiches.findIndex(n => n.id === id);
        if (idx !== -1) parserNiches[idx] = updated;
        drawParserNiches();
        startParserPolling(id);
        showToast('Парсер запущен, следите за логом в карточке');
    } catch (e) {
        if (btn) btn.disabled = false;
        showToast('Не удалось запустить парсер: ' + e.message);
    }
}

function startParserPolling(id) {
    if (parserPollTimers[id]) return;
    parserPollTimers[id] = setInterval(async () => {
        try {
            const updated = await api(`/api/parser-niches/${id}/status`);
            const idx = parserNiches.findIndex(n => n.id === id);
            if (idx !== -1) parserNiches[idx] = updated;
            drawParserNiches();
            if (!['queued', 'running', 'captcha', 'dedupe_running'].includes(updated.status)) {
                clearInterval(parserPollTimers[id]);
                delete parserPollTimers[id];
            }
        } catch (e) {
            clearInterval(parserPollTimers[id]);
            delete parserPollTimers[id];
        }
    }, 4000);
}

async function cancelParserNiche(id) {
    try {
        await api(`/api/parser-niches/${id}/cancel`, { method: 'POST' });
        showToast('Останавливаю...');
    } catch (e) {
        showToast('Не удалось остановить: ' + e.message);
    }
}

async function dedupeParserNiche(id) {
    try {
        await api(`/api/parser-niches/${id}/dedupe`, { method: 'POST' });
        startParserPolling(id);
        showToast('Чистка дублей запущена');
    } catch (e) {
        showToast('Ошибка: ' + e.message);
    }
}

// Dedupe for an uploaded (not scraped) raw file - runs synchronously
// server-side (no worker/job_id involved), so unlike dedupeParserNiche
// above this doesn't need polling - the response already carries the result.
async function dedupeParserNicheUpload(id) {
    const btn = event && event.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
        const updated = await api(`/api/parser-niches/${id}/upload/dedupe`, { method: 'POST' });
        const idx = parserNiches.findIndex(n => n.id === id);
        if (idx !== -1) parserNiches[idx] = updated;
        drawParserNiches();
        showToast('Дубликаты удалены');
    } catch (e) {
        showToast('Ошибка: ' + e.message);
        if (btn) { btn.disabled = false; btn.textContent = '🧹 Удалить дубликаты'; }
    }
}

async function archiveParserNiche(id) {
    try {
        await api(`/api/parser-niches/${id}/archive`, { method: 'POST' });
        const updated = await api(`/api/parser-niches/${id}/status`);
        const idx = parserNiches.findIndex(n => n.id === id);
        if (idx !== -1) parserNiches[idx] = updated;
        drawParserNiches();
        showToast('Архив собран');
    } catch (e) {
        showToast('Ошибка: ' + e.message);
    }
}

function downloadParserFile(id, kind) {
    window.open(`/api/parser-niches/${id}/download/${kind}`, '_blank');
}

const PARSER_VERSION_KIND_LABELS = { raw: '📊 raw', dedup: '✨ dedup', archive: '🗄 archive' };

function renderParserNicheVersionsList(id) {
    const versions = parserNicheVersions[id];
    if (!versions) {
        return `<div class="parser-niche-versions-list"><div class="parser-niche-versions-empty">Загрузка…</div></div>`;
    }
    if (versions.length === 0) {
        return `<div class="parser-niche-versions-list"><div class="parser-niche-versions-empty">Пока нет сохранённых версий</div></div>`;
    }
    return `<div class="parser-niche-versions-list">${versions.map(v => `
        <div class="parser-niche-version-row" onclick="downloadParserNicheVersion('${id}','${v.id}')">
            <span class="parser-niche-version-kind">${PARSER_VERSION_KIND_LABELS[v.kind] || escapeHtml(v.kind)}</span>
            <span class="parser-niche-version-name">${escapeHtml(v.filename || '')}</span>
            <span class="parser-niche-version-date">${formatAcTimestamp(v.createdAt)}</span>
        </div>
    `).join('')}</div>`;
}

// Toggles a card's "История версий" section - fetches the version list from
// the server the first time it's opened for a given niche, then caches it
// client-side (a fresh /api/parser-niches poll never touches this cache, so
// a newly-archived version won't show until the section is re-opened or the
// page reloads - acceptable for a history list nobody needs live-updating).
async function toggleParserNicheVersions(id) {
    parserNicheVersionsOpen[id] = !parserNicheVersionsOpen[id];
    if (parserNicheVersionsOpen[id] && !parserNicheVersions[id]) {
        drawParserNiches(); // show "Загрузка…" immediately
        try {
            parserNicheVersions[id] = await api(`/api/parser-niches/${id}/versions`);
        } catch (e) {
            parserNicheVersionsOpen[id] = false;
            showToast('Не удалось загрузить историю версий: ' + e.message);
        }
    }
    drawParserNiches();
}

function downloadParserNicheVersion(id, versionId) {
    window.open(`/api/parser-niches/${id}/versions/${versionId}/download`, '_blank');
}

// "Загрузить Excel" - alternative to running the live 2GIS scraper: upload an
// already-prepared .xlsx of leads straight into this niche's raw_file slot.
async function uploadParserNicheFile(id, inputEl) {
    const file = inputEl.files && inputEl.files[0];
    if (!file) return;
    const label = inputEl.closest('.parser-upload-btn');
    if (label) label.style.pointerEvents = 'none';
    try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(`/api/parser-niches/${id}/upload`, { method: 'POST', body: formData });
        if (!res.ok) {
            let message = res.statusText;
            try { message = (await res.json()).error || message; } catch (_) {}
            throw new Error(message);
        }
        const updated = await res.json();
        const idx = parserNiches.findIndex(n => n.id === id);
        if (idx !== -1) parserNiches[idx] = updated;
        drawParserNiches();
        showToast('Файл загружен');
    } catch (e) {
        showToast('Не удалось загрузить файл: ' + e.message);
    } finally {
        inputEl.value = '';
        if (label) label.style.pointerEvents = '';
    }
}

async function removeParserNiche(id) {
    if (!confirm('Удалить эту нишу вместе со всеми файлами?')) return;
    if (parserPollTimers[id]) { clearInterval(parserPollTimers[id]); delete parserPollTimers[id]; }
    try {
        await api(`/api/parser-niches/${id}`, { method: 'DELETE' });
        parserNiches = parserNiches.filter(n => n.id !== id);
        drawParserNiches();
    } catch (e) {
        showToast('Не удалось удалить: ' + e.message);
    }
}

// МЕДИАТЕКА (каталог по URL уже размещённых картинок/видео - без загрузки файлов)
let mediaAssets = [];
let mediaAssetFilterType = '';
let mediaAssetFilterProduct = '';

function mediaAssetProductLabel(productId) {
    const p = productsData.find(p => p.id === productId);
    return p ? p.title : productId;
}

async function renderMediaAssets() {
    const grid = document.getElementById('media-assets-grid');
    if (!grid) return;

    // Product selects in the add/generate/voiceover forms only need populating once per session.
    [
        document.getElementById('ma-product-input'),
        document.getElementById('ma-gen-product-input'),
        document.getElementById('vo-product-input'),
    ].forEach(productSelect => {
        if (productSelect && productSelect.options.length <= 1) {
            productsData.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.title;
                productSelect.appendChild(opt);
            });
        }
    });

    // Idea selects (cover-gen / voiceover-gen forms only - the plain
    // "add media by URL" form has no text field to prefill from an idea).
    // Rebuilt on every render, unlike the product selects above, since
    // ideasBank can grow while this tab is open and a stale list would just
    // be missing recently-added ideas.
    [
        document.getElementById('ma-gen-idea-input'),
        document.getElementById('vo-idea-input'),
    ].forEach(ideaSelect => {
        if (!ideaSelect) return;
        const currentValue = ideaSelect.value;
        ideaSelect.innerHTML = '<option value="">— без привязки —</option>' + ideasBank.map(idea => {
            const label = idea.title.length > 60 ? idea.title.slice(0, 60) + '…' : idea.title;
            return `<option value="${escapeHtml(idea.id)}">${escapeHtml(label)}</option>`;
        }).join('');
        if (ideasBank.some(i => i.id === currentValue)) ideaSelect.value = currentValue;
    });

    try {
        const params = new URLSearchParams();
        if (mediaAssetFilterType) params.set('type', mediaAssetFilterType);
        if (mediaAssetFilterProduct) params.set('product_id', mediaAssetFilterProduct);
        const qs = params.toString();
        mediaAssets = await api(`/api/media-assets${qs ? '?' + qs : ''}`);
    } catch (e) {
        grid.innerHTML = `<div class="info-box" style="text-align:center; color:var(--accent-red);">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
        return;
    }
    drawMediaAssetFilters();
    drawMediaAssetsGrid();
}

function drawMediaAssetFilters() {
    const container = document.getElementById('media-asset-filters');
    if (!container) return;

    const typeChips = [
        { value: '', label: 'Все типы' },
        { value: 'image', label: 'Изображения' },
        { value: 'video', label: 'Видео' },
        { value: 'gif', label: 'GIF' },
        { value: 'audio', label: 'Аудио' },
    ];
    const productOptions = [`<option value="">Все продукты</option>`]
        .concat(productsData.map(p => `<option value="${escapeHtml(p.id)}" ${mediaAssetFilterProduct === p.id ? 'selected' : ''}>${escapeHtml(p.title)}</option>`));

    container.innerHTML = `
        <div style="display:flex; flex-wrap:wrap; gap:4px;">
            ${typeChips.map(c => `<span class="group-chip ${mediaAssetFilterType === c.value ? 'active' : ''}" onclick="setMediaAssetTypeFilter('${c.value}')">${c.label}</span>`).join('')}
        </div>
        <select class="form-select" style="width:auto; margin:0;" onchange="setMediaAssetProductFilter(this.value)">
            ${productOptions.join('')}
        </select>
    `;
}

function setMediaAssetTypeFilter(type) {
    mediaAssetFilterType = type;
    renderMediaAssets();
}

function setMediaAssetProductFilter(productId) {
    mediaAssetFilterProduct = productId;
    renderMediaAssets();
}

// Voiceovers with no configured object storage store their audio as a
// data:audio/...;base64,... URL directly in `url` (see generate-voiceover in
// server/routes/mediaAssets.js) - that string can be megabytes long and is
// meaningless to read, so it must never be dumped as visible text. Show the
// actual voiceover script (`transcript`, clamped to 4 lines with a toggle)
// when there is one; otherwise fall back to the URL, except when the URL
// itself is a data: URI, which gets a short placeholder instead.
function mediaAssetSubtextHtml(asset) {
    if (asset.type === 'audio' && asset.transcript) {
        const id = `mt-${asset.id}`;
        return `
            <div class="media-asset-transcript clamped" id="${id}">${escapeHtml(asset.transcript)}</div>
            <button type="button" class="media-asset-transcript-toggle" onclick="event.stopPropagation(); toggleMediaTranscript('${id}', this)">Показать больше</button>`;
    }
    if (asset.url.startsWith('data:')) {
        return `<div class="media-asset-url">аудио (данные встроены, ссылки нет)</div>`;
    }
    return `<div class="media-asset-url" title="${escapeHtml(asset.url)}">${escapeHtml(asset.url)}</div>`;
}

function toggleMediaTranscript(id, btn) {
    const el = document.getElementById(id);
    if (!el) return;
    const expanded = el.classList.toggle('clamped') === false;
    if (btn) btn.textContent = expanded ? 'Свернуть' : 'Показать больше';
}

function mediaAssetPreviewHtml(asset) {
    // Built with single-quoted HTML attrs and HTML-entity-escaped single quotes so it can be
    // safely embedded inside the (double-quoted) onerror="..." attribute below without the
    // placeholder's own quotes prematurely closing that attribute.
    const placeholder = `<div class='media-asset-placeholder'>&#9888;&#65039; Не удалось загрузить превью</div>`;
    if (asset.type === 'video') {
        return `<video class="media-asset-preview" src="${escapeHtml(asset.url)}" muted preload="metadata"
                    onerror="this.outerHTML='${placeholder}'"></video>`;
    }
    if (asset.type === 'audio') {
        return `<div class="media-asset-preview" style="display:flex; align-items:center; justify-content:center; background:var(--bg-grouped);">
                    <audio controls preload="metadata" style="width:calc(100% - 24px);" src="${escapeHtml(asset.url)}"
                        onerror="this.parentElement.outerHTML='${placeholder}'"></audio>
                </div>`;
    }
    return `<img class="media-asset-preview" src="${escapeHtml(asset.url)}" loading="lazy" alt=""
                onerror="this.outerHTML='${placeholder}'">`;
}

function drawMediaAssetsGrid() {
    const grid = document.getElementById('media-assets-grid');
    if (!grid) return;

    if (mediaAssets.length === 0) {
        grid.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Медиа пока нет — добавьте первую ссылку кнопкой выше.</div>`;
        return;
    }

    grid.innerHTML = mediaAssets.map(asset => `
        <div class="media-asset-card">
            ${mediaAssetPreviewHtml(asset)}
            <div class="media-asset-body">
                <div class="media-asset-meta-row">
                    <span class="format-tag">${escapeHtml(asset.type)}</span>
                    ${asset.productId ? `<span class="format-tag" style="color:var(--accent-blue);">${escapeHtml(mediaAssetProductLabel(asset.productId))}</span>` : ''}
                    <span style="font-size:11px; color:var(--text-secondary); margin-left:auto;">исп.: ${asset.usedCount}</span>
                </div>
                ${asset.tags.length ? `<div class="media-asset-tags">${asset.tags.map(t => `<span class="group-chip" style="cursor:default;">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                ${mediaAssetSubtextHtml(asset)}
                <div class="parser-niche-actions">
                    <button class="edit-btn" onclick="openMediaLightbox('${asset.id}')">Открыть</button>
                    <button class="delete-btn" onclick="deleteMediaAsset('${asset.id}')">Удалить</button>
                </div>
            </div>
        </div>
    `).join('');
}

function openMediaLightbox(assetId) {
    const asset = mediaAssets.find(a => a.id === assetId);
    if (!asset) return;
    const body = document.getElementById('media-lightbox-body');
    body.innerHTML = mediaAssetPreviewHtml(asset).replace('media-asset-preview', 'media-asset-preview media-lightbox-preview');
    openOverlay('media-lightbox-overlay');
}

function openAddMediaAssetForm() {
    document.getElementById('media-asset-generate-form').style.display = 'none';
    document.getElementById('media-asset-form').style.display = 'block';
    document.getElementById('ma-url-input').value = '';
    document.getElementById('ma-file-input').value = '';
    document.getElementById('ma-tags-input').value = '';
    document.getElementById('ma-type-input').value = 'image';
    document.getElementById('ma-product-input').value = '';
}

function closeAddMediaAssetForm() {
    document.getElementById('media-asset-form').style.display = 'none';
}

// URL и файл — взаимоисключающие способы задать медиа: заполнение одного
// поля сбрасывает другое, чтобы не было неоднозначности при сабмите.
function onMediaAssetUrlInput() {
    if (document.getElementById('ma-url-input').value.trim()) {
        document.getElementById('ma-file-input').value = '';
    }
}

function onMediaAssetFileInput() {
    const fileInput = document.getElementById('ma-file-input');
    if (fileInput.files && fileInput.files.length) {
        document.getElementById('ma-url-input').value = '';
    }
}

// Прямая загрузка файла идёт через POST /api/media-assets/upload
// (multipart/form-data) — доступность определяется сервером (S3_* env vars,
// см. server/lib/objectStorage.js): если хранилище не настроено, сервер
// вернёт понятную ошибку 503, которая просто всплывает тостом, как и для
// остальных опциональных интеграций (kie.ai, ElevenLabs, Piper).
async function submitNewMediaAsset() {
    const url = document.getElementById('ma-url-input').value.trim();
    const fileInput = document.getElementById('ma-file-input');
    const file = fileInput.files && fileInput.files[0];
    const type = document.getElementById('ma-type-input').value;
    const productId = document.getElementById('ma-product-input').value;
    const tags = document.getElementById('ma-tags-input').value.split(',').map(t => t.trim()).filter(Boolean);

    if (!url && !file) return alert('Укажите URL медиа или выберите файл для загрузки');

    try {
        let created;
        if (file) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('type', type);
            if (productId) formData.append('productId', productId);
            formData.append('tags', JSON.stringify(tags));
            const res = await fetch('/api/media-assets/upload', { method: 'POST', body: formData });
            if (!res.ok) {
                let message = res.statusText;
                try { message = (await res.json()).error || message; } catch (_) {}
                throw new Error(message);
            }
            created = await res.json();
        } else {
            created = await api('/api/media-assets', {
                method: 'POST',
                body: JSON.stringify({ url, type, productId: productId || null, tags }),
            });
        }
        mediaAssets.unshift(created);
        drawMediaAssetsGrid();
        closeAddMediaAssetForm();
        showToast('Медиа добавлено!');
    } catch (e) {
        showToast('Не удалось добавить: ' + e.message);
    }
}

function openVoiceoverForm() {
    document.getElementById('voiceover-form').style.display = 'block';
    document.getElementById('vo-text-input').value = '';
    document.getElementById('vo-provider-input').value = 'elevenlabs';
    document.getElementById('vo-voiceid-input').value = '';
    document.getElementById('vo-product-input').value = '';
    const ideaSelect = document.getElementById('vo-idea-input');
    if (ideaSelect) ideaSelect.value = '';
}

// Picking an idea prefills the voiceover text with its post text (idea.desc -
// the same field rendered on the idea card in Банк идей) rather than
// clearing whatever the user may have already typed by hand. "— без
// привязки —" (empty value) never triggers a prefill/overwrite.
function onVoiceoverIdeaSelectChange() {
    const ideaId = document.getElementById('vo-idea-input').value;
    if (!ideaId) return;
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    const textField = document.getElementById('vo-text-input');
    if (textField.value.trim() && !confirm('В поле уже есть текст — заменить его текстом идеи?')) return;
    textField.value = idea.desc || idea.title || '';
}

function closeVoiceoverForm() {
    document.getElementById('voiceover-form').style.display = 'none';
}

// Calls POST /api/media-assets/generate-voiceover, choosing between
// ElevenLabs (server/lib/elevenLabsClient.js) and Piper
// (server/lib/piperTtsClient.js) via the provider dropdown. If the chosen
// provider isn't configured on the server, the endpoint responds with a
// normal error JSON ({ error }) which the shared api() helper turns into a
// thrown Error - handled here the same way every other optional integration
// in this app surfaces a "not configured" failure: an error toast, no
// hardcoded assumption about why it failed.
async function submitVoiceoverGeneration() {
    const text = document.getElementById('vo-text-input').value.trim();
    const provider = document.getElementById('vo-provider-input').value;
    const voiceId = document.getElementById('vo-voiceid-input').value.trim();
    const productId = document.getElementById('vo-product-input').value;

    if (!text) return alert('Введите текст для озвучки');

    const btn = document.getElementById('vo-generate-btn');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Генерируем…';
    const finishTicker = startGenerationTicker('vo-gen-status', [
        { afterSeconds: 0, text: 'Отправляем текст провайдеру озвучки…' },
        { afterSeconds: 4, text: 'Синтезируем голос…' },
        { afterSeconds: 20, text: 'Дольше обычного, но ещё может сработать…' },
    ]);

    try {
        const created = await api('/api/media-assets/generate-voiceover', {
            method: 'POST',
            body: JSON.stringify({ text, provider, voiceId: voiceId || undefined, productId: productId || null }),
        });
        mediaAssets.unshift(created);
        drawMediaAssetsGrid();
        finishTicker(true, 'Готово');
        closeVoiceoverForm();
        showToast('Озвучка сгенерирована!');
    } catch (e) {
        finishTicker(false, 'Ошибка: ' + e.message);
        showToast('Не удалось сгенерировать озвучку: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

async function deleteMediaAsset(id) {
    if (!confirm('Удалить это медиа из библиотеки?')) return;
    try {
        await api(`/api/media-assets/${id}`, { method: 'DELETE' });
        mediaAssets = mediaAssets.filter(a => a.id !== id);
        drawMediaAssetsGrid();
    } catch (e) {
        showToast('Не удалось удалить: ' + e.message);
    }
}

// AI-ГЕНЕРАЦИЯ ОБЛОЖЕК ЧЕРЕЗ kie.ai (Flux/Kling) - см. server/routes/mediaAssets.js.
// Кнопка всегда видна: доступность kie.ai определяется сервером (KIE_API_KEY),
// а не каким-то заранее известным фронтенду флагом - если ключ не настроен,
// сервер вернёт 503 с понятным текстом, который просто показывается в тосте.
function openGenerateMediaAssetForm() {
    document.getElementById('media-asset-form').style.display = 'none';
    document.getElementById('media-asset-generate-form').style.display = 'block';
    document.getElementById('ma-gen-prompt-input').value = '';
    document.getElementById('ma-gen-type-input').value = 'image';
    document.getElementById('ma-gen-product-input').value = '';
    const ideaSelect = document.getElementById('ma-gen-idea-input');
    if (ideaSelect) ideaSelect.value = '';
}

// Builds a reasonable *image* prompt from an idea's title/desc rather than
// dumping the raw post text into kie.ai - mirrors
// buildImagePromptFromIdea() in server/routes/ideas.js's auto-generate
// endpoint, just phrased for a human to still edit before submitting.
function buildImagePromptFromIdea(idea) {
    const context = (idea.desc || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return `Обложка для поста на тему: «${idea.title}».${context ? ` Контекст: ${context}.` : ''} Стиль: минималистичный, современный, привлекающий внимание.`;
}

// Same "don't clobber manually-typed text" rule as the voiceover form's
// idea select: only prefills when the field is empty or the user confirms.
function onGenIdeaSelectChange() {
    const ideaId = document.getElementById('ma-gen-idea-input').value;
    if (!ideaId) return;
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    const promptField = document.getElementById('ma-gen-prompt-input');
    if (promptField.value.trim() && !confirm('В поле уже есть текст — заменить его промптом из идеи?')) return;
    promptField.value = buildImagePromptFromIdea(idea);
}

function closeGenerateMediaAssetForm() {
    document.getElementById('media-asset-generate-form').style.display = 'none';
}

async function submitGenerateMediaAsset() {
    const prompt = document.getElementById('ma-gen-prompt-input').value.trim();
    const type = document.getElementById('ma-gen-type-input').value;
    const productId = document.getElementById('ma-gen-product-input').value;

    if (!prompt) return alert('Опишите, что должно быть на обложке');

    const btn = document.getElementById('ma-gen-submit-btn');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Генерируем...';

    const endpoint = type === 'video' ? '/api/media-assets/generate-video' : '/api/media-assets/generate-cover';
    // kie.ai generation is job-based and genuinely slow (Flux images up to
    // ~3 min, Kling video up to ~7 min - see server/lib/kieClient.js's poll
    // timeouts), so the stage thresholds here are much longer than the
    // voiceover ticker's.
    const stages = type === 'video' ? [
        { afterSeconds: 0, text: 'Отправляем запрос в kie.ai (Kling)…' },
        { afterSeconds: 10, text: 'Видео генерируется, обычно 1-7 минут…' },
        { afterSeconds: 120, text: 'Всё ещё генерируется — это нормально для видео…' },
        { afterSeconds: 300, text: 'Уже дольше обычного, ждём ответ до 7 минут…' },
    ] : [
        { afterSeconds: 0, text: 'Отправляем запрос в kie.ai (Flux)…' },
        { afterSeconds: 5, text: 'Изображение генерируется, обычно до 3 минут…' },
        { afterSeconds: 60, text: 'Всё ещё генерируется — Flux иногда медленнее обычного…' },
    ];
    const finishTicker = startGenerationTicker('ma-gen-status', stages);

    try {
        const created = await api(endpoint, {
            method: 'POST',
            body: JSON.stringify({ prompt, productId: productId || null }),
        });
        mediaAssets.unshift(created);
        drawMediaAssetsGrid();
        finishTicker(true, 'Готово');
        closeGenerateMediaAssetForm();
        showToast('Обложка сгенерирована!');
    } catch (e) {
        finishTicker(false, 'Ошибка: ' + e.message);
        showToast(e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

// НАСТРОЙКИ АГЕНТОВ (источники, тон голоса, промпты Researcher/Generator)
async function renderAgentSettingsForm() {
    document.getElementById('as-sources-input').value = (agentSettings.sources || []).join('\n');
    document.getElementById('as-keywords-input').value = (agentSettings.keywords || []).join(', ');
    document.getElementById('as-tone-input').value = agentSettings.toneOfVoice || '';
    document.getElementById('as-formula-input').value = agentSettings.postFormula || '';
    document.getElementById('as-generator-prompt-input').value = agentSettings.generatorPrompt || '';
    updateAgentSettingsCounts();
    await loadContentRubrics();
}

// Live counters next to the RSS-sources/keywords section titles - just
// counts non-empty lines/comma-items in whatever's currently in the fields
// (including unsaved edits), not a server round-trip.
function updateAgentSettingsCounts() {
    const sourcesCount = document.getElementById('as-sources-input').value.split('\n').map(s => s.trim()).filter(Boolean).length;
    const keywordsCount = document.getElementById('as-keywords-input').value.split(',').map(s => s.trim()).filter(Boolean).length;
    document.getElementById('as-sources-count').innerText = sourcesCount || 'пока нет';
    document.getElementById('as-keywords-count').innerText = keywordsCount || 'пока нет';
}

// Preview state for the "✨ Предложить новые" checklists below - which
// candidates are currently checked, keyed by url/keyword. Rebuilt fresh
// every time a discover call returns.
let sourcesPreviewChecked = new Set();
let keywordsPreviewChecked = new Set();

function renderSourcesPreview(candidates) {
    const box = document.getElementById('as-sources-preview');
    if (!candidates.length) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }
    sourcesPreviewChecked = new Set(candidates.filter(c => c.valid).map(c => c.url));
    box.style.display = 'block';
    box.innerHTML = `
        <div class="parser-niche-console" style="max-height:none; color:var(--text-primary);">
            ${candidates.map(c => `
                <label style="display:flex; align-items:flex-start; gap:8px; padding:4px 0; ${c.valid ? '' : 'opacity:.5;'}">
                    <input type="checkbox" style="margin-top:3px;" ${c.valid ? 'checked' : 'disabled'}
                        onchange="togglePreviewChecked(sourcesPreviewChecked, '${escapeHtml(c.url).replace(/'/g, "\\'")}', this.checked)">
                    <span>
                        <div>${escapeHtml(c.url)}${c.valid ? '' : ' — не похоже на рабочий RSS/Atom'}</div>
                        ${c.reason ? `<div style="color:var(--text-secondary); font-size:11px;">${escapeHtml(c.reason)}</div>` : ''}
                    </span>
                </label>`).join('')}
        </div>
        <div style="margin-top:8px;">
            <button class="schedule-btn" onclick="confirmSourcesPreview()">Добавить выбранные</button>
            <button class="edit-btn" onclick="document.getElementById('as-sources-preview').style.display='none';">Отмена</button>
        </div>`;
}

function renderKeywordsPreview(candidates) {
    const box = document.getElementById('as-keywords-preview');
    if (!candidates.length) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }
    keywordsPreviewChecked = new Set(candidates.map(c => c.keyword));
    box.style.display = 'block';
    box.innerHTML = `
        <div class="parser-niche-console" style="max-height:none; color:var(--text-primary);">
            ${candidates.map(c => `
                <label style="display:flex; align-items:flex-start; gap:8px; padding:4px 0;">
                    <input type="checkbox" style="margin-top:3px;" checked
                        onchange="togglePreviewChecked(keywordsPreviewChecked, '${escapeHtml(c.keyword).replace(/'/g, "\\'")}', this.checked)">
                    <span>
                        <div>${escapeHtml(c.keyword)}</div>
                        ${c.reason ? `<div style="color:var(--text-secondary); font-size:11px;">${escapeHtml(c.reason)}</div>` : ''}
                    </span>
                </label>`).join('')}
        </div>
        <div style="margin-top:8px;">
            <button class="schedule-btn" onclick="confirmKeywordsPreview()">Добавить выбранные</button>
            <button class="edit-btn" onclick="document.getElementById('as-keywords-preview').style.display='none';">Отмена</button>
        </div>`;
}

function togglePreviewChecked(set, value, checked) {
    if (checked) set.add(value); else set.delete(value);
}

async function confirmSourcesPreview() {
    const urls = [...sourcesPreviewChecked];
    if (!urls.length) return showToast('Ничего не выбрано');
    let added = 0;
    for (const url of urls) {
        try {
            const result = await api('/api/agent-settings/sources', { method: 'POST', body: JSON.stringify({ url }) });
            agentSettings.sources = result.sources;
            added++;
        } catch (e) {
            // 409 (already exists) is expected/harmless if the list changed
            // underneath this preview; anything else is worth a toast.
            if (!/уже есть/i.test(e.message)) showToast(`${url}: ${e.message}`);
        }
    }
    document.getElementById('as-sources-input').value = (agentSettings.sources || []).join('\n');
    document.getElementById('as-sources-preview').style.display = 'none';
    updateAgentSettingsCounts();
    if (added) showToast(`Добавлено источников: ${added}`);
}

async function confirmKeywordsPreview() {
    const keywords = [...keywordsPreviewChecked];
    if (!keywords.length) return showToast('Ничего не выбрано');
    let added = 0;
    for (const keyword of keywords) {
        try {
            const result = await api('/api/agent-settings/keywords', { method: 'POST', body: JSON.stringify({ keyword }) });
            agentSettings.keywords = result.keywords;
            added++;
        } catch (e) {
            if (!/уже есть/i.test(e.message)) showToast(`${keyword}: ${e.message}`);
        }
    }
    document.getElementById('as-keywords-input').value = (agentSettings.keywords || []).join(', ');
    document.getElementById('as-keywords-preview').style.display = 'none';
    updateAgentSettingsCounts();
    if (added) showToast(`Добавлено ключевых слов: ${added}`);
}

// РУБРИКИ КОНТЕНТА (реиспользуемые структуры постов, живут в этой же вкладке -
// это конфигурация контент-производства, как тон голоса и промпты выше)
async function loadContentRubrics() {
    const grid = document.getElementById('rubrics-grid');
    if (grid) grid.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Загрузка...</div>`;
    try {
        contentRubrics = await api('/api/content-rubrics?all=1');
    } catch (e) {
        if (grid) grid.innerHTML = `<div class="info-box" style="text-align:center; color:var(--accent-red);">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
        return;
    }
    drawRubricsGrid();
    populateRubricPickerSelect();
}

function drawRubricsGrid() {
    const grid = document.getElementById('rubrics-grid');
    if (!grid) return;

    if (contentRubrics.length === 0) {
        grid.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Рубрик пока нет — добавьте первую кнопкой выше.</div>`;
        return;
    }

    grid.innerHTML = contentRubrics.map(r => `
        <div class="parser-niche-card">
            <div class="parser-niche-head">
                <b>${escapeHtml(r.name)}</b>
                <span class="parser-niche-status ${r.isActive ? 'done' : 'idle'}">${r.isActive ? 'Активна' : 'Отключена'}</span>
            </div>
            ${r.description ? `<p class="idea-desc-text" style="margin:0;">${escapeHtml(r.description)}</p>` : ''}
            <div class="media-asset-meta-row"><span class="format-tag">${escapeHtml(r.targetFunnel)}</span></div>
            ${r.structureTemplate.length ? `<div class="media-asset-tags">${r.structureTemplate.map(s => `<span class="group-chip" style="cursor:default;">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
            <div class="parser-niche-actions">
                <button class="edit-btn" onclick="editRubric('${r.id}')">✏️ Изменить</button>
                <button class="edit-btn" onclick="toggleRubricActive('${r.id}')">${r.isActive ? '🚫 Отключить' : '✅ Включить'}</button>
                <button class="delete-btn" onclick="deleteRubric('${r.id}')">Удалить</button>
            </div>
        </div>
    `).join('');
}

function openAddRubricForm() {
    document.getElementById('rubric-form').style.display = 'block';
    document.getElementById('rb-id-input').value = '';
    document.getElementById('rb-name-input').value = '';
    document.getElementById('rb-description-input').value = '';
    document.getElementById('rb-structure-input').value = '';
    document.getElementById('rb-funnel-input').value = 'TOFU';
    document.getElementById('rb-active-input').checked = true;
}

function closeRubricForm() {
    document.getElementById('rubric-form').style.display = 'none';
}

function editRubric(id) {
    const r = contentRubrics.find(x => x.id === id);
    if (!r) return;
    document.getElementById('rubric-form').style.display = 'block';
    document.getElementById('rb-id-input').value = r.id;
    document.getElementById('rb-name-input').value = r.name;
    document.getElementById('rb-description-input').value = r.description || '';
    document.getElementById('rb-structure-input').value = (r.structureTemplate || []).join('\n');
    document.getElementById('rb-funnel-input').value = r.targetFunnel || 'TOFU';
    document.getElementById('rb-active-input').checked = !!r.isActive;
}

async function submitRubric() {
    const id = document.getElementById('rb-id-input').value;
    const name = document.getElementById('rb-name-input').value.trim();
    const description = document.getElementById('rb-description-input').value.trim();
    const structureTemplate = document.getElementById('rb-structure-input').value
        .split('\n').map(s => s.trim()).filter(Boolean);
    const targetFunnel = document.getElementById('rb-funnel-input').value;
    const isActive = document.getElementById('rb-active-input').checked;

    if (!name) return alert('Укажите название рубрики');

    try {
        if (id) {
            const updated = await api(`/api/content-rubrics/${id}`, {
                method: 'PUT',
                body: JSON.stringify({ name, description, structureTemplate, targetFunnel, isActive }),
            });
            contentRubrics = contentRubrics.map(r => r.id === id ? updated : r);
            showToast('Рубрика обновлена!');
        } else {
            const created = await api('/api/content-rubrics', {
                method: 'POST',
                body: JSON.stringify({ name, description, structureTemplate, targetFunnel, isActive }),
            });
            contentRubrics.unshift(created);
            showToast('Рубрика добавлена!');
        }
        drawRubricsGrid();
        populateRubricPickerSelect();
        closeRubricForm();
    } catch (e) {
        showToast('Не удалось сохранить рубрику: ' + e.message);
    }
}

async function toggleRubricActive(id) {
    const r = contentRubrics.find(x => x.id === id);
    if (!r) return;
    try {
        const updated = await api(`/api/content-rubrics/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ isActive: !r.isActive }),
        });
        contentRubrics = contentRubrics.map(x => x.id === id ? updated : x);
        drawRubricsGrid();
        populateRubricPickerSelect();
    } catch (e) {
        showToast('Не удалось обновить рубрику: ' + e.message);
    }
}

async function deleteRubric(id) {
    if (!confirm('Удалить эту рубрику? Идеи, уже привязанные к ней, сохранят ссылку, но рубрика перестанет быть выбираемой.')) return;
    try {
        await api(`/api/content-rubrics/${id}`, { method: 'DELETE' });
        contentRubrics = contentRubrics.filter(r => r.id !== id);
        drawRubricsGrid();
        populateRubricPickerSelect();
    } catch (e) {
        showToast('Не удалось удалить: ' + e.message);
    }
}

// Rubric picker in the idea edit modal - only active rubrics are offered as
// choices, but if the idea already carries a now-inactive/deleted rubric id
// it's still shown (labelled accordingly) so the selection isn't silently
// dropped out from under the user.
function populateRubricPickerSelect(selectedId) {
    const select = document.getElementById('edit-idea-rubric-input');
    if (!select) return;
    const value = selectedId !== undefined ? selectedId : select.value;
    const active = contentRubrics.filter(r => r.isActive);
    let options = `<option value="">— без рубрики —</option>` +
        active.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
    if (value && !active.some(r => r.id === value)) {
        const inactive = contentRubrics.find(r => r.id === value);
        options += `<option value="${escapeHtml(value)}">${inactive ? escapeHtml(inactive.name) + ' (неактивна)' : 'рубрика удалена'}</option>`;
    }
    select.innerHTML = options;
    select.value = value || '';
}

async function saveAgentSettingsForm() {
    const sources = document.getElementById('as-sources-input').value
        .split('\n').map(s => s.trim()).filter(Boolean);
    const keywords = document.getElementById('as-keywords-input').value
        .split(',').map(s => s.trim()).filter(Boolean);
    const toneOfVoice = document.getElementById('as-tone-input').value;
    const postFormula = document.getElementById('as-formula-input').value;
    const generatorPrompt = document.getElementById('as-generator-prompt-input').value;

    try {
        agentSettings = await api('/api/agent-settings', {
            method: 'PUT',
            body: JSON.stringify({ sources, keywords, toneOfVoice, postFormula, generatorPrompt }),
        });
        showToast('Настройки агентов сохранены!');
    } catch (e) {
        showToast('Не удалось сохранить: ' + e.message);
    }
}

// "✨ Предложить новые" рядом с RSS-источниками - просит local-claude-agent
// (на ПК пользователя, см. local-claude-agent/README.md) найти новые фиды
// под текущие продукты, сервер сам проверяет каждый кандидат живым запросом,
// а добавление происходит только после подтверждения пользователем в
// чек-листе (renderSourcesPreview/confirmSourcesPreview выше) - ничего не
// сохраняется автоматически.
async function discoverRssSources() {
    const btn = document.getElementById('as-discover-btn');
    const statusEl = document.getElementById('as-discover-status');
    btn.disabled = true;
    btn.textContent = '⏳ Ищу...';
    statusEl.style.display = 'block';
    statusEl.textContent = 'Обращаюсь к local-claude-agent на вашем ПК — это может занять пару минут...';
    document.getElementById('as-sources-preview').style.display = 'none';

    try {
        const result = await api('/api/agent-settings/discover-sources', { method: 'POST' });
        const candidates = result.candidates || [];
        if (candidates.length > 0) {
            renderSourcesPreview(candidates);
            statusEl.textContent = `Найдено кандидатов: ${candidates.length}. Проверьте список ниже и подтвердите.`;
        } else {
            statusEl.textContent = 'Новых подходящих источников не нашлось в этот раз.';
        }
    } catch (e) {
        statusEl.textContent = 'Ошибка: ' + e.message;
        showToast('Не удалось найти источники: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '✨ Предложить новые';
    }
}

// Тот же принцип для ключевых слов - без живой проверки (ключевое слово
// нельзя "провалидировать" как URL), поэтому все кандидаты приходят
// отмеченными по умолчанию.
async function discoverKeywords() {
    const btn = document.getElementById('as-keywords-discover-btn');
    const statusEl = document.getElementById('as-keywords-discover-status');
    btn.disabled = true;
    btn.textContent = '⏳ Ищу...';
    statusEl.style.display = 'block';
    statusEl.textContent = 'Обращаюсь к local-claude-agent на вашем ПК — это может занять пару минут...';
    document.getElementById('as-keywords-preview').style.display = 'none';

    try {
        const result = await api('/api/agent-settings/discover-keywords', { method: 'POST' });
        const candidates = result.candidates || [];
        if (candidates.length > 0) {
            renderKeywordsPreview(candidates);
            statusEl.textContent = `Найдено кандидатов: ${candidates.length}. Проверьте список ниже и подтвердите.`;
        } else {
            statusEl.textContent = 'Новых подходящих ключевых слов не нашлось в этот раз.';
        }
    } catch (e) {
        statusEl.textContent = 'Ошибка: ' + e.message;
        showToast('Не удалось предложить ключевые слова: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '✨ Предложить новые';
    }
}

// ЦЕНТР АГЕНТОВ (наблюдаемость: agent_runs / agent_expenses, только чтение)
async function renderAgentCenter() {
    const todayEl = document.getElementById('ac-stat-today');
    const monthEl = document.getElementById('ac-stat-month');
    const runsEl = document.getElementById('ac-runs-list');
    const expensesEl = document.getElementById('ac-expenses-tbody');
    if (!runsEl || !expensesEl) return;

    try {
        const summary = await api('/api/agent-expenses/summary');
        if (todayEl) todayEl.innerText = `$${(summary.todayUsd || 0).toFixed(2)}`;
        if (monthEl) monthEl.innerText = `$${(summary.monthUsd || 0).toFixed(2)}`;
    } catch (e) {
        if (todayEl) todayEl.innerText = '—';
        if (monthEl) monthEl.innerText = '—';
    }

    try {
        const runs = await api('/api/agent-runs');
        drawAgentRuns(runs);
    } catch (e) {
        runsEl.innerHTML = `<div class="info-box" style="text-align:center; color:var(--accent-red);">Не удалось загрузить историю запусков: ${escapeHtml(e.message)}</div>`;
    }

    try {
        const expenses = await api('/api/agent-expenses');
        drawAgentExpenses(expenses);
    } catch (e) {
        expensesEl.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--accent-red); padding:16px;">Не удалось загрузить расходы: ${escapeHtml(e.message)}</td></tr>`;
    }
}

function formatAcTimestamp(value) {
    if (!value) return '—';
    // Accepts an epoch-seconds number/numeric-string or an ISO/date string.
    const ms = /^\d+$/.test(String(value)) ? Number(value) * 1000 : Date.parse(value);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return escapeHtml(String(value));
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function drawAgentRuns(runs) {
    const container = document.getElementById('ac-runs-list');
    if (!container) return;

    if (!runs || runs.length === 0) {
        container.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Запусков агентов пока нет.</div>`;
        return;
    }

    const statusLabels = { success: 'Успех', skipped: 'Пропущен', failed: 'Ошибка' };

    container.innerHTML = `<div class="parser-niches-grid">${runs.map(r => {
        const logFull = r.log || '';
        const logShort = logFull.length > 160 ? logFull.slice(0, 160) + '…' : logFull;
        return `
        <div class="parser-niche-card">
            <div class="parser-niche-head">
                <b>${escapeHtml(r.agentName)}</b>
                <span class="ac-run-status ${escapeHtml(r.status)}">${statusLabels[r.status] || escapeHtml(r.status)}</span>
            </div>
            <div class="meta-stats">
                <span>${formatAcTimestamp(r.runDate)}</span>
                <span>Трендов найдено: ${r.trendsFound ?? 0}</span>
                <span>Стоимость: $${(r.costUsd || 0).toFixed(2)}</span>
            </div>
            ${logFull ? `<div class="parser-niche-console" title="${escapeHtml(logFull)}">${escapeHtml(logShort)}</div>` : ''}
        </div>`;
    }).join('')}</div>`;
}

function drawAgentExpenses(expenses) {
    const tbody = document.getElementById('ac-expenses-tbody');
    if (!tbody) return;

    if (!expenses || expenses.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-secondary); padding:16px;">Расходов пока нет.</td></tr>`;
        return;
    }

    tbody.innerHTML = expenses.map(e => `
        <tr>
            <td>${formatAcTimestamp(e.timestamp)}</td>
            <td>${escapeHtml(e.agentName)}</td>
            <td>${escapeHtml(e.modelUsed || '—')}</td>
            <td>${e.inputTokens ?? 0}</td>
            <td>${e.outputTokens ?? 0}</td>
            <td>${e.cachedTokens ?? 0}</td>
            <td>${e.kieCreditsSpent ?? 0}</td>
            <td>$${(e.totalUsd || 0).toFixed(2)}</td>
        </tr>
    `).join('');
}
