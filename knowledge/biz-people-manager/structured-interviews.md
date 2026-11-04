---json
{ "title": "Structured interviews and scorecards", "summary": "How to design an interview loop with the same job-related questions, a scored rubric and an evidence-based debrief.", "tags": ["hiring", "interviewing", "scorecard", "fairness"], "updated": "2026-11-04",
  "sources": [{ "title": "Guide: Use structured interviewing", "url": "https://rework.withgoogle.com/en/guides/hiring-use-structured-interviewing", "publisher": "Google re:Work", "accessed": "2026-11-04" }] }
---

# Structured interviews and scorecards

A structured interview asks every candidate for a role the same job-related questions and scores the answers against the same predefined rubric. Google's re:Work guide describes the parts: vetted, relevant questions, detailed written notes, rubrics with example answers, and trained interviewers. It's fairer and easier to defend than a free-form chat, and it gives the debrief something better than "I liked them".

## Build the loop from the must-haves

Take the three to five must-haves from the [hiring plan](./hiring-plan.md). Each one is assessed in at least one stage, and no stage assesses something that isn't on the list. Give each must-have an owner on the panel, so two interviewers don't ask the same thing and nobody covers "culture fit" by gut feel.

Question types:

- **Behavioural (past):** "Tell me about a time you had to … What did you do? What happened?" Probe for the candidate's own actions, not the team's.
- **Situational (hypothetical):** "Suppose a customer … What would you do first, and why?" Useful when candidates may lack direct experience.
- **Work sample:** a short, realistic task tied to the job. Keep it bounded in time and the same for everyone, and follow the company's policy on paying for longer ones.

Avoid brainteasers, questions about personal life, and anything that touches protected characteristics (see [Fairness and legal lines](./fairness-and-legal-lines.md)).

## Scorecard template

```markdown
# Scorecard: <role>, stage <stage>, interviewer <name>
Candidate ref: <ATS id; no names in shared files>
Date: <date>

| Must-have | Question(s) asked | Evidence (what they said/did) | Score 1-4 |
|---|---|---|---|
| <e.g. Diagnoses customer issues> | <Q1, Q2> | <notes> | |
| <…> | | | |

Rubric: 1 = no evidence or concerning · 2 = some evidence, gaps · 3 = solid evidence · 4 = strong, specific, beyond the bar
Overall recommendation: strong no / no / yes / strong yes
One thing I could not assess: <…>
Submitted before debrief: yes / no
```

Write anchors for each must-have before the first interview: what a 1, a 3 and a 4 answer sound like. Without anchors, the numbers mean different things to different interviewers.

## Debrief

1. Every interviewer submits their scorecard before seeing anyone else's. Late scorecards are a finding in the monthly audit.
2. Go must-have by must-have, not interviewer by interviewer. Read the evidence, then the scores.
3. Settle disagreements with evidence ("what did they actually say?"), not seniority.
4. The hiring manager decides in writing, with reasons tied to the must-haves. You record the decision; you don't make it.
5. Rejected candidates get a timely, courteous message, drafted for human approval. Keep the reason general unless company policy says otherwise.

## Checklist

- [ ] Each must-have is mapped to at least one question and one interviewer.
- [ ] Every candidate at a stage gets the same core questions. Follow-up probes are fine.
- [ ] Rubric anchors are written before interviews start.
- [ ] Interviewers are briefed on the rubric and on questions to avoid.
- [ ] Scorecards are submitted independently before the debrief.
- [ ] The decision is recorded with evidence, and the candidate hears back within the response target in `/org/people/cadence.md`.

## Common pitfalls

- **Scoring the conversation, not the evidence.** Rapport and confidence feel like competence. The rubric is there to catch that.
- **Changing questions mid-search.** If a question isn't working, change it for all remaining candidates and note when.
- **Halo effect.** One strong answer lifts every score. Score each must-have on its own evidence.
- **"Culture fit" as a veto.** Turn it into specific, job-related behaviours (for example "gives direct feedback") or drop it.
- **Names and personal details in /org/.** Shared files hold ATS ids and aggregates. Scorecards live in the ATS or HR system.
