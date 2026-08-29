// Pure-code quality gate for agent-generated drafts - no LLM call. Verifying
// that a post follows the "Золотая середина" structure doesn't need an AI
// to read the prose; it needs the Generator to hand over that structure as
// separate fields in the first place, and this just checks they're all
// there and reasonable.
const FORMAT_LIMITS = {
    'TG Пост': 4096,
    'Reels / Shorts': 1000,
    'Тред X/Threads': 280,
    'Лонгрид Habr/VC': Infinity,
};

const RESULT_METRIC_RE = /\d+\s*%|\bв\s*\d+\s*раз|\d+x\b|\d+\s*(руб|₽|\$|usd)/i;

export function validateDraft({ businessProblem, technicalSolution, businessResult, cta, format }) {
    const flags = [];

    if (!businessProblem || businessProblem.trim().length < 20) {
        flags.push('missing_business_problem');
    }
    if (!technicalSolution || technicalSolution.trim().length < 20) {
        flags.push('missing_technical_solution');
    }
    if (!businessResult || businessResult.trim().length < 10) {
        flags.push('missing_business_result');
    } else if (!RESULT_METRIC_RE.test(businessResult)) {
        // Золотая середина explicitly requires a measurable metric in the
        // result step, not just "стало лучше" - flag it, don't block on it
        // (the metric-shape regex is a heuristic, not a hard requirement).
        flags.push('result_missing_metric');
    }
    if (!cta || !cta.trim()) {
        flags.push('missing_cta');
    }

    const assembled = [businessProblem, technicalSolution, businessResult].filter(Boolean).join('\n\n');
    const limit = FORMAT_LIMITS[format] ?? FORMAT_LIMITS['TG Пост'];
    if (assembled.length > limit) {
        flags.push('over_char_limit');
    }

    return { flags, assembledText: assembled };
}
