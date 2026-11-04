---json
{ "title": "Jurisdiction checklist", "summary": "The legal questions to research and record for each rental property's location, with England as a worked example from official guidance.", "tags": ["compliance", "deposits", "certificates", "notice-periods", "jurisdiction", "england"], "updated": "2026-11-04",
  "sources": [{ "title": "GOV.UK: Tenancy deposit protection (accessed 2026-11-04)", "url": "https://www.gov.uk/tenancy-deposit-protection" },
              { "title": "GOV.UK: Private renting, your landlord's safety responsibilities (accessed 2026-11-04)", "url": "https://www.gov.uk/private-renting/your-landlords-safety-responsibilities" },
              { "title": "GOV.UK: Guide for landlords, electrical safety standards in the private rented sector", "url": "https://www.gov.uk/government/publications/electrical-safety-standards-in-the-private-rented-sector-guidance-for-landlords-tenants-and-local-authorities/guide-for-landlords-electrical-safety-standards-in-the-private-rented-sector" },
              { "title": "GOV.UK: Guide for landlords, Homes (Fitness for Human Habitation) Act 2018", "url": "https://www.gov.uk/government/publications/homes-fitness-for-human-habitation-act-2018/guide-for-landlords-homes-fitness-for-human-habitation-act-2018" }] }
---

# Jurisdiction checklist

Before the radar can compute any date, the property file needs the rules for its location. Research each item from official sources (government, regulator, court service), record the answer with its source and date, and re-check yearly or when the law changes.

## The questions

**Letting and licensing**
- [ ] Does the landlord or property need a licence or registration (citywide, selective, multi-occupancy)?
- [ ] Any rent control or stabilisation?
- [ ] Required documents to give tenants at the start (guides, certificates, disclosures)?

**Deposits**
- [ ] Maximum deposit allowed?
- [ ] Must it be protected or held in a special account? By when?
- [ ] What information must the tenant get, and by when?
- [ ] Deadline to return it after the tenancy ends, and rules on deductions?

**Safety and condition**
- [ ] Gas, electrical, energy performance, smoke and CO alarm requirements, with frequencies.
- [ ] Habitability or fitness standard, and repair response expectations.
- [ ] Lead paint, mould or other disclosures.

**During the tenancy**
- [ ] Notice required before entering, and for what purposes.
- [ ] How and how often rent can be increased, and the notice or form required.
- [ ] Rules on late fees.

**Ending the tenancy**
- [ ] Grounds and notice periods for each side.
- [ ] Required forms, and the court or tribunal process.
- [ ] Self-help eviction (changing locks, removing belongings) is illegal in many places. Never suggest it.

## Worked example: England (as of November 2026)

From gov.uk guidance, accessed 4 November 2026. Wales, Scotland and Northern Ireland have their own rules.

- **Tenancy type:** gov.uk states that assured periodic tenancies replaced assured shorthold tenancies on 1 May 2026. Notice, rent-increase and possession rules changed with this; check the current gov.uk guidance before drafting any notice.
- **Deposits:** must be placed in a government-approved scheme within 30 days of receipt, and returned within 10 days of agreeing the amount at the end. Deposits paid by a third party must still be protected.
- **Gas:** a Gas Safe registered engineer must check each gas appliance and flue every year, and tenants get a copy of the record before moving in or within 28 days of the check.
- **Electrical:** the 2020 regulations require installations to be inspected and tested by a qualified person at least every five years, with the report given to tenants and to the council on request.
- **Alarms:** a smoke alarm on each storey, and a carbon monoxide alarm in any room with a solid-fuel appliance; check current guidance for gas appliances too.
- **Fitness:** under the Homes (Fitness for Human Habitation) Act 2018, the home must be fit for habitation at the start and throughout the tenancy.

## Recording it

In `property.md`:

```
Jurisdiction: [country / state / city]
Rules checked: [date], next check: [date]
| Duty | Rule | Frequency/deadline | Source (URL, date) | Next due |
```

Every "next due" feeds the radar.

## Other places

- **US:** landlord-tenant law is mostly state and local. Start with the state attorney general's or housing agency's landlord-tenant guide and the city's housing code; federal fair housing rules apply everywhere (see [Fair housing and screening](fair-housing-and-screening.md)).
- **Elsewhere:** the national housing ministry or tenancy tribunal usually publishes landlord guides.

## Common mistakes

- Using another country's or state's rules from a blog.
- Missing a deposit deadline. It's a hard legal date in many places, with penalties.
- Expired gas or electrical certificates. Treat these as stops, not to-dos.
- Not recording where each rule came from, so nobody can tell when it's out of date.
