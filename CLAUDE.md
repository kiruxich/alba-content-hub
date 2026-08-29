# Working style for this project

- Keep step-by-step narration minimal. Don't describe each tool call or intermediate action in prose.
- Only report real checkpoints: what was done, what the result was, and any bugs/blockers found. E.g. "Fixed X — tested, works" or "Found bug: Y, fixing now."
- Skip restating plans already agreed on before executing them.
- If a set of remaining tasks is genuinely independent (separate files/areas, no shared in-flight edits), always split it across parallel subagents to execute concurrently — but ask explicit permission first before dispatching them. Use model "sonnet" (Sonnet 5) for these subagents. Don't do this when the tasks touch the same files you're currently editing yourself (real conflict risk) or when a task is small enough that spinning up an agent costs more time than just doing it directly.
