---json
{ "title": "Security metrics and formulas", "summary": "Formulas and definition choices for the IT and security KPIs: patch compliance, MTTD, MTTR by severity, MFA coverage, access review completion, ticket SLA, phishing and control pass rates.", "tags": ["security", "metrics", "kpis", "reporting"], "updated": "2026-11-04" }
---

# Security metrics and formulas

Your report carries a fixed KPI table and the monthly audit re-checks how
each number was computed. This doc gives each formula and the choice that
most often makes it drift. Write the choices into
`/org/it-security/kpis.md` with a date, and change them only with a note.

## The formulas

```text
patch compliance %         = assets patched within SLA ÷ assets in scope × 100
MTTR (by severity), days   = median of (remediated_at − detected_at) for findings closed in the period
MTTD, hours                = median of (detected_at − first_malicious_or_faulty_event_at) per incident
mean time to contain       = median of (contained_at − detected_at) per incident
MFA coverage %             = active accounts with MFA enforced ÷ active accounts in scope × 100
access review completion % = in-scope systems reviewed by the due date ÷ in-scope systems × 100
leaver removal on time %   = leavers whose access was fully removed within target ÷ leavers × 100
ticket SLA adherence %     = tickets resolved within SLA ÷ tickets resolved × 100
phishing-test failure %    = recipients who clicked or entered credentials ÷ recipients × 100
control test pass rate %   = controls tested that passed ÷ controls tested × 100
SLA backlog                = open findings past SLA, by severity (a count, not a rate)
```

Medians are used for times because one long-running case distorts a mean.
The KPIs are named "mean time to …" by habit; say which you report.

## Definition choices

| KPI | Choice to write down |
|---|---|
| Patch compliance | All assets, or only managed ones? Servers and laptops together or separately? What counts as "patched": OS only, or apps too? |
| MTTR | Clock starts at detection or at triage? Closed on deploy or on verified rescan? Are accepted risks excluded? |
| MTTD | Where does "first event" come from? Often only known after investigation; mark estimates. |
| MFA coverage | Which systems? SMS counts as MFA, or only app/key? Service accounts in or out? |
| Access review | Is a system "reviewed" when the owner decides, or when removals are done? |
| Phishing | Clicks only, or credential entry? Do reports to IT offset failures? |
| Control pass rate | Is a control with an exception a fail? |

Pick the stricter reading when in doubt and say so: a number that looks
worse but is honest beats one that collapses at the first external audit.

## Pair every rate with its coverage

A rate over a subset can look healthy while the whole is not. Report:

```text
MDM coverage % = devices enrolled in MDM ÷ devices known (from finance or People records) × 100
scan coverage % = assets scanned in the period ÷ assets in the inventory × 100
```

Patch compliance of 98% on 60% coverage is a coverage problem first.

## Worked example (made-up figures)

Fleet of 50 laptops and 10 servers; 45 laptops and all servers in MDM.
Patched within SLA: 42 laptops, 9 servers. Patch compliance over managed
assets = 51 ÷ 55 × 100 = 92.7%; over all known assets = 51 ÷ 60 × 100 = 85%.
MDM coverage = 55 ÷ 60 = 91.7%. Report the definition used, and the
coverage beside it.

Critical findings closed this month took 3, 4, 6 and 12 days; MTTR
(median) = 5 days. With a 7-day SLA, one of four was late: name it in the
report even though the median is inside the SLA.

## Reading the trends

- **Phishing failure falling** can mean training worked, or that tests got
  easier. Keep difficulty comparable, and track the report rate too.
- **MTTR rising** while the backlog shrinks often means old findings are
  finally being closed: good news that looks bad. Show both.
- **100% control pass rate** month after month: check the sample and the
  tests are hard enough.

## Common pitfalls

- **Averages hiding the worst case.** One critical past SLA matters more
  than a good median; the RAG rule treats it separately.
- **Self-reported numbers.** Without a metric source (MDM, scanner,
  identity provider), the key result is self-reported until
  `org_propose_metric_source` is approved; say so.
- **Changing the denominator quietly.** A new device class or a new system
  in scope breaks the trend. Note the date it changed.
- **Counting activity.** "Tickets closed" or "scans run" measure effort, not
  risk. Report outcomes.
