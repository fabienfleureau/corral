# Task and inbox progression

## Intent

Encourage the user to create tasks and handle inbox items through a private, lightweight progression system. Pull-request-specific rewards are out of scope.

## Approach

Start tracking new actions when this version is installed. Historical metrics cannot reliably distinguish human actions from automatic resolutions, so they are not backfilled. An alternative is to derive progression from those metrics, but that would give credit for incomplete or automated history.

## Rules

- Award 10 XP for creating a task and 20 XP for successfully replying to or manually resolving an inbox item. Award each category at most once per entity, even if an action is repeated.
- Exclude automated inbox resolutions, snoozes, archives and failed actions. Existing tasks and inbox items can earn XP only when an eligible action occurs after installation.
- Level starts at 1 and requires 100 XP to reach level 2, 200 more to reach level 3, and 100 more per successive level. Show progress to the next level and the total XP.
- Award task and inbox badges at 1, 10 and 50 distinct eligible actions in each category. Show earned and upcoming badges, with their thresholds.
- Progress is local to the Corral database. There are no streaks, rankings, external sharing or penalties.

## Implementation

Persist deduplicated reward events in an additive SQLite table and calculate the total and badges from those events. Record rewards only in successful user action paths; expose a read-only progression endpoint. Display the current level, progress and badges in the existing interface, refreshing after relevant live events. Preserve the existing task and inbox behavior.

## Validation

Exercise duplicate actions, failed and automatic actions, existing entities, persistence, XP thresholds and badge thresholds in server tests. Check the interface with the fixture and comparable screenshots. Run the repository's required tests, type checks and build.
