---json
{ "title": "Collections ladder and message templates", "summary": "Message templates for each step of the dunning ladder, how to handle disputes and promises to pay, and how to propose a payment plan.", "tags": ["collections", "dunning", "templates", "accounts-receivable"], "updated": "2026-11-04" }
---

# Collections ladder and message templates

Most late payments are process problems on the customer's side: the invoice went to the wrong person, a PO was missing, an approver was away. Early messages should make paying easy. Pressure comes later, and only with a human's decision.

The step days come from `/org/finance/dunning-policy.md`. The templates below fit any day schedule.

## Before you send anything

- [ ] Is there an open dispute or query? If yes, don't send a reminder. Work the dispute.
- [ ] Is a payment in transit? Check receipts and unapplied cash first.
- [ ] Is the account owner (sales, customer success) aware of anything sensitive, such as a renewal under negotiation or an open support escalation?
- [ ] Is the contact right? A bounce or no reply after two messages usually means wrong person.

## Step 1: friendly reminder (just overdue)

> Subject: Invoice {number} — {amount} was due {date}
>
> Hi {name},
>
> A quick note that invoice {number} for {amount} was due on {date}. In case it hasn't reached you, it's attached, and you can pay here: {payment link or details}.
>
> If it's already on its way, thanks, and please ignore this. If anything on it looks wrong, reply and I'll sort it out.

## Step 2: second notice

> Subject: Second reminder — invoice {number}, {days} days overdue
>
> Hi {name},
>
> Invoice {number} for {amount} is now {days} days past its due date of {date}. Could you let me know when we can expect payment, or whether something is holding it up (a PO number, a different billing contact)?
>
> Invoice and payment details: {link}.

Ask a question. A reply with a date or a blocker is worth more than silence.

## Step 3: call request and account-owner heads-up

Tell the account owner before this message goes out.

> Subject: Invoice {number} — can we find 10 minutes?
>
> Hi {name},
>
> We haven't been able to resolve invoice {number} ({amount}, due {date}). I'd like to understand what's needed on your side. Could you suggest a time for a short call this week, or point me to the right person in your accounts payable team?

## Step 4: manager escalation

Sent by or on behalf of the Head of Finance, or the account owner's manager. Firm, factual, no threats.

> Hi {name},
>
> Invoice {number} for {amount} is {days} days overdue, and we've had no response to our earlier messages on {dates}. Please arrange payment by {date} or contact me directly so we can agree a way forward.

## Step 5: service or legal options

Never automatic. Pausing service, charging late fees or interest, or passing a debt to a collector are human decisions, need a contract basis, and are subject to local law. Prepare the facts (invoice history, messages sent, contract clause) and hand them to the Head of Finance.

## Handling replies

| Reply | What you do |
|---|---|
| "It's in the next payment run on {date}" | Log the promise to pay with date; pause reminders until a day after it; check on that date |
| "We need a PO number / different entity" | Reissue correctly (credit and rebill if needed); restart the clock only if policy says so |
| "The invoice is wrong" | Stop reminders; open a dispute; see [credit notes and write-offs](credits-and-write-offs.md) |
| "We can't pay all of it now" | Propose a payment plan for approval (below) |
| No reply | Next step on schedule; after two silent steps, find a different contact |

## Proposing a payment plan

Write it as a request to the Head of Finance:

- total owed, invoices covered, oldest due date;
- proposed instalments: amount and date each;
- whether new invoices must be paid on time during the plan;
- what happens if an instalment is missed;
- the account owner's view of the relationship.

Only send terms to the customer once approved.

## Tone rules

- Factual and specific: number, amount, date, link. No adjectives about the customer.
- Assume good faith in steps 1–3.
- Never discuss a customer's debt in shared channels or with anyone outside the account team and finance.
- One message per step. Don't increase frequency to signal urgency.
