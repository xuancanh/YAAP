---json
{ "title": "Source ingestion checklist", "summary": "A checklist for bringing a new data source in safely: access, schema, personal data, load strategy and first checks.", "tags": ["ingestion", "sources", "privacy", "checklist"], "updated": "2026-11-04" }
---

# Source ingestion checklist

A new source is a long-term commitment: every model built on it inherits its quirks. Spend the time up front.

## 1. Purpose and owner

- [ ] Which decision or question needs this source? Link the request.
- [ ] Who owns the source system, and who can answer questions about its data?
- [ ] What is the minimum set of tables and fields needed? Ingest that, not everything.

## 2. Access

- [ ] Access method: native connector, API, database replica, file drop.
- [ ] Read-only credentials scoped to the needed objects, stored in the company's secret store. Never in code or notes.
- [ ] The connection is approved. New external connections are proposals to your manager until granted.
- [ ] API limits and quotas understood, so the load does not disrupt the source.

## 3. Schema and semantics

For each table:

- [ ] Primary key, and whether it is truly unique (check, don't assume).
- [ ] How updates and deletes are represented: updated-at column, change log, soft-delete flag, or nothing.
- [ ] Time zones of every timestamp.
- [ ] Enumerations and what each value means; who adds new values.
- [ ] Known test, internal or demo records, and how to identify them.
- [ ] Currencies and units for any amount.

Write these into the staging model's docs.

## 4. Personal and sensitive data

Privacy rules vary by jurisdiction and change over time; follow the company's privacy policy and ask Legal or the GRC Specialist when unsure.

- [ ] Classify each field: personal data (name, email, IP, device ID), sensitive categories, financial, none.
- [ ] Do not ingest fields nobody needs. That is the cheapest protection.
- [ ] Mask, hash or drop personal fields in staging when downstream only needs counts or joins.
- [ ] Restrict access to tables that keep personal data.
- [ ] Record retention needs and how deletion requests will propagate.

## 5. Load strategy

| Strategy | When | Watch out for |
|---|---|---|
| Full refresh | Small tables, or no reliable change marker | Cost and time as the table grows |
| Incremental by updated-at | Reliable last-modified timestamp | Late or back-dated updates; use a look-back window |
| Incremental by change log (CDC) | Database with a change stream | Deletes, schema changes |
| Append-only events | Event streams | Duplicates; de-duplicate on event ID |

Rules:

- [ ] **Idempotent:** re-running a load for the same period gives the same result (use merge/upsert on the key, not blind inserts).
- [ ] **Backfillable:** you can reload any past period on demand.
- [ ] **Raw kept:** land the raw data unchanged before transforming, so you can rebuild after a logic bug.

## 6. First checks after the first load

- [ ] Row counts match the source (or a source report) for a sample period.
- [ ] Key uniqueness and not-null tests pass.
- [ ] A few records spot-checked against the source UI by ID.
- [ ] Freshness check added with a threshold that matches the business need.
- [ ] Totals for one known number (last month's order count, say) match what the owning team reports. If they don't, find out why before anyone uses the data.

## 7. Hand-off

- [ ] Staging docs written (see [model design conventions](model-design-conventions.md)).
- [ ] Tests and freshness configured (see [data tests and freshness](data-tests-and-freshness.md)).
- [ ] Source owner told what you ingest and asked to warn you about schema changes.
- [ ] Catalogue updated with the new source and its caveats.
