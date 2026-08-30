// Shared RU/EN field-selection logic for every publish route
// (server/routes/telegram.js, server/routes/socialPublish.js) and every
// server/lib/socialPublishers/*.js function.
//
// The idea's Russian title/desc/cta are always the source of truth;
// title_en/desc_en/cta_en are an optional mirror generated on demand via
// server/routes/ideas.js's POST /:id/translate route ("Перевести на
// английский" in the edit-idea modal).
//
// Never silently posts blank/undefined English text: if 'en' is requested
// but no translation exists at all (title_en empty), resolveLangError()
// returns a clear message the route should turn into a 400. The client-side
// "Опубликовать" modal (openPublishModal/renderPublishLangToggle in
// public/js/app.js) greys out the EN option in that exact case, so this is a
// defense-in-depth backstop for a direct API call, not the primary UX gate.

export function resolveLangError(idea, lang) {
    if (lang === 'en' && !idea.title_en) {
        return 'У этой идеи нет перевода на английский. Сначала переведите её (кнопка «Перевести на английский» в карточке идеи).';
    }
    return null;
}

// Per-field fallback: if title_en exists but desc_en/cta_en don't, falls
// back to the Russian field for just that piece rather than posting an
// empty string.
export function pickLangFields(idea, lang) {
    if (lang !== 'en') {
        return { title: idea.title, desc: idea.desc, cta: idea.cta };
    }
    return {
        title: idea.title_en || idea.title,
        desc: idea.desc_en || idea.desc,
        cta: idea.cta_en || idea.cta,
    };
}
