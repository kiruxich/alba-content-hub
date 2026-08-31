import { Router } from 'express';
import { db } from '../db.js';
import { telegramApiBase } from '../lib/telegramApiBase.js';

const router = Router();

const ACCEPT_RE = /^(ок|окей|ok|да|👍)$/iu;
const REJECT_RE = /^(нет|отклонить|отказ)$/iu;

// Telegram POSTs an Update object here whenever the bot receives a message
// (after scripts/register-telegram-webhook.mjs has been run once - see that
// file). We only care about plain-text replies to one of our own approval
// prompts (sent by server/lib/telegramApproval.js), correlated via
// message.reply_to_message.message_id -> telegram_approvals.message_id.
router.post('/', async (req, res) => {
    const settingsRes = await db.execute('SELECT token, chat_id, webhook_secret FROM telegram_settings WHERE id = 1');
    const settings = settingsRes.rows[0];

    // Telegram echoes back the secret_token we set during setWebhook on every
    // call (header below) - this is what stops a stranger who finds this URL
    // from injecting fake approvals. Reject outright if no secret is on
    // record yet rather than treating "unconfigured" as "open".
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    if (!settings?.webhook_secret || provided !== settings.webhook_secret) {
        return res.status(401).json({ error: 'invalid webhook secret' });
    }

    // Ack immediately: Telegram retries (and can eventually disable) a
    // webhook that doesn't answer 200 promptly, and processing happens
    // fire-and-forget below so one malformed update can't hold up delivery
    // or take the endpoint down.
    res.status(200).json({ ok: true });

    try {
        await handleUpdate(req.body, settings);
    } catch (e) {
        console.error('telegramWebhook: failed to process update:', e);
    }
});

async function handleUpdate(update, settings) {
    const message = update?.message;
    const replyTo = message?.reply_to_message;
    if (!message || !replyTo) return; // not a reply to anything - nothing to correlate

    const text = (message.text || '').trim();
    if (!text) return;

    const messageId = String(replyTo.message_id);
    const approvalRes = await db.execute({
        sql: 'SELECT * FROM telegram_approvals WHERE message_id = ? ORDER BY id DESC LIMIT 1',
        args: [messageId],
    });
    const approval = approvalRes.rows[0];
    if (!approval) return; // reply to some other message, not one of our approval prompts

    let replyText;
    if (ACCEPT_RE.test(text)) {
        // Sets the idea to 'ready', not 'published': the approval message is a
        // review draft, not the final channel post, so auto-triggering
        // telegram.js's /post here would double-post to the real channel.
        // Publishing stays a deliberate separate action from the app.
        await db.execute({ sql: "UPDATE ideas SET status = 'ready' WHERE id = ?", args: [approval.idea_id] });
        await db.execute({
            sql: "UPDATE telegram_approvals SET status = 'approved', updated_at = strftime('%s','now') WHERE id = ?",
            args: [approval.id],
        });
        replyText = '✅ Принято, статус идеи — «Готово».';
    } else if (REJECT_RE.test(text)) {
        // Back to 'idea' (not deleted) so it stays editable/reworkable by hand
        // instead of being lost.
        await db.execute({ sql: "UPDATE ideas SET status = 'idea' WHERE id = ?", args: [approval.idea_id] });
        await db.execute({
            sql: "UPDATE telegram_approvals SET status = 'rejected', updated_at = strftime('%s','now') WHERE id = ?",
            args: [approval.id],
        });
        replyText = '❌ Отклонено, идея возвращена в черновики.';
    } else {
        await db.execute({
            sql: "UPDATE telegram_approvals SET status = 'regenerate_requested', regenerate_notes = ?, updated_at = strftime('%s','now') WHERE id = ?",
            args: [text, approval.id],
        });
        await appendRegenerateNote(approval.idea_id, text);
        replyText = '✏️ Принято как правки — идея уйдёт на переработку Generator-агентом.';
    }

    if (settings.token && settings.chat_id) {
        await fetch(`${telegramApiBase()}/bot${settings.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: settings.chat_id,
                text: replyText,
                reply_to_message_id: message.message_id,
            }),
        });
    }
}

// Regenerate instructions aren't acted on here (no Generator rewrite logic
// exists yet) - they're captured on both the approval row (regenerate_notes,
// for a quick audit trail) and the idea's agent_meta (agentMeta.regenerateNotes,
// where a future Generator run would actually look for pending rework
// requests keyed to the idea it's regenerating).
async function appendRegenerateNote(ideaId, note) {
    const ideaRes = await db.execute({ sql: 'SELECT agent_meta FROM ideas WHERE id = ?', args: [ideaId] });
    const idea = ideaRes.rows[0];
    if (!idea) return;
    const meta = idea.agent_meta ? JSON.parse(idea.agent_meta) : {};
    const notes = Array.isArray(meta.regenerateNotes) ? meta.regenerateNotes : [];
    notes.push({ text: note, at: Date.now() });
    meta.regenerateNotes = notes;
    await db.execute({ sql: 'UPDATE ideas SET agent_meta = ? WHERE id = ?', args: [JSON.stringify(meta), ideaId] });
}

export default router;
