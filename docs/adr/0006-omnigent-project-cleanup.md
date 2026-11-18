# 0006 — Clean up an omnigent project after its last Corral task

Status: Proposed

Corral files every dispatched session into a first-class omnigent project named
after the task repository, with the legacy `omni_project` label carrying the
same name. Archiving a session used to set only `archived: true`. The session
stayed a project member, so omnigent kept a repository folder with no visible
sessions and no live work to group.

Decide that archiving a Corral session also detaches it from that project. If
no live session is left in the project, Corral unfiles the remaining archived
members and deletes the project, matching omnigent's own "Delete project"
flow. Only the plain project Corral created is eligible: its name must still
match the session's `omni_project` label and its config must be empty. A
renamed or configured project is kept. Project cleanup is best effort and
never makes a session archive fail; a server that rejects the unfile fields
gets a plain archive with no cleanup.

Alternatives considered:

- Leave the project in place: the empty folder keeps accumulating in omnigent.
- Delete the project row without unfiling its members: memberships dangle and
  label-only folders survive the deletion.
- Delete any project with no visible sessions: a project someone configured
  for their own sessions would lose its settings.

Consequences: archived sessions become unfiled but stay reachable by session
id, and the next dispatch recreates the project. A live or shared member, a
project with more members than one read can enumerate, or a cleanup error
leaves the project alone.
