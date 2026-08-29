// Translates a Russian post (title/desc/cta) to English via a self-hosted
// LibreTranslate instance (same Docker network as the hub container) - no
// external API key, no per-call cost, no dependency on any Claude billing.
const LIBRETRANSLATE_URL = process.env.LIBRETRANSLATE_URL || 'http://libretranslate:5000';

async function translateOne(text) {
    if (!text || !text.trim()) return '';
    const res = await fetch(`${LIBRETRANSLATE_URL}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: 'ru', target: 'en', format: 'text' }),
    });
    if (!res.ok) throw new Error(`LibreTranslate ${res.status}`);
    const data = await res.json();
    return data.translatedText || '';
}

export async function translateToEnglish({ title, desc, cta }) {
    const [titleEn, descEn, ctaEn] = await Promise.all([
        translateOne(title),
        translateOne(desc),
        translateOne(cta),
    ]);
    return { titleEn, descEn, ctaEn };
}
