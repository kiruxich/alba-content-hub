// Translates a Russian post (title/desc/cta) to English via Claude, for the
// studio's English-speaking audience. Unlike generateParserQueries, there is
// no sane non-AI fallback for real translation - if ANTHROPIC_API_KEY isn't
// set, this throws a clear error instead of returning garbage.

export async function translateToEnglish({ title, desc, cta }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY не настроен на сервере - перевод недоступен');
    }

    const prompt = `Переведи следующий пост для соцсетей IT-студии Alba Creation с русского на английский.
Сохрани тон (профессиональный, но живой), структуру и эмодзи если есть. Не переводи дословно - адаптируй под нейтральный деловой английский для международной аудитории.

Заголовок: ${title || ''}
Текст: ${desc || ''}
CTA: ${cta || ''}

Ответь СТРОГО валидным JSON без пояснений, в формате:
{"title": "...", "desc": "...", "cta": "..."}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Не удалось разобрать ответ модели');
    const parsed = JSON.parse(match[0]);
    return { titleEn: parsed.title || '', descEn: parsed.desc || '', ctaEn: parsed.cta || '' };
}
