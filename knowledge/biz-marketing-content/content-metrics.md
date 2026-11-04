---json
{ "title": "Content metrics and newsletter rules", "summary": "Definitions and formulas for content-assisted conversions and pipeline, engagement and newsletter rates, plus the email sender rules a newsletter must follow.", "tags": ["metrics", "measurement", "newsletter", "email", "kpis"], "updated": "2026-11-04",
  "sources": [
    { "title": "Google Analytics Help: Engagement rate and bounce rate (accessed 2026-11-04)", "url": "https://support.google.com/analytics/answer/12195621" },
    { "title": "Google Workspace Admin Help: Email sender guidelines (accessed 2026-11-04)", "url": "https://support.google.com/a/answer/81126" },
    { "title": "FTC: CAN-SPAM Act compliance guide for business (accessed 2026-11-04)", "url": "https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business" }
  ] }
---

# Content metrics and newsletter rules

Use these definitions in every brief target and every performance review, so numbers mean the same thing month to month. Always state the source, the date range and whether a number is self-reported.

## Your KPIs

### Content-assisted conversions

A conversion (sign-up, demo request, download) where the person viewed at least one content piece before converting, within a lookback window.

```
Assisted conversions (piece) = conversions where the converting person
                               viewed the piece within the lookback window
Assist rate = assisted conversions / total conversions in the period
```

- Agree the lookback window (for example 30 or 90 days) with RevOps and keep it fixed.
- One conversion can be assisted by several pieces. Assisted counts don't add up to total conversions, so never sum them across pieces as if they did.
- **Last-touch conversions** (the piece was the last page before converting) are a separate, stricter number. Report both.

### Content-assisted pipeline

```
Assisted pipeline (piece) = sum of opportunity value for opportunities whose
                            contacts viewed the piece before the opportunity was created
```

Comes from the CRM joined to web analytics. If the join isn't available, say so and report conversions only; don't estimate.

### Engagement

Analytics tools define this differently, so name the tool. In Google Analytics 4:

- **Engaged session:** lasts longer than 10 seconds, or has a key event, or has two or more page or screen views.
- **Engagement rate** = engaged sessions / sessions.
- **Bounce rate** = 1 − engagement rate (sessions that weren't engaged).

Also useful per piece: scroll depth to the CTA (if tracked), CTA click rate (CTA clicks / sessions on the page), and returning readers.

### Newsletter rates

```
Delivered            = sent − bounced
Open rate            = unique opens / delivered
Click rate (CTR)     = unique clickers / delivered
Click-to-open (CTOR) = unique clickers / unique opens
Unsubscribe rate     = unsubscribes / delivered
Spam complaint rate  = complaints / delivered
```

- **Opens are unreliable.** Some mail clients' privacy features load images automatically, which registers opens that didn't happen. Treat open rate as a trend, and judge issues mainly by clicks and conversions.
- Compare issues on the same denominator (delivered, not sent).

## Outcome per hour

The performance review ranks pieces by outcome per hour invested:

```
Outcome per hour = (assisted conversions or the brief's target metric) / hours spent
```

Hours include brief, draft, review rounds and repurposing. Rough is fine; consistent matters more.

## Reading the numbers

- Give pieces time. Search pieces often take months to reach their level; judge them on a trend, not week one.
- Look at the target in the brief first. A piece built to enable sales isn't failing because it has little traffic.
- Separate distribution from quality. High engagement with low traffic means promote it; high traffic with low engagement means the headline or intent is off.

## Newsletter sender rules (time-sensitive)

These are external rules as of the access date; mailbox providers and regulators update them. The person or tool that actually sends must comply, and you should draft issues that make it easy.

**Gmail sender requirements** (similar rules exist at other large providers):

- All senders: SPF or DKIM authentication, valid forward and reverse DNS, TLS, and a spam rate in Postmaster Tools kept below 0.3%.
- Bulk senders (more than 5,000 messages a day to Gmail): SPF, DKIM and DMARC, From domain aligned, one-click unsubscribe for marketing messages plus a visible unsubscribe link in the body. Google advises staying below 0.1% spam rate.

**US CAN-SPAM Act** (other countries have their own, often stricter, consent laws such as opt-in requirements; check with Legal):

- Accurate From and Reply-To headers, and a subject line that matches the content.
- Identify the message as an ad where it is one.
- Include a valid postal address.
- A clear opt-out that works for at least 30 days after sending, honoured within 10 business days.

**Your part in every issue:** honest subject line and preview text, the unsubscribe line and the disclosure line in the draft, one primary CTA, and no claim the source doesn't support. Log results after sending in `/org/marketing/newsletter/log.md` with the date range and source.
