# Epic tasks start from the Epic page

An epic task whose Jira blockers cleared used to appear in the inbox as "Ready to launch". That put the same decision in two places: the epic showed the task as ready, while the inbox asked to start it, even after the epic had changed.

Readiness is now shown only on the Epic page. Syncs and PR refreshes never create launch items. The page offers a **Launch** button on each ready task; the launch endpoint rechecks readiness, applies the same-repo stacked base branch at that moment, then dispatches. Launch items left by older versions are archived when their task starts or becomes blocked again.

An unblocked task therefore stays idle until a human launches it. No agent starts as a side effect of a sync.
