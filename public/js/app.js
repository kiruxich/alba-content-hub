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
let planSettings = { daily: 1, weekly: 7 };
let currentSelectedIdea = null;
let currentOpenProductId = null;
let selectedPickerDate = null;
let contentPlanBlocks = [];
let niches = [];
let currentOpenNicheId = null;

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
        const [ideas, events, plan, telegram, contentPlan, nichesList] = await Promise.all([
            api('/api/ideas'),
            api('/api/events'),
            api('/api/settings/plan'),
            api('/api/settings/telegram'),
            api('/api/content-plan'),
            api('/api/niches'),
        ]);
        ideasBank = ideas;
        scheduledEvents = events;
        planSettings = plan;
        tgMeta = telegram;
        contentPlanBlocks = contentPlan.blocks;
        niches = nichesList;

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

    const tabMap = { 'products': 0, 'bank': 1, 'kanban': 2, 'analytics': 3, 'graph': 4, 'calendar': 5, 'contentplan': 6, 'clients': 7 };
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

    validateLimits();
    openOverlay('edit-idea-overlay');
}

async function saveIdeaChanges() {
    const id = document.getElementById('edit-idea-id').value;
    const title = document.getElementById('edit-idea-title-input').value.trim();
    const desc = document.getElementById('edit-idea-desc-input').value.trim();
    const format = document.getElementById('edit-idea-format-input').value;
    const funnel = document.getElementById('edit-idea-funnel-input').value;
    const status = document.getElementById('edit-idea-status-input').value;
    const cta = document.getElementById('edit-idea-cta-input').value.trim();

    if (!title) return alert('Укажите название идеи');

    try {
        if (id) {
            const updated = await api(`/api/ideas/${id}`, { method: 'PUT', body: JSON.stringify({ title, desc, format, funnel, status, cta }) });
            ideasBank = ideasBank.map(item => item.id === id ? updated : item);
            showToast('Идея обновлена!');
        } else {
            const created = await api('/api/ideas', { method: 'POST', body: JSON.stringify({ title, desc, format, funnel, status, cta }) });
            ideasBank.unshift(created);
            showToast('Новая идея создана!');
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
    openOverlay('product-detail-overlay');
}

function renderProductDetailContent(productId) {
    const product = productsData.find(p => p.id === productId);
    if (!product) return;

    const navTitle = document.getElementById('p-overlay-nav-title');
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

        <div class="p-section-title">ROADMAP ПРОДВИЖЕНИЯ</div>
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
            <button onclick="closeOverlay('product-detail-overlay'); switchTab('bank');" style="background:none; border:none; color:var(--accent-blue); font-size:12px; font-weight:600; cursor:pointer;">+ Из Банка</button>
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
        closeOverlay('product-detail-overlay');
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
                    <span style="font-weight:600;" onclick="openDayDetail('${dateFormatted}')">${day}</span>
                    <span style="font-size:10px; color:var(--text-secondary);">${totalCount}/${planSettings.daily}</span>
                </div>

                <div class="cal-slot-picker" onclick="openIdeaPickerForDay('${dateFormatted}')" title="Нажмите, чтобы добавить идею из Банка">
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
        <div class="list-item" onclick="openDayDetail('${item.rawDate}')">
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

function openIdeaPickerForDay(dateFormatted) {
    selectedPickerDate = dateFormatted;
    const d = new Date(dateFormatted);
    const monthNames = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

    const titleEl = document.getElementById('picker-date-title');
    if (titleEl) titleEl.innerText = `Добавить публикацию на ${d.getDate()} ${monthNames[d.getMonth()]}`;

    const body = document.getElementById('idea-picker-body');
    if (!body) return;

    // Исключаем идеи, которые УЖЕ есть в календаре
    const scheduledIdeaIds = scheduledEvents.map(e => e.ideaId);
    const availableIdeas = ideasBank.filter(idea => !scheduledIdeaIds.includes(idea.id));

    if (availableIdeas.length === 0) {
        body.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">Все идеи из банка уже запланированы или банк пуст</div>`;
    } else {
        let html = `<div style="display:flex; flex-direction:column; gap:12px;">`;
        availableIdeas.forEach(idea => {
            html += `
            <div class="idea-card" style="margin-bottom:0;">
                <div class="idea-header">
                    <div class="idea-title">${idea.title}</div>
                    <span class="format-tag">${idea.format || 'TG Пост'}</span>
                </div>
                ${idea.desc ? `<div class="idea-desc-text">${idea.desc}</div>` : ''}
                <button class="schedule-btn" style="width:100%; margin-top:8px;" onclick="attachIdeaToDay('${idea.id}', '${dateFormatted}')">+ Запланировать публикацию</button>
            </div>`;
        });
        html += `</div>`;
        body.innerHTML = html;
    }
    openOverlay('idea-picker-overlay');
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
        renderCalendar();
        updatePlanProgress();
        checkFunnelBalance();

        closeOverlay('idea-picker-overlay');
        showToast(`Публикация добавлена на ${d.getDate()} ${monthNames[d.getMonth()]}`);
    } catch (e) {
        showToast('Не удалось добавить публикацию: ' + e.message);
    }
}

// ОТДЕЛЬНАЯ СТРАНИЦА ДНЯ (КРУПНЫЕ КАРТОЧКИ ПУБЛИКАЦИЙ)
function openDayDetail(dateStr) {
    const events = scheduledEvents.filter(e => e.rawDate === dateStr);
    const dateParts = dateStr.split('-');
    const dayNum = parseInt(dateParts[2], 10);
    const monthNames = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
    const monthNum = parseInt(dateParts[1], 10) - 1;

    let html = `<div>
        <h2 style="font-size:22px; font-weight:700; margin-bottom:16px;">Публикации на ${dayNum} ${monthNames[monthNum]} (${events.length})</h2>`;

    if (events.length === 0) {
        html += `<div class="info-box" style="text-align:center;">На этот день публикаций пока нет.</div>`;
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

    html += `
        <button class="schedule-btn" style="width:100%; margin-top:8px;" onclick="closeOverlay('event-detail-overlay'); openIdeaPickerForDay('${dateStr}');">+ Добавить публикацию из банка</button>
    </div>`;

    const body = document.getElementById('event-detail-body');
    if (body) body.innerHTML = html;
    openOverlay('event-detail-overlay');
}

// УДАЛЕНИЕ ЗАПЛАНИРОВАННОЙ ПУБЛИКАЦИИ
async function deleteEvent(eventId, dateStr) {
    try {
        await api(`/api/events/${eventId}`, { method: 'DELETE' });
        scheduledEvents = scheduledEvents.filter(e => e.id !== eventId);
        renderCalendar();
        updatePlanProgress();
        checkFunnelBalance();

        if (dateStr) {
            openDayDetail(dateStr); // Перерисовываем модалку дня
        } else {
            closeOverlay('event-detail-overlay');
        }
        showToast('Публикация удалена из календаря');
    } catch (e) {
        showToast('Не удалось удалить публикацию: ' + e.message);
    }
}

// КОНТЕНТ ПЛАН (редактируемая доска стратегии)
const PLAN_PALETTE = ['#0a84ff', '#30d158', '#bf5af2', '#ff9f0a', '#ff453a', '#64d2ff', '#ff375f', '#5e5ce6'];

function renderContentPlan() {
    const container = document.getElementById('content-plan-grid');
    if (!container) return;

    if (contentPlanBlocks.length === 0) {
        container.innerHTML = `<div class="info-box" style="text-align:center; color:var(--text-secondary);">План пуст — добавьте первый блок.</div>`;
        return;
    }

    let html = '';
    contentPlanBlocks.forEach(block => {
        html += `
        <div class="plan-card" style="border-top-color:${block.color || '#0a84ff'}">
            <div class="plan-card-head">
                <input type="text" class="plan-card-title" value="${escapeHtml(block.title)}" placeholder="Заголовок блока" oninput="setPlanBlockField('${block.id}','title',this.value)">
                <div class="plan-card-actions">
                    <button class="icon-btn" title="Копировать" onclick="copyPlanBlock('${block.id}')">📋</button>
                    <button class="icon-btn" title="Удалить" onclick="removePlanBlock('${block.id}')">🗑</button>
                </div>
            </div>
            <div class="plan-card-swatches">
                ${PLAN_PALETTE.map(c => `<button class="swatch ${c === block.color ? 'active' : ''}" style="background:${c}" title="${c}" onclick="setPlanBlockField('${block.id}','color','${c}')"></button>`).join('')}
            </div>
            <textarea class="plan-card-text" placeholder="Текст блока..." oninput="setPlanBlockField('${block.id}','text',this.value)">${escapeHtml(block.text)}</textarea>
        </div>`;
    });

    container.innerHTML = html;
}

function setPlanBlockField(id, field, value) {
    const block = contentPlanBlocks.find(b => b.id === id);
    if (!block) return;
    block[field] = value;
    if (field === 'color') renderContentPlan();
}

function addPlanBlock() {
    contentPlanBlocks.push({ id: String(Date.now()), title: 'Новый блок', color: '#0a84ff', text: '' });
    renderContentPlan();
}

function removePlanBlock(id) {
    contentPlanBlocks = contentPlanBlocks.filter(b => b.id !== id);
    renderContentPlan();
}

function copyPlanBlock(id) {
    const block = contentPlanBlocks.find(b => b.id === id);
    if (!block) return;
    navigator.clipboard.writeText(`${block.title}\n\n${block.text}`);
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
