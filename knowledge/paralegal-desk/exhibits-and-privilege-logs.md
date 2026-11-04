---json
{ "title": "Exhibits and privilege logs", "summary": "Templates and rules for document indexes, exhibit lists, chronologies and privilege logs that hold up under scrutiny.", "tags": ["exhibits", "privilege log", "document index", "chronology", "templates"], "updated": "2026-11-04" }
---

# Exhibits and privilege logs

Good matter files share three habits: one number per document that never changes, a source for every fact, and privilege marked at the moment of filing. **For attorney review.** Format requirements for exhibits and privilege logs come from the court's rules, local rules, any protective order, and the judge's procedures; check them before building the final version.

## Document index

Every document gets a control number on arrival.

```
| Ctrl # | Date | Type | Author → Recipient | Description | Source | Privilege | Location |
|--------|------|------|--------------------|-------------|--------|-----------|----------|
| C-0001 | 2025-03-14 | Email | J. Smith → A. Lee | Re delivery delay | Client production | None | matters/X/docs/C-0001.pdf |
| C-0002 | 2025-03-15 | Memo | Client GC → CEO | Legal advice re contract | Client | AC — withhold, log | … |
```

Rules:
- Number on arrival; never renumber.
- Description is neutral and factual ("email regarding delivery schedule"), not argument.
- Duplicates get their own number and a "dup of" note.

## Exhibit list

Exhibits are a subset of the index chosen by the attorney.

```
| Ex. | Ctrl # | Description | Bates range | Witness | Offered | Objection | Admitted |
```

- Keep the link to the control number so you can always find the source.
- Follow the court's numbering convention (numbers, letters, party prefix).
- Track each exhibit's status at hearing or trial.

## Chronology

A chronology turns the documents into a timeline the attorney can read in ten minutes.

```
| Date | Event | Source (Ctrl #) | Disputed? | Notes |
|------|-------|-----------------|-----------|-------|
| 2025-03-14 | Supplier tells client of delay | C-0001 | No | |
| 2025-03-20 | Client says it rejected goods | Client interview | Yes — no doc yet | Ask for proof |
```

- Every entry cites a source. "Client says" is a source, but mark it as such.
- Flag gaps and conflicts as questions for the attorney.
- Keep one chronology per matter, updated as documents arrive.

## Privilege log

When documents are withheld or redacted for privilege, many courts require a log describing each one well enough to assess the claim **without revealing the privileged content**. The required fields vary; check the rules and any protective order.

Typical fields:

```
| Log # | Ctrl # | Date | Author | Recipients (incl. cc) | Type | Subject matter (general) | Privilege basis | Withheld / redacted |
```

Description test: specific enough to show why it's privileged, general enough not to disclose the advice. "Email from outside counsel to client providing legal advice regarding contract termination" rather than the advice itself.

Rules:
- Identify lawyers in the author and recipient lists (mark with "Esq." or an asterisk, per local practice).
- Note third parties on the communication; their presence can affect privilege. Flag for the attorney.
- The privilege call is the attorney's. The desk marks "possible privilege, review" and the attorney decides.

## Worked example: marking on arrival

A client forwards a folder of 40 emails. On filing:

1. Assign C-0101 to C-0140.
2. Index each with neutral descriptions.
3. Any email with a lawyer as author or recipient, or with "legal advice" content: mark "possible privilege, review" and move to a restricted subfolder.
4. Add a task: attorney privilege review of 7 flagged items.
5. Add new dates to the chronology with control numbers.

## Common mistakes

- Renumbering documents halfway through.
- Argumentative descriptions in the index.
- Privilege log entries so vague they invite a challenge, or so detailed they waive privilege.
- Facts in the chronology with no source.
