# Glossary

**Epic**
A piece of complex work split into ordered tasks, possibly across several repositories, lasting several days. Mirrors a Jira epic; Jira is its source of truth, and Corral stays in sync with it after creation. Carries a versioned design.
_Avoid_: Chantier, plan (a plan is the old one-shot output of a spec task).

**Design**
The living agreement of an Epic (contract between its repositories, decisions). Versioned: a revision shows which tasks it impacts. Only the current version is reflected in the Jira epic; older versions are history.
_Avoid_: contract (the contract is one part of a design).

**Task**
One unit of work inside an Epic, mapped to a Jira ticket and run against one repository.

**Dependency**
A "blocked by" relation between two tasks, taken from the Jira issue links. A task is unblocked when the prerequisite's PR is green and ready (or merged, or its ticket is Done in Jira).

**Precondition**
A condition written in a ticket that is not a Jira link (for example "library X is built"). The agent checks it before starting; if unmet, the task waits for the human.

**Amendment**
A change to one task after a Design revision, proposed by an agent, validated by the human, and written into a delimited block of the Jira ticket. Replaces the previous amendment; never accumulates.

**Impacted task**
A task not yet merged that was started on an older Design version than the current one.
