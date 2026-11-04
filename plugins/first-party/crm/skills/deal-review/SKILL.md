---
name: deal-review
description: Review the pipeline deal by deal: stage, next step, risk and the evidence for each, then update stages and log what changed. Use at the weekly pipeline review and before a forecast.
---

1. Read the summary (crm_pipeline_summary) and the open deals (crm_list_deals), largest first.
2. For each deal check the evidence for its stage: a proposal stage needs a proposal sent, negotiation needs a named decision maker. A deal without a next step in the last two weeks is at risk.
3. Move deals whose evidence changed (crm_move_stage) and log the call or meeting that changed them (crm_log_activity). Never move a deal to won without a signed agreement.
4. Write the forecast line for the weekly report: commit, best case, and the three deals that decide the quarter.
