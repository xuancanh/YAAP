---json
{ "title": "Schedule design", "summary": "How to build an appointment-book template with appointment types, buffers, protected slots and a waitlist, plus a no-show policy checklist and a worked day.", "tags": ["scheduling", "templates", "waitlist", "no-shows"], "updated": "2026-11-04" }
---

# Schedule design

A schedule that runs late every afternoon is a design problem, not a discipline problem. Build the template from appointment types and the practitioner's real durations, then protect it.

## Step 1: the appointment-type table

List every type with its real duration, measured over a few weeks rather than taken from the booking system's defaults.

| Code | Type | Booked length | Notes |
|---|---|---|---|
| NP | New patient | 60 | intake must be complete before booking is confirmed |
| FU | Follow-up | 30 | |
| RV | Review / recall | 20 | |
| AD | Admin / reports | 30 | practitioner time, no patient |

The practitioner sets which clinical types exist and how long they need. Admin's job is to measure and report back when booked and actual lengths differ.

## Step 2: the day template

- **Anchor long appointments** at the start of a session, when the practitioner is fresh and there's no backlog.
- **Buffers:** a short gap after every two or three appointments absorbs overruns. Put one before lunch and one before the end of the day.
- **Protected slots:** a few same-week slots held back until a set time (say, 48 hours before) for urgent bookings the practitioner has approved, then released to the waitlist.
- **Admin block:** notes, letters and calls need time on the calendar or they happen after hours.
- **Lunch is a slot.** Book it, or it disappears.

## Worked day (example only)

| Time | Slot |
|---|---|
| 09:00 | NP |
| 10:00 | FU |
| 10:30 | FU |
| 11:00 | buffer |
| 11:15 | RV |
| 11:35 | RV |
| 12:00 | Protected (release 48h before) |
| 12:30 | Lunch |
| 13:30 | FU, FU, RV |
| 14:50 | buffer |
| 15:00 | AD |

## Waitlist mechanics

- Record for each person: reference code, appointment type, earliest/latest dates, times they can do, contact channel, date added.
- When a slot opens, offer it to the longest-waiting person whose type and times fit. Offer to one person at a time with a clear reply-by time, so two people don't both accept.
- Clean the list monthly: remove people who've booked elsewhere or stopped replying.

## No-show and late-cancellation policy

The practice owner decides the policy and any fee; check local rules and contracts with insurers or public health schemes, which may restrict charging. A clear policy covers:

- the notice period that counts as a late cancellation;
- what happens after a no-show (a reminder of the policy first time; a fee or a deposit requirement after repeats);
- exceptions (emergencies, illness) and who decides them;
- where the policy is shown: intake forms, confirmation messages, the website.

Reminders reduce no-shows. Send one a few days ahead with an easy way to confirm or cancel, and one the day before. Measure your own no-show rate before and after any change rather than relying on quoted industry figures.

## Monthly review

- Average overrun by appointment type: is the booked length wrong?
- Days that ran late: which slot started the slide?
- Protected slots: used, released, or wasted?
- Waitlist length and average wait

## Common mistakes

- Back-to-back booking with no buffers, then a whole afternoon late.
- Defaults from the booking software that nobody checked.
- Double-offering a slot to the waitlist.
- Changing the template without telling the practitioner.
