import { db } from '../db.js';
import { telegramApiBase } from './telegramApiBase.js';

// Sends a just-created agent-authored idea to Telegram for human review and
// records the resulting message_id in telegram_approvals so a reply to that
// message (handled in server/routes/telegramWebhook.js) can be correlated
// back to this idea. Mirrors the token/chat_id lookup pattern used by
// server/routes/telegram.js and agentResearcher.js's notifyTelegram.
//
// Silently no-ops (returns null) if the bot isn't configured yet or the send
// fails - same "best effort, don't block the idea creation" behavior as the
// existing notifyTelegram helper.
export async function sendIdeaForApproval(idea) {
    const settingsRes = await db.execute('SELECT token, chat_id FROM telegram_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings?.token || !settings?.chat_id) return null;

    const draft = idea.draftText || {};
    const flagsText = idea.qualityFlags && idea.qualityFlags.length
        ? `\n\n⚠️ *Замечания редактора:* ${idea.qualityFlags.join(', ')}`
        : '';

    const text = [
        `🆕 *Новая идея от агента* (#${idea.id})`,
        '',
        `*${idea.title}*`,
        '',
        `*Проблема:*\n${draft.businessProblem || '—'}`,
        '',
        `*Решение:*\n${draft.technicalSolution || '—'}`,
        '',
        `*Результат:*\n${draft.businessResult || '—'}`,
        '',
        `👉 _${draft.cta || idea.cta || ''}_`,
        flagsText,
        '',
        '—',
        'Ответьте на это сообщение:',
        '✅ «ок» / «да» / 👍 — принять',
        '❌ «нет» / «отклонить» — отклонить',
        '✏️ любой другой текст — отправить на доработку',
    ].join('\n');

    try {
        const tgRes = await fetch(`${telegramApiBase()}/bot${settings.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: settings.chat_id, text, parse_mode: 'Markdown' }),
        });
        const data = await tgRes.json();
        if (!data.ok) {
            console.error('telegramApproval: sendMessage failed:', data.description);
            return null;
        }
        const messageId = String(data.result.message_id);
        await db.execute({
            sql: `INSERT INTO telegram_approvals (idea_id, message_id, status) VALUES (?, ?, 'pending')`,
            args: [idea.id, messageId],
        });
        return messageId;
    } catch (e) {
        console.error('telegramApproval: failed to reach Telegram API:', e.message);
        return null;
    }
}
