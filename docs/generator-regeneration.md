# Generator: consuming regeneration requests

Context: the Telegram two-way approval flow (`server/routes/telegramWebhook.js`)
lets a human reviewer reply to an agent-authored idea's approval message with
free text instead of "ок"/"да"/"👍" (approve) or "нет"/"отклонить" (reject).
That free text is treated as rework instructions: it's appended to the idea's
`agentMeta.regenerateNotes` array as `{ text, at }` (and separately logged on
the `telegram_approvals` row for audit only). Nothing currently *acts* on
`regenerateNotes` — that's this contract: what the Generator agent should do
with it.

This doc is meant to be pasted directly into the Generator's prompt.

## 1. Fetch ideas that need a rewrite

```
GET /api/ideas/needs-regeneration
```

Returns every idea that is agent-authored, still sitting in `idea` status
(not yet approved/published — no point reworking something already decided),
and has at least one pending reviewer note.

Response: `200 { items: Idea[] }`

Each `Idea` in `items` is the same shape `GET /api/ideas` returns, plus a
convenience top-level `regenerateNotes` field:

```jsonc
{
  "id": "1735489200000",
  "title": "Как сократить время деплоя вдвое",
  "desc": "...",                     // currently assembled post text (stale until you PUT a revision)
  "format": "TG Пост",
  "funnel": "TOFU",
  "status": "idea",
  "cta": "Забронировать демо",
  "targetGroups": ["CTO", "Team Lead"],
  "metrics": { "views": 0, "saves": 0, "clicks": 0, "leads": 0 },
  "source": "agent",
  "agentMeta": {
    "sourceUrl": "https://...",       // whatever context the original generation run attached - freeform, not a fixed schema
    "regenerateNotes": [
      { "text": "Слишком общий пример, нужен конкретный кейс с цифрами", "at": 1735500000000 }
    ]
  },
  "draftText": {
    "businessProblem": "...",
    "technicalSolution": "...",
    "businessResult": "...",
    "cta": "..."
  },
  "contentType": "evergreen",
  "expiresAt": null,
  "rubricId": null,
  "qualityFlags": ["result_missing_metric"],
  "coverAssetId": null,
  "regenerateNotes": [
    { "text": "Слишком общий пример, нужен конкретный кейс с цифрами", "at": 1735500000000 }
  ]
}
```

Use `draftText` as the current version to revise, `regenerateNotes` (an
array, oldest first, one entry per free-text reply — there can be more than
one if the idea went back and forth) as the instructions to address, and
`agentMeta` / `targetGroups` / `format` / `funnel` / `cta` as the original
context to stay consistent with.

## 2. Write a revised draft

Produce a new `draftText` object with the same shape as before:

```jsonc
{
  "businessProblem": "...",
  "technicalSolution": "...",
  "businessResult": "...",   // include a measurable metric (%, "в N раз", Nx, or a ruble/$/USD figure) or it gets flagged
  "cta": "..."
}
```

This is the same shape validated by `validateDraft()` in
`server/lib/editorValidation.js` when an idea is first created via
`POST /api/ideas` — see that file for the exact rules (minimum lengths for
each field, the metric regex, and the per-format character limit that
`businessProblem + technicalSolution + businessResult` combined must fit
under).

## 3. PUT the revision back

```
PUT /api/ideas/:id
Content-Type: application/json

{ "draftText": { "businessProblem": "...", "technicalSolution": "...", "businessResult": "...", "cta": "..." } }
```

That's the minimal body — you don't need to resend `title`, `agentMeta`,
`targetGroups`, etc.; the PUT handler only overwrites fields you include and
leaves everything else as-is (see `server/routes/ideas.js`, `router.put`).

On this request, for an agent-sourced idea, the server:

- **Re-validates and re-assembles `desc`**: runs the same `validateDraft()`
  used on creation against the new `draftText` and recomputes `desc` (the
  assembled post text) and `qualityFlags` from it — wired identically to the
  `POST /api/ideas` path, so the visible post text and quality flags never
  stay frozen on the pre-rework version.
- **Clears `agentMeta.regenerateNotes`**: since a fresh draft was just
  written, the pending notes are considered addressed. The array is reset to
  `[]` and every other key already on `agentMeta` (e.g. `sourceUrl`) is left
  untouched. This is what makes the idea drop off
  `GET /api/ideas/needs-regeneration` on the next fetch.

If you want to also resend a full `agentMeta` object in the same PUT (e.g.
to add new context), that's fine — it becomes the new base, and
`regenerateNotes` is still cleared on top of it as long as `draftText` is
present in the same request. Don't set `status` in this PUT: the idea should
stay in `idea` status until a human re-reviews it (send it back through the
Telegram approval flow, or whatever the review re-trigger ends up being —
out of scope for this doc).

## Loop summary

1. `GET /api/ideas/needs-regeneration` → get `items`.
2. For each item: read `draftText` + `regenerateNotes` (+ `agentMeta`,
   `targetGroups`, `format`, `funnel`, `cta` for context), write a new
   `draftText` that addresses every note.
3. `PUT /api/ideas/:id` with `{ draftText: <revised> }`.
4. The item disappears from `needs-regeneration` on the next fetch.
