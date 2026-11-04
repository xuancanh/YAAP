---json
{ "title": "Recall system method", "summary": "How to track recall due dates set by the practitioner, run a three-step outreach ladder, re-engage lapsed patients and measure whether recalls work.", "tags": ["recalls", "outreach", "templates", "tracking"], "updated": "2026-11-04" }
---

# Recall system method

A recall system is a list of due dates plus a ladder of messages. Admin runs it; the practitioner decides who is due and when. Admin never sets or changes a clinical interval.

## The recall register

One row per patient per recall type, by reference code:

| Ref | Recall type | Interval (set by practitioner) | Last visit | Due date | Step | Status |
|---|---|---|---|---|---|---|
| P0142 | Routine review | per practitioner | 2026-05-10 | 2027-05-10 | 0 | not yet due |
| P0219 | Routine review | per practitioner | 2025-10-02 | 2026-10-02 | 2 | no reply |

The recall type label must stay generic ("routine review", "annual check"), never naming a condition.

## The outreach ladder

Start a few weeks before the due date so there's time to book.

1. **Step 1, before due:** a friendly message with a booking link or number.
2. **Step 2, two to three weeks later:** a short follow-up by a different channel if the patient agreed to it (text after email, say).
3. **Step 3, after the due date:** a phone call or final letter.
4. Then mark as **lapsed** and move to the lapsed list. Don't keep messaging indefinitely.

**Step 1 template**

> Hi [first name], it's time to book your routine review at [Practice]. You can book at [link] or call [number]. If you've moved or no longer need this, just reply and we'll update our records.

**Step 3 template (call script)**

> "Hi, this is [name] from [Practice]. We're calling because your routine review is now due and we haven't been able to reach you. Would you like to book a time? … No problem, would you like us to stop reminders?"

Keep the reason generic. The opt-out line matters: it cleans the list and respects patients' wishes.

## Lapsed-patient re-engagement

Once or twice a year, send one gentle message to lapsed patients: the practice is still here, how to book, how to opt out. After that, archive them per the practice's records policy. Patients who say they've moved on get marked so they're never contacted again.

## Monthly run

1. Pull everyone due in the next six to eight weeks.
2. Send step 1 to the new ones; move earlier ones up the ladder.
3. Record replies and bookings the same day.
4. Report to the practitioner: number due, booked, no reply, lapsed, opted out.

## Measuring it

Track the share of due patients who booked within a set window of their due date, month by month. If it drops, look at which step stopped working: message wording, channel, or timing. Change one thing at a time.

## Worked example

March run: 40 patients due in April–May. Step 1 to all 40. By the end of March, 22 booked, 3 opted out, 15 no reply. April run moves 15 to step 2; 8 more book. May: step 3 calls to 7; 3 book, 4 become lapsed. Report: 33 of 40 booked, 3 opted out, 4 lapsed. (Illustrative numbers.)

## Common mistakes

- Recall dates set by admin "because it's usually a year".
- Condition names in the recall type.
- Messaging people who asked to stop.
- No lapsed status, so the same people get chased forever.
