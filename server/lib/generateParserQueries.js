// Turns a niche's (category, description) into the {query, keywords}[] list
// parser-worker needs. Uses Claude when ANTHROPIC_API_KEY is set for better
// query variety/keyword coverage; otherwise falls back to a plain heuristic
// so "Обновить парсер" still works without that key configured.

function heuristicQueries(category, description) {
    const words = `${category} ${description || ''}`
        .toLowerCase()
        .split(/[\s,;.!?]+/)
        .map(w => w.trim())
        .filter(w => w.length > 2);
    const keywords = Array.from(new Set(words)).slice(0, 8);
    return [{ query: category.trim(), keywords }];
}

export async function generateParserQueries(category, description) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return heuristicQueries(category, description);

    const prompt = `Ты помогаешь настроить парсер организаций 2ГИС под нишу "${category}".
Описание ниши: ${description || 'нет'}.

Сгенерируй JSON-массив из 3-6 вариантов поисковых запросов для 2ГИС (разные формулировки одной и той же ниши, как их вводят реальные пользователи) и для каждого — список ключевых слов для фильтрации рубрики карточки (слова, по которым можно понять, что карточка действительно относится к этой нише).

Ответь СТРОГО валидным JSON без пояснений, в формате:
[{"query": "...", "keywords": ["...", "..."]}]`;

    try {
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
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('no JSON in response');
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty result');
        return parsed;
    } catch (e) {
        console.error('generateParserQueries: Claude call failed, falling back to heuristic:', e.message);
        return heuristicQueries(category, description);
    }
}
