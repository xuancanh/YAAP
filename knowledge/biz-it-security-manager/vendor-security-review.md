---json
{ "title": "Vendor security review", "summary": "A tiered checklist for reviewing a new tool or supplier before it holds company or customer data, and what to record when you approve one.", "tags": ["security", "vendors", "third-party-risk", "procurement"], "updated": "2026-11-04" }
---

# Vendor security review

Every SaaS tool someone signs up for is a place company data now lives and
an account to manage. A vendor review checks the supplier is fit to hold
what it will hold, and makes sure the company can get out again. Scale the
effort to the risk: a diagramming tool for internal sketches doesn't need
the review a payroll provider does.

## Tier it first

| Tier | What the vendor will hold or touch | Review depth |
|---|---|---|
| High | Customer or personal data, credentials, money, production systems, source code | Full checklist, evidence documents, DPA, sign-off by a human |
| Medium | Internal confidential data (plans, financials, contracts) | Core checklist, report or questionnaire |
| Low | Nothing sensitive; no integration with core systems | SSO/MFA check, owner named, listed in systems.md |

The company sets the tiers and who signs off; record them in
`/org/it-security/kpis.md` or a process file under `/org/it-security/`.

## Checklist

**Data**
- [ ] What data, how much, whose (customers? staff?), and where it is
      stored and processed (regions).
- [ ] Encrypted in transit and at rest.
- [ ] Retention and deletion: can we delete our data, and get it back out
      in a usable format?
- [ ] Sub-processors listed, and how we'd hear of changes.

**Access**
- [ ] SSO supported (and on which plan); MFA enforceable for all users.
- [ ] Roles granular enough for least privilege; admin separable.
- [ ] Audit logs of user and admin actions, exportable.
- [ ] API tokens scoped and revocable.

**Assurance**
- [ ] Independent report: SOC 2 Type II or ISO/IEC 27001 certificate, with
      its scope and date. Check the scope covers the product you're buying
      and read the exceptions and the complementary user entity controls
      (what you are expected to do).
- [ ] Recent penetration test summary, if offered.
- [ ] Vulnerability disclosure or security contact.

**Resilience and incidents**
- [ ] Breach notification commitment (how fast, to whom) in the contract.
- [ ] Uptime commitment and status page, if the tool is critical.
- [ ] Backups and recovery for our data.

**Contract** (Legal leads; you supply the security asks)
- [ ] Data processing agreement where personal data is involved.
- [ ] Security obligations and right to terminate on breach.

## Recording the outcome

Add the vendor to `/org/it-security/systems.md` and file the review under
`/org/it-security/vendors/<vendor>.md`:

```markdown
# <Vendor> — <product>
Tier: high | medium | low   Business owner: <name>   Reviewed: <date> by <member>
Data held: <…>   Integrations: <SSO, API to …>
Evidence: <SOC 2 Type II period …, scope …> / <ISO 27001 cert no., expiry>
Gaps and mitigations: <e.g. no SSO on this plan → MFA enforced, quarterly access review>
Decision: approve | approve with conditions | reject   Decided by: <human, date>
Re-review: <date, yearly default for high>
Exit plan: how we export and delete our data
```

Approving a high-tier vendor, or one with an unmitigated gap, is a human
decision: bring it as a recommendation with the gaps stated. Questionnaires
and emails to the vendor are drafts for a human to send unless the company
has granted outward contact.

## Worked example (made-up)

Sales wants a call-recording tool that stores customer calls: high tier.
The vendor has a SOC 2 Type II report, but its scope excludes the
transcription feature, which uses a sub-processor. SSO only on the top
plan. Recommendation: approve with conditions (top plan for SSO;
transcription off until the sub-processor's terms are reviewed by Legal),
re-review in a year.

## Common pitfalls

- **"They're SOC 2" as the whole review.** A report has a scope, a period
  and exceptions; read them.
- **Shadow IT.** Tools adopted without a review. Ask finance for the SaaS
  spend list each quarter and reconcile with systems.md.
- **No exit plan.** Getting data out is part of the review, not an
  afterthought.
- **Reviewing once.** Vendors change sub-processors, plans and owners;
  high-tier ones get a yearly re-review.
