// Turns a niche's (category, description) into the {query, keywords}[] list
// parser-worker needs. Pure heuristic, no LLM call - this is just splitting
// text into search keywords, not worth the overhead of any AI call.
export async function generateParserQueries(category, description) {
    const words = `${category} ${description || ''}`
        .toLowerCase()
        .split(/[\s,;.!?]+/)
        .map(w => w.trim())
        .filter(w => w.length > 2);
    const keywords = Array.from(new Set(words)).slice(0, 8);
    return [{ query: category.trim(), keywords }];
}
