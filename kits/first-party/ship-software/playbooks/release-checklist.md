---
name: release-checklist
description: Ship a release safely: what is in it, CI green, flags set, the rollback ready, and the announcement written. Use before every release.
---

1. List what merged since the last release (scm pull requests) and check each closes a task.
2. Check CI is green on the release commit (ci runs). A red or flaky run blocks the release until it is understood.
3. Check open incidents (observability): no release while a critical incident is open on the same service.
4. Decide the flags: new features start off or at a small rollout.
5. Write the rollback step and who runs it, then the release note for the CEO and support.
