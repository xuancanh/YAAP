---json
{ "title": "Obligations extraction", "summary": "A checklist of obligations to pull from every signed contract, how to calculate notice deadlines with a worked example, register fields and the executed-version check.", "tags": ["obligations", "renewals", "notice-periods", "register", "checklist"], "updated": "2026-11-04" }
---

# Obligations extraction

A contract's risk after signature is mostly forgotten dates: a renewal that rolled over, a report nobody sent, a price rise nobody noticed. Extract every obligation into the register within days of signature, while the deal is fresh.

## First: is this the version we agreed?

Before extracting, compare the executed copy with the last approved draft. Signature pages attached to an older version, or a late change on the other side, happen. Any difference goes to the General Counsel before the register is updated.

## Extraction checklist

Read the whole contract, including order forms, schedules and incorporated policies.

**Dates and term**
- [ ] Effective date and end date
- [ ] Renewal: automatic or manual; renewal length
- [ ] Notice to stop renewal: period, form (written, email allowed?), address for notices
- [ ] Termination for convenience: who, notice period
- [ ] Minimum term or lock-in

**Money**
- [ ] Price, billing frequency, payment terms
- [ ] Price changes: scheduled uplifts, index-linked increases, renewal price rules
- [ ] Minimum commitments or volume tiers, and the period over which they're measured
- [ ] Service credits we may claim, and the claim deadline

**Performance and reporting**
- [ ] Service levels we owe or are owed
- [ ] Reports, audits, certifications we must provide, and when
- [ ] Our audit rights over them

**Restrictions**
- [ ] Exclusivity, non-compete or non-solicitation terms, and their scope and duration
- [ ] Restrictions on publicity or use of the other's name
- [ ] Assignment and change-of-control conditions

**Data and security**
- [ ] Data processing commitments, breach notice times, sub-processor notice rights
- [ ] Deletion or return at end of contract

**Other**
- [ ] Insurance we must hold, and evidence we must provide
- [ ] Survival clauses (what continues after the end)

## Calculating the notice deadline

The date that matters is the **last day to give notice**, not the renewal date.

> **Last notice day** = renewal date − notice period (counting as the contract says)

**Worked example.** Term ends 31 March. Auto-renews for 12 months unless either party gives at least 60 days' written notice before the end of the term.
- Counting back 60 days from 31 March lands on 30 January in a non-leap year (31 January in a leap year). Because counting conventions vary, treat the notice as due a few days before that.
- Task for the owner: decide renew or not by **mid-January**, with a reminder 30–60 days earlier still (per your playbook) so there's time to negotiate.
- Note how notice must be given (e.g. written notice to the address in the notices clause). Email may not count.

Counting rules ("days" vs "business days", whether the day of notice counts) depend on the contract and the governing law. When it's tight, flag it and leave a margin rather than relying on the last possible day.

## Register fields

| Field | Example |
|---|---|
| Contract ref | Folder link and version |
| Counterparty | Legal entity |
| Type | Customer / vendor / partner |
| Obligation | "Give non-renewal notice" |
| Who owes it | Us / them |
| Date that matters | Last notice day, report due date |
| Recurrence | Once, annual, monthly |
| Owner function | Procurement, Finance, CS, IT |
| Task | Link to the backlog task |
| Source clause | Section number |
| Status | Open / done / waived (with approval) |

One row per obligation, not per contract. A contract with a renewal, a price uplift and an annual security report has three rows.

## After entry

- Create tasks for each date ahead of time (lead time per your playbook), assigned to the owning function.
- Tell the owner in one line what they now own and why.
- For customer contracts, tell the account owner about commitments we made (service levels, reports, restrictions).

## Pitfalls

- Recording the renewal date instead of the last notice day.
- Missing obligations hidden in order forms or online terms.
- Extracting only what we're owed and missing what we owe.
- Not updating the register when an amendment is signed.
