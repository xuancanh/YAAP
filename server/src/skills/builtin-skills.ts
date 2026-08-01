/**
 * Built-in global skills seeded on boot (recreated if deleted, edits stick).
 * A skill is an instruction pack the model loads by calling its tool
 * (skill_<name>) or the user invokes as a slash command (FR-2.4/10.2). The
 * instructions reference the shipped tool names, so they stay executable.
 */
export interface BuiltinSkill {
  name: string;
  description: string;
  instructions: string;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: 'deep-research',
    description: 'Iterative multi-source web research producing a cited report saved to workspace files',
    instructions: `You are running a deep-research workflow. Follow every step.

1. Restate the research question and list 3-6 sub-questions that must be answered.
2. For each sub-question, call web_search with a focused query, then web_fetch the 2-3 most promising results. Prefer primary sources; note the publisher and date of each.
3. After each fetch, append condensed findings to research/<topic-slug>/notes.md with fs_write (read the existing file first with fs_read and append; do not overwrite). Record the source URL next to every claim.
4. Cross-check: where sources disagree, fetch one more independent source and note which claim is better supported.
5. Stop searching when the sub-questions are answered or after ~10 searches; do not loop endlessly.
6. Write the final report to research/<topic-slug>/report.md with fs_write:
   - Executive summary (5-8 sentences)
   - One section per sub-question with findings
   - A "Sources" section listing every URL used, numbered; cite them inline as [n]
   - An "Open questions / low-confidence" section
7. Reply in chat with the executive summary and the report path.`,
  },
  {
    name: 'write-document',
    description: 'Author a well-structured markdown document and save it to workspace files',
    instructions: `You are writing a polished document. Follow this process.

1. Confirm the document's purpose, audience, and rough length from the request; ask only if genuinely ambiguous.
2. Draft an outline first (title, section headings, one line per section on what it covers).
3. Write the document in markdown: one H1 title, H2 sections, short paragraphs, bullet lists where enumerating, tables only for genuinely tabular facts. No filler prose.
4. Where the workspace has relevant files, read them with fs_list / fs_read and incorporate accurate details rather than inventing them.
5. Save the result to documents/<kebab-case-name>.md using fs_write. If the file already exists, read it first and preserve anything the user added.
6. If you have the drive_export_doc tool (the user granted Drive export), offer to also export the document as a Google Doc; export only if they say yes or asked for it up front.
7. Reply in chat with a 2-3 sentence summary and the saved path. Do not paste the whole document into the chat.`,
  },
  {
    name: 'create-slides',
    description: 'Turn a topic or document into a self-contained HTML slide deck saved to workspace files',
    instructions: `You are building a slide deck. Follow this process.

1. Identify the audience and the single message the deck must land; if a source document is referenced, read it with fs_read first.
2. Outline 5-12 slides: a title slide, an agenda slide when the deck has 6+ slides, one idea per slide, and a closing slide with takeaways or next steps.
3. Keep each slide tight: a short title and 3-5 bullets of at most ~12 words each. Put nuance in the speaker notes, not the bullets.
4. Call slides_create with { path: "slides/<kebab-case-name>.html", title, slides: [{ title, bullets, notes? }] }. The tool renders a self-contained HTML deck (arrow keys navigate).
5. Reply in chat with the deck path and a one-line description of the narrative arc.`,
  },
  {
    name: 'make-spreadsheet',
    description: 'Build a calculation-checked data table as CSV plus a readable markdown view in workspace files',
    instructions: `You are building a spreadsheet-style deliverable without spreadsheet software. Follow this process.

1. Pin down the columns, the grain (one row = one what?), and any derived columns (totals, deltas, percentages) from the request; ask only if genuinely ambiguous.
2. Gather the data: read referenced workspace files with fs_list / fs_read, or take pasted data from chat. Never invent numbers - leave a cell blank and note it instead.
3. Compute derived values yourself, digit by digit, and re-check every sum and percentage once before writing anything.
4. Save two files with fs_write:
   - data/<kebab-case-name>.csv - plain CSV, header row first, no thousands separators
   - data/<kebab-case-name>.md - the same table in markdown with a short "How to read this" note and any caveats
5. If you have the drive_export_sheet tool (the user granted Drive export), offer to also export the CSV as a Google Sheet; export only if they say yes or asked for it up front.
6. Reply in chat with the two paths, the row count, and the one number the user most likely cares about.`,
  },
  {
    name: 'design-polish',
    description: 'Apply a coherent visual theme to an HTML artifact, slide deck, or mini app',
    instructions: `You are restyling an HTML deliverable (artifact, deck, or mini app). Follow this process.

1. Read the current file with fs_read (or take the HTML from the conversation). Identify its purpose and audience before touching style.
2. Pick one deliberate direction and commit: a 2-3 color palette (background, text, one accent), one display font pairing from system/web-safe stacks, and a consistent spacing scale. Never sprinkle six accent colors.
3. Apply the theme with inline CSS or a single <style> block - the result must stay one self-contained file with no external fonts, scripts, or images.
4. Sweep for the usual defects: contrast under WCAG AA, unaligned edges, inconsistent border radii, orphaned font sizes, walls of text that need whitespace.
5. Save with fs_write (same path unless asked otherwise, so the original is replaced predictably) and reply with one sentence naming the direction you chose.`,
  },
];
