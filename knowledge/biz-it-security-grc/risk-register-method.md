---json
{ "title": "Risk register method", "summary": "How to write a risk clearly, score it, choose a treatment, and keep the register reviewed and linked to controls.", "tags": ["risk register", "risk assessment", "risk treatment", "grc"], "updated": "2026-11-04" }
---

# Risk register method

The risk register is where the company writes down what could go wrong with its information security, how bad it would be, and what it has decided to do. Frameworks like ISO 27001 require a risk assessment and treatment process; SOC 2 auditors look for one too. More importantly, it is how leadership makes informed trade-offs.

## Writing a risk

Use a cause, event, consequence sentence:

> Because <cause>, <event> could happen, leading to <consequence>.

- Weak: "Phishing."
- Strong: "Because staff use passwords with push-approval MFA, an attacker could phish credentials and approve a prompt, leading to access to customer data in the support tool."

The strong version points at controls (stronger MFA) and at what is at stake (customer data).

## Register fields

| Field | Notes |
|---|---|
| ID, title | Short and stable |
| Risk statement | Cause, event, consequence |
| Asset / process | What is affected |
| Owner | A role with authority to treat it |
| Inherent likelihood and impact | Before current controls |
| Current controls | Links to the controls matrix |
| Residual likelihood and impact | With current controls |
| Treatment | Mitigate / accept / transfer / avoid |
| Treatment plan | Actions, owners, dates |
| Target residual | Where it should be after treatment |
| Review date, last reviewed | |

## Scoring

Use a simple scale the company agrees, for example 1–5 for likelihood and impact, with written descriptions for each level so scores are consistent:

- **Likelihood**: how plausible in the next year, given threats seen and exposure.
- **Impact**: worst realistic consequence across customers, money, legal, operations and reputation. Use the highest one.

```
risk score = likelihood × impact
```

Define bands (for example low, medium, high, critical) and what each requires: who can accept it, how fast it must be treated, how often it is reviewed. The Head of IT & Security and leadership set the company's appetite: the level of residual risk they will accept without more action.

Scores are judgement. Write one sentence on why for each, so a reviewer can challenge it.

## Treatment options

- **Mitigate:** add or improve controls to reduce likelihood or impact. The most common choice.
- **Accept:** live with it, by an owner with the authority for that band, recorded with a review date.
- **Transfer:** shift part of the impact, for example through insurance or a contract. The responsibility to customers usually remains.
- **Avoid:** stop the activity that creates the risk.

Every treatment plan becomes tasks with owners and dates.

## Sources of risks

- Vendor reviews with open findings ([vendor security review](vendor-security-review.md)).
- Controls with failed tests or gaps ([evidence and control testing](evidence-and-control-testing.md)).
- Incidents and near misses.
- Threat briefs from the Security Analyst.
- New products, systems, data types or markets.
- Audit findings.

## Review cadence

- Each risk on its own review date, set by its band.
- The whole register reviewed with the Head of IT & Security on the company's cadence, with changes since last time: new risks, closed treatments, rising scores.
- Accepted risks re-confirmed by their owner at expiry; acceptance does not roll over silently.

## Presenting the register

Leadership needs the short version:

```markdown
## Top risks (residual high and critical)
| Risk | Residual | Trend | Treatment | Due | Owner |
## Changes since last review
## Decisions needed
<Accept X? Fund Y?>
```

## Pitfalls

- Generic risks copied from a template. Each one should name this company's systems and data.
- Only inherent scores. Residual is what drives decisions.
- Treatments without dates or owners.
- Scoring to make a risk fit an appetite. Score honestly, then decide.
