---json
{ "title": "Model design conventions", "summary": "Layering, naming, grain, keys, history handling and documentation rules that keep data models predictable and safe to join.", "tags": ["data modelling", "grain", "naming", "dimensional modelling"], "updated": "2026-11-04" }
---

# Model design conventions

Consistent models let analysts guess correctly. Follow the company's existing conventions in `/org/data/` if they exist; use these where none are written down, and propose adding them.

## Layers

| Layer | Purpose | Rules |
|---|---|---|
| **Staging** | One model per source table: rename, cast types, light cleaning | No joins, no business logic. One-to-one with the source. |
| **Intermediate** | Reusable building blocks: joins, de-duplication, sessionisation | Not exposed to dashboards. Named for what they do. |
| **Marts** | Tables people query: facts and dimensions for a domain | Documented grain, tested keys, owner named. |

Dashboards and analyses read from marts only. If someone needs a staging table, the mart is missing something.

## Naming

- Prefix by layer: `stg_<source>__<table>`, `int_<what it does>`, `fct_<event or process>`, `dim_<entity>`.
- Plural or singular, pick one and keep it.
- Columns: `snake_case`; IDs end in `_id`; booleans start with `is_` or `has_`; timestamps end in `_at` and are in UTC; dates end in `_date`; money columns state the unit (`amount_cents`, `amount_usd`).
- Never reuse a name with a different meaning. If "active customer" has a catalogued definition in `/org/data/metrics.md`, use it or name your column differently.

## Grain

Write the grain as a sentence at the top of the model's docs: "One row per order line", "One row per customer per day".

Before you join, check both sides' grain:

- One-to-one: safe.
- One-to-many: the result has the many side's grain. Sums from the "one" side will now be multiplied. This is the most common cause of inflated revenue.
- Many-to-many: almost always a mistake in a mart. Aggregate one side first.

Test the grain with a uniqueness test on the column or columns that define it.

## Keys

- Every mart has a primary key, tested unique and not null.
- Prefer a stable natural key from the source. If it is composite, also build a single surrogate key (for example, a hash of the parts) for easy joining.
- Foreign keys are tested with a relationship test against their dimension.

## Facts and dimensions

- **Facts** record events or measurements (orders, payments, sessions). They hold numeric measures and keys to dimensions.
- **Dimensions** describe entities (customer, product, plan). They hold attributes people filter and group by.
- Decide whether each measure is additive (can be summed across all dimensions, like amount), semi-additive (balances: sum across customers, not across days), or non-additive (ratios: recompute, never sum). Write it in the column description.

## History

When an attribute changes (a customer's plan), decide what the business needs:

- **Overwrite** (current value only): simplest; past reports change.
- **Snapshot** (a row per entity per day or month): easy to query "as of".
- **Slowly changing dimension type 2** (a row per version with `valid_from` / `valid_to`): precise history; joins need a date condition.

Write the choice in the docs. Finance and revenue models usually need history.

## Documentation, per mart

- Grain sentence and primary key.
- Owner and the decision or dashboard it serves.
- Description for every column, including units and whether personal data.
- Upstream sources (lineage) and refresh schedule.
- Known caveats: late-arriving data, excluded records, test accounts filtered or not.

## Change safety

- Adding a column is safe. Renaming or removing one breaks queries downstream: check lineage, tell the users, and keep the old column for a deprecation period if the company's process allows.
- Changing a definition changes history. Announce it in the change note with before/after numbers for a recent period.
