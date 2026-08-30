// --- ВСТРОЕННЫЕ ДАННЫЕ ПРОДУКТОВ (статическая конфигурация студии, не хранится в БД) ---
const productsData = [
    { id: 'insights', title: 'InSights', badge: 'Аналитика', badgeBg: 'rgba(10,132,255,0.15)', badgeColor: '#0a84ff', target: 'B2B, Маркетологи', value: 'Поиск блогеров и AI-скоринг', desc: 'SaaS платформа для анализа соцсетей с ИИ', roadmap: [{ step: 'MVP', desc: 'Релиз базового поиска' }], synergies: [{ target: 'Alba Creation', type: 'Апсейл', text: 'B2B-клиенты InSights, которым нужна кастомная доработка платформы, ведутся на full-stack услуги студии' }] },
    { id: 'hranitel', title: 'Хранитель', badge: 'Документооборот', badgeBg: 'rgba(48,209,88,0.15)', badgeColor: '#30d158', target: 'Enterprise, Госсектор', value: 'Поиск по сканам в закрытом контуре', desc: 'RAG-система для работы с архивами', roadmap: [{ step: 'Пилот', desc: 'Внедрение в первую корпорацию' }], synergies: [{ target: 'Alba Creation', type: 'Апсейл', text: 'Enterprise-клиенты Хранителя конвертируются в контракты на доп. интеграции и поддержку от студии' }] },
    { id: 'duet', title: 'ДУЭТ', badge: 'Образование', badgeBg: 'rgba(191,90,242,0.15)', badgeColor: '#bf5af2', target: 'Школы, B2G', value: 'Автоматизация расписаний', desc: 'Управление образовательным процессом', roadmap: [{ step: 'Серт.', desc: 'Получение лицензий' }], synergies: [{ target: 'legitAgent', type: 'Кросс-промо', text: 'Разработчики образовательных модулей ДУЭТ используют open-source инструментарий legitAgent' }] },
    { id: 'crista', title: 'Crista', badge: 'HoReCa', badgeBg: 'rgba(255,159,10,0.15)', badgeColor: '#ff9f0a', target: 'Рестораны, Отели', value: 'Автоматизация бронирований', desc: 'CRM для сегмента гостеприимства', roadmap: [{ step: 'Бета', desc: 'Тест на 3 ресторанах' }], synergies: [{ target: 'Фантазия', type: 'Кросс-промо', text: 'HoReCa-клиенты Crista с розничными точками переводятся на умные витрины Фантазии' }] },
    { id: 'fantaziya', title: 'Фантазия', badge: 'E-commerce', badgeBg: 'rgba(255,55,95,0.15)', badgeColor: '#ff375f', target: 'Ритейл', value: 'Умные витрины', desc: 'AI-рекомендации для интернет-магазинов', roadmap: [{ step: 'Релиз', desc: 'Запуск интеграции с CMS' }], synergies: [{ target: 'InSights', type: 'Апсейл', text: 'Ритейлеры Фантазии, которым нужна аналитика инфлюенсеров, ведутся в InSights' }] },
    { id: 'legitagent', title: 'legitAgent', badge: 'Open Source', badgeBg: 'rgba(100,210,255,0.15)', badgeColor: '#64d2ff', target: 'Разработчики', value: 'NPM пакеты и CLI инструменты', desc: 'Инструментарий для фронтенд разработчиков', roadmap: [{ step: 'v1.0', desc: 'Стабильный релиз ядра' }], synergies: [{ target: 'Alba Creation', type: 'Лид-магнит', text: 'Разработчики, познакомившиеся с open-source инструментами, заказывают кастомную разработку у студии' }] },
    { id: 'alba-creation', title: 'Alba Creation', badge: 'Студия', badgeBg: 'rgba(94,92,230,0.15)', badgeColor: '#5e5ce6', target: 'Все клиенты', value: 'Full-stack разработка', desc: 'Цифровая веб-студия полного цикла', roadmap: [{ step: 'Масштаб', desc: 'Выход на международный рынок' }], synergies: [] }
];

let ideasBank = [];
let scheduledEvents = [];
let tgMeta = { chatId: '', hasToken: false, tokenPreview: '' };
let vkMeta = { groupId: '', hasToken: false, tokenPreview: '' };
let igMeta = { businessAccountId: '', hasToken: false, tokenPreview: '' };
let ytMeta = { clientId: '', channelTitle: '', hasClientSecret: false, hasRefreshToken: false, configured: false };
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
        const [ideas, events, plan, telegram, vk, instagram, youtube, contentPlan, nichesList, projectInfoMap, agentSettingsData, rubrics] = await Promise.all([
            api('/api/ideas'),
            api('/api/events'),
            api('/api/settings/plan'),
            api('/api/settings/telegram'),
            api('/api/settings/vk'),
            api('/api/settings/instagram'),
            api('/api/settings/youtube'),
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

    const tabMap = { 'products': 0, 'bank': 1, 'kanban': 2, 'analytics': 3, 'graph': 4, 'calendar': 5, 'contentplan': 6, 'clients': 7, 'customers': 8, 'mediaassets': 9, 'urlchecker': 10, 'agentsettings': 11, 'systeminfo': 12, 'agentcenter': 13 };
    if (tabMap[tabName] !== undefined) {
        const tabs = document.querySelectorAll('.tab-item');
        if (tabs[tabMap[tabName]]) tabs[tabMap[tabName]].classList.add('active');
    }

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
    if (tabName === 'agentsettings') renderAgentSettingsForm();
    if (tabName === 'agentcenter') renderAgentCenter();
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
    if (countBadge) countBadge.innerText = ideasBank.length;

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
                <button class="edit-btn" onclick="generateAIPrompt('${idea.id}')">🤖 AI Промпт</button>
                <button class="tg-btn" onclick="copyTelegramFormatted('${idea.id}')">📋 Скопировать</button>
                <button class="tg-btn" style="background:#0088cc;" onclick="postToTelegram('${idea.id}')">✈️ В TG Bot</button>
                <button class="tg-btn" style="background:#0077FF;${vkMeta.hasToken ? '' : 'opacity:0.5;'}" onclick="postToVk('${idea.id}')">${vkMeta.hasToken ? '🔵 В VK' : '🔵 VK (не настроено)'}</button>
                <button class="tg-btn" style="background:#E1306C;${igMeta.hasToken ? '' : 'opacity:0.5;'}" onclick="postToInstagram('${idea.id}')">${igMeta.hasToken ? '📸 В Instagram' : '📸 Instagram (не настроено)'}</button>
                <button class="tg-btn" style="background:#FF0000;${ytMeta.configured ? '' : 'opacity:0.5;'}" onclick="postToYoutube('${idea.id}')">${ytMeta.configured ? '▶️ На YouTube' : '▶️ YouTube (не настроено)'}</button>
                <button class="schedule-btn" onclick="openScheduleForIdea('${idea.id}')">📅 В календарь</button>
                <button class="edit-btn" onclick="openMetricsModal('${idea.id}')">📊 ROI</button>
                <button class="delete-btn" onclick="deleteIdea('${idea.id}')">🗑</button>
            </div>
        </div>`;
    });

    container.innerHTML = html;
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
        showToast(`Статус изменен на ${targetStatus}`);
    } catch (err) {
        showToast('Не удалось изменить статус: ' + err.message);
    }
}

// AI ПРОМПТ ГЕНЕРАТОР
function generateAIPrompt(ideaId) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    const targetProduct = productsData.find(p => idea.targetGroups && idea.targetGroups.includes(p.id));
    const productName = targetProduct ? targetProduct.title : "Alba Creation Studio";

    const promptText = `Напиши готовый контент для ${idea.format} на тему: "${idea.title}".
Продукт: ${productName}.
Целевая аудитория и ценность: ${targetProduct ? targetProduct.value : 'B2B/B2C клиенты цифровой студии'}.
Контекст и тезисы: ${idea.desc || 'Сфокусируйся на преимуществах и решении болей'}.
Этап воронки: ${idea.funnel || 'TOFU (Охват)'}.
Обязательный CTA в конце: ${idea.cta || 'Записаться на консультацию'}.
Стиль: Лаконичный, экспертный, без лишней "воды", с четким форматированием списков и абзацев.`;

    const pTitle = document.getElementById('ai-prompt-title');
    const pText = document.getElementById('ai-prompt-text');
    if (pTitle) pTitle.innerText = `Промпт: ${idea.title}`;
    if (pText) pText.value = promptText;
    openOverlay('ai-prompt-overlay');
}

function copyGeneratedPrompt() {
    const text = document.getElementById('ai-prompt-text')?.value || '';
    navigator.clipboard.writeText(text);
    showToast('Промпт скопирован в буфер!');
    closeOverlay('ai-prompt-overlay');
}

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
                <div class="media-asset-url" title="${escapeHtml(asset.url)}">${escapeHtml(asset.url)}</div>
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
            showToast('Импортировано успешно!');
        } catch (err) { alert('Ошибка чтения JSON файла: ' + err.message); }
    };
    reader.readAsText(file);
}

// TELEGRAM BOT API (токен хранится и используется только на сервере)
async function openTgSettings() {
    try {
        tgMeta = await api('/api/settings/telegram');
    } catch (e) {
        showToast('Не удалось получить настройки Telegram: ' + e.message);
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
    openOverlay('tg-config-overlay');
}

async function saveTgSettings() {
    const token = document.getElementById('tg-token-input').value.trim();
    const chatId = document.getElementById('tg-chat-input').value.trim();

    try {
        tgMeta = await api('/api/settings/telegram', { method: 'PUT', body: JSON.stringify({ token, chatId }) });
        closeOverlay('tg-config-overlay');
        showToast('Настройки Telegram сохранены');
    } catch (e) {
        showToast('Не удалось сохранить настройки Telegram: ' + e.message);
    }
}

async function postToTelegram(ideaId) {
    if (!tgMeta.hasToken || !tgMeta.chatId) {
        alert('Укажите Bot Token и Chat ID в настройках Telegram!');
        openTgSettings();
        return;
    }

    try {
        await api('/api/telegram/post', { method: 'POST', body: JSON.stringify({ ideaId }) });
        showToast('Опубликовано в Telegram!');
    } catch (e) {
        alert('Ошибка отправки: ' + e.message);
    }
}

// VK (community wall.post)
async function openVkSettings() {
    try {
        vkMeta = await api('/api/settings/vk');
    } catch (e) {
        showToast('Не удалось получить настройки VK: ' + e.message);
    }
    const tokenInput = document.getElementById('vk-token-input');
    const groupInput = document.getElementById('vk-group-input');
    if (tokenInput) {
        tokenInput.value = '';
        tokenInput.placeholder = vkMeta.hasToken
            ? `Сохранён токен ${vkMeta.tokenPreview} — введите новый, чтобы заменить`
            : 'vk1.a.xxxxxxxx...';
    }
    if (groupInput) groupInput.value = vkMeta.groupId || '';
    openOverlay('vk-config-overlay');
}

async function saveVkSettings() {
    const accessToken = document.getElementById('vk-token-input').value.trim();
    const groupId = document.getElementById('vk-group-input').value.trim();
    try {
        vkMeta = await api('/api/settings/vk', { method: 'PUT', body: JSON.stringify({ accessToken, groupId }) });
        closeOverlay('vk-config-overlay');
        showToast('Настройки VK сохранены');
        renderBankView();
    } catch (e) {
        showToast('Не удалось сохранить настройки VK: ' + e.message);
    }
}

async function postToVk(ideaId) {
    if (!vkMeta.hasToken || !vkMeta.groupId) {
        alert('Укажите Access Token и ID сообщества в настройках VK!');
        openVkSettings();
        return;
    }
    try {
        await api('/api/publish/vk', { method: 'POST', body: JSON.stringify({ ideaId }) });
        showToast('Опубликовано в VK!');
    } catch (e) {
        alert('Ошибка отправки в VK: ' + e.message);
    }
}

// Instagram (Content Publishing API: create media container, then publish)
async function openIgSettings() {
    try {
        igMeta = await api('/api/settings/instagram');
    } catch (e) {
        showToast('Не удалось получить настройки Instagram: ' + e.message);
    }
    const tokenInput = document.getElementById('ig-token-input');
    const accountInput = document.getElementById('ig-account-input');
    if (tokenInput) {
        tokenInput.value = '';
        tokenInput.placeholder = igMeta.hasToken
            ? `Сохранён токен ${igMeta.tokenPreview} — введите новый, чтобы заменить`
            : 'EAAxxxxxxxx...';
    }
    if (accountInput) accountInput.value = igMeta.businessAccountId || '';
    openOverlay('ig-config-overlay');
}

async function saveIgSettings() {
    const accessToken = document.getElementById('ig-token-input').value.trim();
    const businessAccountId = document.getElementById('ig-account-input').value.trim();
    try {
        igMeta = await api('/api/settings/instagram', { method: 'PUT', body: JSON.stringify({ accessToken, businessAccountId }) });
        closeOverlay('ig-config-overlay');
        showToast('Настройки Instagram сохранены');
        renderBankView();
    } catch (e) {
        showToast('Не удалось сохранить настройки Instagram: ' + e.message);
    }
}

async function postToInstagram(ideaId) {
    if (!igMeta.hasToken || !igMeta.businessAccountId) {
        alert('Укажите Page Access Token и Business Account ID в настройках Instagram!');
        openIgSettings();
        return;
    }
    try {
        await api('/api/publish/instagram', { method: 'POST', body: JSON.stringify({ ideaId }) });
        showToast('Опубликовано в Instagram!');
    } catch (e) {
        alert('Ошибка отправки в Instagram: ' + e.message);
    }
}

// YouTube (Data API v3 videos.insert via OAuth2 refresh token)
async function openYtSettings() {
    try {
        ytMeta = await api('/api/settings/youtube');
    } catch (e) {
        showToast('Не удалось получить настройки YouTube: ' + e.message);
    }
    const clientIdInput = document.getElementById('yt-client-id-input');
    const clientSecretInput = document.getElementById('yt-client-secret-input');
    const refreshTokenInput = document.getElementById('yt-refresh-token-input');
    const channelTitleInput = document.getElementById('yt-channel-title-input');
    if (clientIdInput) clientIdInput.value = ytMeta.clientId || '';
    if (clientSecretInput) {
        clientSecretInput.value = '';
        clientSecretInput.placeholder = ytMeta.hasClientSecret ? 'Сохранён — введите новый, чтобы заменить' : 'GOCSPX-xxxxxxxx...';
    }
    if (refreshTokenInput) {
        refreshTokenInput.value = '';
        refreshTokenInput.placeholder = ytMeta.hasRefreshToken ? 'Сохранён — введите новый, чтобы заменить' : '1//0gxxxxxxxx...';
    }
    if (channelTitleInput) channelTitleInput.value = ytMeta.channelTitle || '';
    openOverlay('yt-config-overlay');
}

async function saveYtSettings() {
    const clientId = document.getElementById('yt-client-id-input').value.trim();
    const clientSecret = document.getElementById('yt-client-secret-input').value.trim();
    const refreshToken = document.getElementById('yt-refresh-token-input').value.trim();
    const channelTitle = document.getElementById('yt-channel-title-input').value.trim();
    try {
        ytMeta = await api('/api/settings/youtube', { method: 'PUT', body: JSON.stringify({ clientId, clientSecret, refreshToken, channelTitle }) });
        closeOverlay('yt-config-overlay');
        showToast('Настройки YouTube сохранены');
        renderBankView();
    } catch (e) {
        showToast('Не удалось сохранить настройки YouTube: ' + e.message);
    }
}

async function postToYoutube(ideaId) {
    if (!ytMeta.configured) {
        alert('Укажите Client ID, Client Secret и Refresh Token в настройках YouTube!');
        openYtSettings();
        return;
    }
    try {
        await api('/api/publish/youtube', { method: 'POST', body: JSON.stringify({ ideaId }) });
        showToast('Опубликовано на YouTube!');
    } catch (e) {
        alert('Ошибка отправки на YouTube: ' + e.message);
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

async function saveProjectAbout(productId) {
    const textarea = document.getElementById('project-about-textarea');
    if (!textarea) return;
    const about = textarea.value;
    try {
        await api(`/api/project-info/${productId}`, { method: 'PUT', body: JSON.stringify({ about }) });
        projectInfo[productId] = about;
        showToast('Описание проекта сохранено!');
    } catch (e) {
        showToast('Не удалось сохранить описание: ' + e.message);
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

    const favoritedIdeas = ideasBank.filter(i => i.targetGroups && i.targetGroups.includes(productId));

    let html = `
        <h2 style="font-size:26px; font-weight:700; margin:0 0 6px 0;">${product.title}</h2>
        <div style="font-size:14px; color:var(--text-secondary); margin-bottom:20px;">${product.desc}</div>

        <div class="p-section-title">ЦЕЛЕВАЯ АУДИТОРИЯ & ЦЕННОСТЬ</div>
        <div class="info-box">
            <strong>ЦА:</strong> ${product.target}<br><br>
            <strong>Главный посыл:</strong> ${product.value}
        </div>

        <div class="p-section-title">О ПРОЕКТЕ</div>
        <textarea id="project-about-textarea" class="form-textarea" style="min-height:160px;" placeholder="Расскажите про проект: что это, для кого, как устроено...">${escapeHtml(projectInfo[productId] || '')}</textarea>
        <button class="edit-btn" onclick="saveProjectAbout('${productId}')">💾 Сохранить описание проекта</button>

        <div class="p-section-title" style="margin-top:24px;">ROADMAP ПРОДВИЖЕНИЯ</div>
        <div class="roadmap-list">`;

    product.roadmap.forEach(r => {
        html += `
            <div class="roadmap-step" style="border-left-color:${product.badgeColor}">
                <div class="step-title">${r.step}</div>
                <div class="step-desc">${r.desc}</div>
            </div>`;
    });

    html += `</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin:24px 0 10px 4px;">
            <span class="p-section-title" style="margin:0;">ИЗБРАННЫЕ ИДЕИ (${favoritedIdeas.length})</span>
            <button onclick="switchTab('bank');" style="background:none; border:none; color:var(--accent-blue); font-size:12px; font-weight:600; cursor:pointer;">+ Из Банка</button>
        </div>
        <div>`;

    if (favoritedIdeas.length === 0) {
        html += `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Нет идей для этого проекта.</div>`;
    } else {
        favoritedIdeas.forEach((idea) => {
            html += `
                <div class="idea-card">
                    <div class="idea-header">
                        <div class="idea-title">${idea.title}</div>
                        <span class="format-tag">${idea.format}</span>
                    </div>
                    ${idea.desc ? `<div class="idea-desc-text">${idea.desc}</div>` : ''}
                    <div class="idea-cta">CTA: ${idea.cta}</div>
                    <div class="action-btn-row">
                        <button class="edit-btn" onclick="openEditIdeaModal('${idea.id}')">✏️ Изменить</button>
                        <button class="schedule-btn" onclick="openScheduleForIdea('${idea.id}')">Запланировать</button>
                    </div>
                </div>`;
        });
    }

    html += `</div>`;
    const body = document.getElementById('product-detail-body');
    if (body) body.innerHTML = html;
}

// ИНТЕРАКТИВНЫЙ КАЛЕНДАРЬ И ПИКЕР ИДЕЙ
function openScheduleForIdea(ideaId) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    const targetProduct = productsData.find(p => idea.targetGroups && idea.targetGroups.includes(p.id));
    const pTitle = targetProduct ? targetProduct.title : "Alba Creation";

    currentSelectedIdea = idea;

    const sTitle = document.getElementById('schedule-title');
    const sCat = document.getElementById('schedule-category');
    if (sTitle) sTitle.innerText = idea.title;
    if (sCat) sCat.innerText = `Продукт: ${pTitle}`;
    openOverlay('schedule-overlay');
}

async function confirmSchedule() {
    const chosenDate = document.getElementById('schedule-date-input').value;
    if (!chosenDate || !currentSelectedIdea) return;

    const targetProduct = productsData.find(p => currentSelectedIdea.targetGroups && currentSelectedIdea.targetGroups.includes(p.id));
    const pTitle = targetProduct ? targetProduct.title : "Alba Creation";
    const pColor = targetProduct ? targetProduct.badgeColor : "#0a84ff";

    const d = new Date(chosenDate);
    const dayNames = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
    const monthNames = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
    const dateStr = `${dayNames[d.getDay()]}, ${d.getDate()} ${monthNames[d.getMonth()]}`;

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
        }) });

        scheduledEvents.push(created);
        scheduledEvents.sort((a,b) => new Date(a.rawDate) - new Date(b.rawDate));
        renderCalendar();
        updatePlanProgress();
        checkFunnelBalance();

        closeOverlay('schedule-overlay');
        showToast(`Запланировано на ${d.getDate()} ${monthNames[d.getMonth()]}`);
        switchTab('calendar');
    } catch (e) {
        showToast('Не удалось запланировать публикацию: ' + e.message);
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
            html += `
            <div class="day-large-card" style="border-left: 4px solid ${item.color}; background: var(--bg-grouped); border-radius: 14px; padding: 16px; margin-bottom: 14px; border: 1px solid rgba(255,255,255,0.08);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-weight:700; font-size:15px; color:var(--text-primary);">Публикация</span>
                    <span class="slot-badge" style="background:${item.color}22; color:${item.color}; font-size:11px; padding:3px 8px; border-radius:6px; font-weight:600;">${item.format || 'Пост'}</span>
                </div>
                <div style="font-size:16px; font-weight:600; margin-bottom:6px;">${item.title}</div>
                <div style="font-size:13px; color:var(--text-secondary); margin-bottom:10px;">${item.desc}</div>
                <div class="info-box" style="font-size:12px; margin-bottom:10px; padding:8px;"><strong>CTA:</strong> ${item.cta}</div>
                <button class="delete-btn" style="width:100%; justify-content:center; padding:8px;" onclick="deleteEvent(${item.id}, '${dateStr}')">🗑 Удалить публикацию</button>
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

async function attachIdeaToDay(ideaId, dateStr) {
    const idea = ideasBank.find(i => i.id === ideaId);
    if (!idea) return;

    const d = new Date(dateStr);
    const dayNames = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
    const monthNames = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
    const dateDisplayStr = `${dayNames[d.getDay()]}, ${d.getDate()} ${monthNames[d.getMonth()]}`;

    const targetProduct = productsData.find(p => idea.targetGroups && idea.targetGroups.includes(p.id));
    const pTitle = targetProduct ? targetProduct.title : "Alba Creation";
    const pColor = targetProduct ? targetProduct.badgeColor : "#0a84ff";

    try {
        const created = await api('/api/events', { method: 'POST', body: JSON.stringify({
            ideaId: idea.id,
            title: `${pTitle}: ${idea.title}`,
            dateStr: dateDisplayStr,
            rawDate: dateStr,
            color: pColor,
            format: idea.format || 'TG Пост',
            cta: idea.cta || 'Ссылка на Alba Creation',
            desc: idea.desc || `Запланировано из банка (${pTitle})`,
        }) });

        scheduledEvents.push(created);
        scheduledEvents.sort((a,b) => new Date(a.rawDate) - new Date(b.rawDate));
        updatePlanProgress();
        checkFunnelBalance();
        renderDayDetailPage(dateStr);
        showToast(`Публикация добавлена на ${d.getDate()} ${monthNames[d.getMonth()]}`);
    } catch (e) {
        showToast('Не удалось добавить публикацию: ' + e.message);
    }
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
            ${collapsed ? '' : `<textarea class="form-textarea script-section-text" placeholder="Текст раздела скрипта..." onclick="event.stopPropagation()" oninput="setNicheSectionField(${idx}, 'text', this.value)">${escapeHtml(s.text)}</textarea>`}
        </div>`;
    });

    html += `</div>
        <button class="edit-btn" style="width:100%; margin-top:8px;" onclick="addNicheSection()">+ Добавить раздел</button>
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
    const url = input.value.trim();
    if (!url) return showToast('Введите URL');

    btn.disabled = true;
    btn.textContent = 'Проверяю...';
    document.getElementById('url-checker-results').innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary); margin-top:20px;">Сканирую сайт и запускаю нагрузочный тест...</div>`;

    try {
        const report = await api('/api/url-checker/scan', { method: 'POST', body: JSON.stringify({ url }) });
        urlCheckerLastReport = report;
        renderUrlCheckReport(report);
    } catch (e) {
        document.getElementById('url-checker-results').innerHTML = `<div class="info-box" style="text-align:center; color:var(--accent-red); margin-top:20px;">Ошибка: ${escapeHtml(e.message)}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Проверить';
    }
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

    const findingsHtml = findings.length === 0
        ? `<div class="info-box" style="color:var(--text-secondary);">Находок не обнаружено статическим анализом HTML.</div>`
        : findings.map(f => `
            <div class="uc-finding">
                <div class="uc-finding-head">
                    <span class="format-tag" style="background:${severityBg[f.severity] || severityBg.low}; color:${severityColor[f.severity] || severityColor.low}">${escapeHtml(String(f.severity || '').toUpperCase())}</span>
                    <b>${escapeHtml(f.ruleId || '')}</b>
                </div>
                <div class="idea-desc-text">${escapeHtml(f.message || '')}</div>
                ${f.fix ? `<div style="color:var(--accent-green); font-size:12px;">Исправление: ${escapeHtml(f.fix)}</div>` : ''}
            </div>`).join('');

    const loadTestHtml = lt.error
        ? `<div class="info-box" style="color:var(--accent-red);">Ошибка нагрузочного теста: ${escapeHtml(lt.error)}</div>`
        : `<div class="uc-stats-row">
            <div class="uc-stat"><span class="uc-stat-label">Запросов</span><span class="uc-stat-value">${lt.totalRequests ?? '—'}</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Ошибок</span><span class="uc-stat-value">${lt.errors ?? 0} (${Math.round((lt.errorRate || 0) * 100)}%)</span></div>
            <div class="uc-stat"><span class="uc-stat-label">RPS</span><span class="uc-stat-value">${lt.requestsPerSecond ?? '—'}</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Средний</span><span class="uc-stat-value">${lt.avgMs ?? '—'} мс</span></div>
            <div class="uc-stat"><span class="uc-stat-label">p95</span><span class="uc-stat-value">${lt.p95Ms ?? '—'} мс</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Макс</span><span class="uc-stat-value">${lt.maxMs ?? '—'} мс</span></div>
        </div>`;

    container.innerHTML = `
        <div class="p-section-title" style="margin-top:20px;">ДОСТУПНОСТЬ</div>
        <div class="uc-stats-row">${healthStats}</div>
        ${missingHeaders.length ? `<div class="warning-banner" style="margin-top:10px;">Отсутствуют заголовки безопасности: ${missingHeaders.join(', ')}</div>` : ''}

        <div class="p-section-title" style="margin-top:24px;">ЮРИДИЧЕСКИЕ РИСКИ (152-ФЗ / 38-ФЗ / ЗоЗПП) — найдено ${findings.length}</div>
        <div class="uc-stats-row" style="margin-bottom:12px;">
            <div class="uc-stat"><span class="uc-stat-label">Критично</span><span class="uc-stat-value" style="color:var(--accent-red)">${summary.high || 0}</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Средне</span><span class="uc-stat-value" style="color:var(--accent-orange)">${summary.medium || 0}</span></div>
            <div class="uc-stat"><span class="uc-stat-label">Низко</span><span class="uc-stat-value">${summary.low || 0}</span></div>
        </div>
        <div class="uc-findings-list">${findingsHtml}</div>

        <div class="p-section-title" style="margin-top:24px;">НАГРУЗОЧНЫЙ ТЕСТ</div>
        ${loadTestHtml}

        <div class="controls-row" style="margin-top:24px;">
            <p style="color:var(--text-secondary); font-size:11px; margin:0;">Эвристическая проверка, не юридическое заключение. Нагрузочный тест — только для своих/клиентских проектов.</p>
            <button class="edit-btn" onclick="generateUrlCheckPdf()">📄 Сформировать и скачать PDF</button>
        </div>
    `;
}

async function generateUrlCheckPdf() {
    if (!urlCheckerLastReport) return;
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
    }
}

// ЗАКАЗЧИКИ (2ГИС-парсер по нишам)
let parserNiches = [];
let parserPollTimers = {};

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
                <span class="parser-niche-status ${n.status}">${statusLabels[n.status] || n.status}</span>
            </div>
            <input type="text" class="form-input" value="${escapeHtml(n.description)}"
                placeholder="Описание ниши (для генерации запросов)" onblur="saveParserNicheField('${n.id}','description',this.value)">

            <div class="parser-niche-console" id="parser-log-${n.id}">${escapeHtml(n.log || '')}</div>

            <div class="parser-niche-files">
                ${n.files.raw ? `<div class="parser-file-badge" onclick="downloadParserFile('${n.id}','raw')">📊 raw.xlsx</div>` : ''}
                ${n.files.dedup ? `<div class="parser-file-badge" onclick="downloadParserFile('${n.id}','dedup')">✨ dedup.xlsx</div>` : ''}
                ${n.files.archive ? `<div class="parser-file-badge" onclick="downloadParserFile('${n.id}','archive')">🗄 archive.zip</div>` : ''}
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
                <div class="media-asset-url" title="${escapeHtml(asset.url)}">${escapeHtml(asset.url)}</div>
                <div class="parser-niche-actions">
                    <button class="delete-btn" onclick="deleteMediaAsset('${asset.id}')">Удалить</button>
                </div>
            </div>
        </div>
    `).join('');
}

function openAddMediaAssetForm() {
    document.getElementById('media-asset-generate-form').style.display = 'none';
    document.getElementById('media-asset-form').style.display = 'block';
    document.getElementById('ma-url-input').value = '';
    document.getElementById('ma-tags-input').value = '';
    document.getElementById('ma-type-input').value = 'image';
    document.getElementById('ma-product-input').value = '';
}

function closeAddMediaAssetForm() {
    document.getElementById('media-asset-form').style.display = 'none';
}

async function submitNewMediaAsset() {
    const url = document.getElementById('ma-url-input').value.trim();
    const type = document.getElementById('ma-type-input').value;
    const productId = document.getElementById('ma-product-input').value;
    const tags = document.getElementById('ma-tags-input').value.split(',').map(t => t.trim()).filter(Boolean);

    if (!url) return alert('Укажите URL медиа');

    try {
        const created = await api('/api/media-assets', {
            method: 'POST',
            body: JSON.stringify({ url, type, productId: productId || null, tags }),
        });
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
    document.getElementById('vo-voiceid-input').value = '';
    document.getElementById('vo-product-input').value = '';
}

function closeVoiceoverForm() {
    document.getElementById('voiceover-form').style.display = 'none';
}

// Calls POST /api/media-assets/generate-voiceover (ElevenLabs TTS, see
// server/lib/elevenLabsClient.js). If ELEVENLABS_API_KEY isn't set on the
// server, the endpoint responds with a normal error JSON ({ error }) which
// the shared api() helper turns into a thrown Error - handled here the same
// way every other optional integration in this app surfaces a "not
// configured" failure: an error toast, no hardcoded assumption about why it failed.
async function submitVoiceoverGeneration() {
    const text = document.getElementById('vo-text-input').value.trim();
    const voiceId = document.getElementById('vo-voiceid-input').value.trim();
    const productId = document.getElementById('vo-product-input').value;

    if (!text) return alert('Введите текст для озвучки');

    const btn = document.getElementById('vo-generate-btn');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Генерируем…';

    try {
        const created = await api('/api/media-assets/generate-voiceover', {
            method: 'POST',
            body: JSON.stringify({ text, voiceId: voiceId || undefined, productId: productId || null }),
        });
        mediaAssets.unshift(created);
        drawMediaAssetsGrid();
        closeVoiceoverForm();
        showToast('Озвучка сгенерирована!');
    } catch (e) {
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
    try {
        const created = await api(endpoint, {
            method: 'POST',
            body: JSON.stringify({ prompt, productId: productId || null }),
        });
        mediaAssets.unshift(created);
        drawMediaAssetsGrid();
        closeGenerateMediaAssetForm();
        showToast('Обложка сгенерирована!');
    } catch (e) {
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
    await loadContentRubrics();
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
