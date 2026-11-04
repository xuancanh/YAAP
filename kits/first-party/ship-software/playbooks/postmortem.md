---
name: postmortem
description: Write a blameless postmortem for a major or critical incident: timeline, impact, causes, what went well, and the actions with owners. Use within three working days of the incident.
---

1. Read the incident and its timeline (observability) and the changes around it (scm, ci).
2. Write the timeline in UTC, the customer impact and its duration.
3. Find the causes, not a culprit: what made the failure possible and what made it slow to detect.
4. List actions with owners and due dates as tasks; each action prevents, detects or limits a recurrence.
5. File it under the engineering folder and summarise it for the chief of staff in five lines.
