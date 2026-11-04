/**
 * The shape of the embedded knowledge base (docs/knowledge-base.md), as
 * scripts/build-knowledge.mjs writes it into knowledge.generated.ts.
 */
export interface KbSource {
  title: string;
  url: string;
  date?: string;
  accessed?: string;
  publisher?: string;
  author?: string;
  note?: string;
}

/** One doc. `path` is knowledge-relative: `<pack folder>/<slug>.md` or
 *  `_shared/<topic>/<slug>.md`; installed at `/library/<path>`. */
export interface KbDoc {
  path: string;
  title: string;
  summary: string;
  tags: string[];
  updated: string;
  sources?: KbSource[];
  /** README.md of a pack only: the shared topics the role also sees. */
  shared?: string[];
  body: string;
  words: number;
}

/** A pack's knowledge base: `knowledge/<folder>/`, README.md first. */
export interface KbPack {
  /** The pack file's basename (packs/<folder>.md). */
  folder: string;
  packId: string;
  packName: string;
  /** The README's title and summary. */
  title: string;
  summary: string;
  /** Shared topic slugs (without `_shared/`). */
  shared: string[];
  /** A content hash: changes whenever a doc of the pack (or one of its shared topics) does. */
  version: string;
  docs: KbDoc[];
}

export interface KbTopic {
  topic: string;
  version: string;
  docs: KbDoc[];
}

export interface KnowledgeBundle {
  packs: Record<string, KbPack>;
  shared: Record<string, KbTopic>;
}
