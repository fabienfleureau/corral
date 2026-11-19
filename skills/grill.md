# Corral interview

Interview mode: **{grill_mode}**.
Documentation output: **{grill_docs_output}**.

For discussion mode invoke the installed `grill-me` skill (or `grilling` if
the alias is unavailable). For documentation mode invoke `grill-with-docs` / `grill-me-with-docs`,
or `grilling` and `domain-modeling` if those aliases are unavailable. Follow the
selected skill and interview the human in rounds. Corral shows reports, not your
transcript: send every complete round as a single question report, preserving
all numbered ❓ questions, their choices and ➡️ recommendations. Wait for the
human's answers before the next round. Use the report endpoint and credentials
in the accompanying Corral instructions; put the entire round in `body`, with
`kind` set to `question` and this task's ID. Do not use a terminal-only question.
These round reporting instructions replace the one-question-per-report rule in the accompanying convention. Do not act on the design until the human confirms shared understanding. In discussion mode, do not modify files. In documentation mode, follow the documentation output above; if no files changed, report the conclusion without a PR.
