---json
{ "title": "Launch tiers", "summary": "How to tier a launch by customer impact and what each tier requires, with a timeline and go/no-go checklist.", "tags": ["launch", "go-to-market", "tiers", "checklist"], "updated": "2026-11-04" }
---

# Launch tiers

Not every release deserves a campaign. Tiering matches effort to impact, so big launches get full support and small ones don't swamp the calendar. Agree the tier with product when they commit a date.

## Deciding the tier

Score the release on these questions with the product owner:

| Question | Low | High |
|---|---|---|
| How many customers or prospects does it affect? | A few | Most, or a new segment |
| Does it change how we position or sell? | No | Yes, new value or differentiator |
| Does it change pricing, packaging or contracts? | No | Yes |
| Is it competitively significant? | No | Closes a gap or opens a lead |
| Does it need customer behaviour change? | No | Yes, migration or new workflow |

Mostly high: Tier 1. Mixed: Tier 2. Mostly low: Tier 3. When unsure, go one tier lower and promote later if the evidence supports it. Over-launching small features teaches the market to ignore announcements.

## What each tier gets

| | Tier 1 (major) | Tier 2 (notable) | Tier 3 (minor) |
|---|---|---|---|
| Positioning check | Full refresh or new | Check pillars still fit | No |
| Launch plan | Full plan | Short plan | Changelog entry only |
| Enablement | Full kit + live session | Short kit or update | Release note for support |
| Content | Announcement, landing page, guide, case study if available | Blog post or announcement | Changelog |
| Channels | Email, social, ads, events, PR proposal | Email to relevant users, social | In-app or changelog |
| Customer comms | All relevant customers | Affected segment | Release notes |
| Measurement | Adoption dashboard, pipeline impact | Adoption check | Optional |

## Timeline for Tier 1 (adjust to the date product commits)

- **T-6 to T-4 weeks:** confirm scope and date with product; positioning check; launch plan approved; asset requests to design and content.
- **T-3 weeks:** enablement kit draft; demo environment ready; FAQ drafted with support.
- **T-2 weeks:** enablement session with sales and support; assets in review; customer comms drafted.
- **T-1 week:** go/no-go; final copy approved; scheduled sends set up by whoever holds the sending grant.
- **Launch day:** announcement out; monitor support and sales questions; fix FAQ gaps.
- **T+2 and T+6 weeks:** adoption check against the target; lessons in the launch file.

## Launch plan template

```markdown
# Launch: <name> — Tier <n> — <date>

## Goal
<adoption target, pipeline target, or competitive outcome; metric and source>

## Audiences
- Existing customers: <segment> — what changes for them
- Prospects: <segment>
- Internal: sales, support, success

## Message
- One-line: <outcome for the customer>
- Pillar it supports: <from positioning>
- Proof: <beta quote, metric>

## Assets and owners
| Asset | Owner | Due | Status |

## Enablement
<kit link, session date>

## Risks
- Date slips → <plan>
- Feature limitations → <what we say>

## Go/no-go criteria
```

## Go/no-go checklist

- [ ] Feature is shipped or flagged on for the launch audience, and works in production.
- [ ] Claims in every asset match what shipped (scope, limits, plans it's in).
- [ ] Pricing and packaging confirmed by their owner.
- [ ] Docs and help articles live or ready.
- [ ] Support has the FAQ and known issues.
- [ ] Sales has the kit and has seen the demo.
- [ ] Adoption tracking event exists and has been tested.
- [ ] Approvals for outward content recorded.

If the feature slips, don't launch the message. Move the date, and tell sales so they stop pre-selling.

## Measuring a launch

Set the target before launch, using the definitions in [win/loss and metrics](win-loss-and-metrics.md). For Tier 1 and 2, report adoption at two and six weeks and note what you'd change next time.
