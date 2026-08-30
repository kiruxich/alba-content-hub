# Insights Agent: weekly performance review

Context: `server/routes/insights.js` assembles a structured performance
summary from `ideas` joined with `scheduled_events` (Alba Content Hub's
per-platform publication log — see the comment on `scheduled_events.platform`
in `server/db.js`). Nothing in this repo currently reasons over that data.
This doc is the contract for a weekly cloud routine ("Insights") that reads
the summary, forms conclusions about what's working, and writes those
conclusions back so they're available to whoever plans the next batch of
content.

This doc is meant to be pasted directly into the Insights routine's prompt.

## 1. Fetch the performance brief

```
GET /api/insights/brief
GET /api/insights/brief?days=14
```

`days` defaults to 7 (last 7 days including today) if omitted. Max 90.

If there's nothing published with data in the window, you get back:

```json
{
  "status": "insufficient_data",
  "periodStart": "2026-08-24",
  "periodEnd": "2026-08-30",
  "days": 7,
  "publishedCount": 0,
  "message": "No publications with data found between 2026-08-24 and 2026-08-30. Nothing to analyze yet."
}
```

When that happens, don't fabricate conclusions — either skip posting
conclusions this run, or post a short summary saying there wasn't enough
data yet (see step 3). Forcing an analysis out of zero data is worse than
no analysis.

Otherwise you get:

```jsonc
{
  "status": "ok",
  "periodStart": "2026-08-24",
  "periodEnd": "2026-08-30",
  "days": 7,
  "publishedCount": 11,
  // true when every publication in the window still reads zero views/saves/
  // clicks - i.e. the metrics-sync job hasn't populated real numbers for
  // this window yet. byFormat/topPerformers etc. are still returned but
  // will all be zero/tied - treat that as "no signal yet", not as "everything
  // performed equally badly".
  "metricsPending": false,
  "byFormat": [
    { "format": "Reels", "count": 4, "avgViews": 615, "avgSaves": 101, "avgClicks": 25 },
    { "format": "TG Пост", "count": 7, "avgViews": 300, "avgSaves": 22.5, "avgClicks": 5.5 }
  ],
  "byProduct": [
    { "product": "hranitel", "count": 2, "avgViews": 420, "avgSaves": 30 }
  ],
  // Best-effort only - `ideas` has no persisted product_id column today, so
  // byProduct can only attribute agent-authored ideas whose agentMeta happens
  // to carry a targetProduct key. It will often be a short or empty list -
  // don't read a missing product from this as "that product underperformed",
  // just as "not attributed".
  "byProductNote": "Best-effort: only agent-authored ideas whose agentMeta carries a targetProduct are attributed. 2 of 11 publications in this window were attributable to a product.",
  "topPerformers": [
    { "ideaId": "1735489200000", "title": "...", "format": "Reels", "platform": "instagram", "rawDate": "2026-08-28", "views": 1200, "saves": 200, "clicks": 50 }
  ],
  "underperformers": [
    { "ideaId": "1735489200111", "title": "...", "format": "TG Пост", "platform": "telegram", "rawDate": "2026-08-26", "views": 30, "saves": 2, "clicks": 0 }
  ],
  "rubricPerformance": [
    { "rubricId": "rubric-case-of-week", "rubricName": "Кейс недели", "count": 3, "avgViews": 300, "avgSaves": 22.5 }
  ]
}
```

`topPerformers`/`underperformers` are capped at 5 items each, sorted by
views. With very few publications in the window they can overlap — that's
expected, not a bug. `rubricPerformance` only includes ideas that have a
`rubric_id` set; it can be `[]` if nothing in the window used a rubric.

## 2. Analyze

Read the brief like a human doing a "what's working" review, not a data
dump:

- Which format(s) are pulling disproportionate views/saves relative to how
  often they're posted? (`byFormat`, cross-referenced with `count` so a
  format with `count: 1` and a lucky viral hit isn't over-weighted the same
  as one with `count: 5`.)
- Do specific rubrics (`rubricPerformance`) consistently over/under-perform?
- What do the `topPerformers` have in common (format, rubric, platform,
  timing)? What do the `underperformers` have in common?
- If `byProduct` has entries, is one product's content resonating more?
  Treat this as a weak signal given the attribution caveat above.
- If `metricsPending` is `true`, say so plainly instead of drawing
  conclusions from all-zero numbers.

Write:
- `summary`: 2-5 sentences, plain language, the headline takeaway(s) a
  founder/content lead would want to see first.
- `recommendations`: a short list of concrete, actionable suggestions for
  what to create or do differently next — not restatements of the data.
  Each recommendation should be something a person planning next week's
  content could directly act on (e.g. "lean into Reels for the Хранитель
  product — they're averaging 2x the views of TG posts this period" rather
  than "Reels have more views").

## 3. POST your conclusions

```
POST /api/insights/conclusions
Content-Type: application/json

{
  "summary": "Reels outperformed TG posts roughly 2:1 on views this week, and the 'Кейс недели' rubric kept its usual edge in saves. Alba Creation content had the weakest engagement of the week.",
  "recommendations": [
    { "text": "Shift more of next week's Хранитель content to Reels format.", "priority": "high" },
    { "text": "Run another 'Кейс недели' entry for Alba Creation - it's the rubric with the strongest saves-to-views ratio and Alba Creation had none this week.", "priority": "medium" }
  ]
}
```

- `summary` (string, required): the plain-language takeaway. Reject/empty
  values are rejected with `400 { "error": "summary is required" }`.
- `recommendations` (array, optional, defaults to `[]`): shape is up to you
  (the endpoint stores whatever you send as-is) — a `{ text, priority }`
  object per item, as above, is a reasonable default if you have no other
  preference.

On success: `201 { "ok": true, "runDate": "2026-08-30" }`.

Storage note (informational, not something you need to act on): this is
persisted in the same `agent_runs` table the Researcher agent uses
(`agent_name: 'insights'`), with your payload JSON-encoded into that table's
`brief_json` column — a naming leftover from Researcher's original "trend
brief" use case, reused here rather than adding a parallel table.

## 4. Fetch the latest stored conclusions (optional, for verification or reuse)

```
GET /api/insights/latest
```

Returns the most recently POSTed payload directly (not wrapped):

```json
{ "summary": "...", "recommendations": [...], "generatedAt": 1788050840484 }
```

`404 { "error": "no successful insights run yet" }` if nothing has been
posted yet — same shape/behavior as
`GET /api/agent-researcher/latest-brief` when no Researcher run exists.

## Loop summary

1. `GET /api/insights/brief` (optionally with `?days=N`).
2. If `status` is `insufficient_data`, either skip posting or post a short
   "not enough data yet" summary with no recommendations — don't invent
   findings.
3. Otherwise, analyze `byFormat`, `byProduct`, `topPerformers`,
   `underperformers`, and `rubricPerformance` for real, actionable patterns.
4. `POST /api/insights/conclusions` with `{ summary, recommendations }`.
5. Done. `GET /api/insights/latest` will reflect this run until the next one.

## Natural follow-up (out of scope here)

Right now `GET /api/insights/latest` is the only way to see the most recent
conclusions — there's no UI surfacing them. A natural next step (separate
piece of work, not part of this routine's job) would be a small panel in the
Content Plan view that fetches `GET /api/insights/latest` and shows the
summary + recommendations next to the plan, so a human planning next week's
posts sees "what worked last week" without leaving the page. Not built here.
