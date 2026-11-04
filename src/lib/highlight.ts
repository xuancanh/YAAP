/**
 * Light syntax colouring for read-only code (Markdown code blocks, the code
 * viewer, the editor's code blocks): one regex lexer per language family —
 * comments, strings, numbers, keywords, a few punctuation classes. Not a
 * parser; it only has to look right, never to be right. Colours come from
 * the `.tok-*` classes in src/styles/doc.css (theme tokens).
 */
import { createElement, Fragment, type ReactNode } from 'react';

export type TokKind = 'kw' | 'str' | 'com' | 'num' | 'fn' | 'type' | 'prop' | 'punct' | 'tag' | 'attr' | 'meta';
export interface Tok { from: number; to: number; kind: TokKind }

const KW: Record<string, string> = {
  c: 'if else for while do return break continue switch case default function fn func def class struct enum interface type impl trait let const var val mut pub private protected public static async await yield new delete import export from as package use mod in of is not and or try catch finally throw throws raise with lambda match where select insert update delete create table values into join on group by order limit null nil none undefined true false self this super extends implements readonly declare namespace module require go defer chan map range elif pass end then begin unless until loop',
};
const KEYWORDS = new Set(KW.c.split(' '));

type Family = 'c' | 'hash' | 'sql' | 'markup' | 'json' | 'yaml' | 'css' | 'shell' | 'plain';

const LANG: Record<string, Family> = {
  js: 'c', jsx: 'c', ts: 'c', tsx: 'c', mjs: 'c', cjs: 'c', javascript: 'c', typescript: 'c', java: 'c', kt: 'c', kotlin: 'c', swift: 'c',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', go: 'c', rs: 'c', rust: 'c', php: 'c', dart: 'c', scala: 'c', vue: 'c', svelte: 'c', graphql: 'c', proto: 'c',
  py: 'hash', python: 'hash', rb: 'hash', ruby: 'hash', r: 'hash', toml: 'hash', ini: 'hash', env: 'hash', dockerfile: 'hash', makefile: 'hash', lua: 'hash', perl: 'hash',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', json: 'json', jsonl: 'json', ndjson: 'json', jsonc: 'json',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', css: 'css', scss: 'css', less: 'css',
};

const RULES: Record<Family, Array<[RegExp, TokKind]>> = {
  c: [[/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, 'com'], [/`(?:\\[\s\S]|[^\\`])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y, 'str'], [/\b(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/iy, 'num'], [/@[A-Za-z_]\w*/y, 'meta'], [/[A-Za-z_$][\w$]*(?=\s*\()/y, 'fn'], [/\b[A-Z][\w$]*\b/y, 'type'], [/[A-Za-z_$][\w$]*/y, 'kw']],
  hash: [[/#[^\n]*/y, 'com'], [/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y, 'str'], [/\b\d[\d_]*(?:\.\d+)?\b/y, 'num'], [/@[A-Za-z_]\w*/y, 'meta'], [/[A-Za-z_]\w*(?=\s*\()/y, 'fn'], [/\b[A-Z]\w*\b/y, 'type'], [/[A-Za-z_]\w*/y, 'kw']],
  shell: [[/#[^\n]*/y, 'com'], [/"(?:\\.|[^"\\])*"|'[^']*'/y, 'str'], [/\$\{?[\w@#?*!-]+\}?/y, 'prop'], [/(?<=^|[\s|;&])-{1,2}[\w-]+/y, 'attr'], [/[A-Za-z_][\w-]*/y, 'kw']],
  sql: [[/--[^\n]*|\/\*[\s\S]*?\*\//y, 'com'], [/'(?:''|[^'])*'|"[^"]*"/y, 'str'], [/\b\d+(?:\.\d+)?\b/y, 'num'], [/[A-Za-z_]\w*(?=\s*\()/y, 'fn'], [/[A-Za-z_]\w*/y, 'kw']],
  json: [[/"(?:\\.|[^"\\])*"(?=\s*:)/y, 'prop'], [/"(?:\\.|[^"\\])*"/y, 'str'], [/-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy, 'num'], [/\b(?:true|false|null)\b/y, 'kw'], [/[{}[\],:]/y, 'punct']],
  yaml: [[/#[^\n]*/y, 'com'], [/^[ \t-]*[\w.-]+(?=\s*:)/my, 'prop'], [/"(?:\\.|[^"\\])*"|'[^']*'/y, 'str'], [/\b\d+(?:\.\d+)?\b/y, 'num'], [/\b(?:true|false|null|yes|no)\b/y, 'kw']],
  markup: [[/<!--[\s\S]*?-->/y, 'com'], [/<\/?[A-Za-z][\w:-]*/y, 'tag'], [/\/?>/y, 'tag'], [/[A-Za-z_:][\w:.-]*(?==)/y, 'attr'], [/"[^"]*"|'[^']*'/y, 'str']],
  css: [[/\/\*[\s\S]*?\*\//y, 'com'], [/"[^"]*"|'[^']*'/y, 'str'], [/#[\da-f]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b/iy, 'num'], [/[\w-]+(?=\s*:)/y, 'prop'], [/@[\w-]+/y, 'meta'], [/[.#][\w-]+/y, 'type']],
  plain: [],
};

export function familyOf(lang: string | null | undefined): Family {
  return LANG[(lang ?? '').toLowerCase()] ?? 'plain';
}

/** Tokens in `code` (non-overlapping, in order). Capped for huge files. */
export function lex(code: string, lang: string | null | undefined, cap = 200_000): Tok[] {
  const fam = familyOf(lang);
  const rules = RULES[fam];
  if (!rules.length || code.length > cap) return [];
  const toks: Tok[] = [];
  let i = 0;
  outer: while (i < code.length) {
    const ch = code[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    for (const [re, kind] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m.index === i && m[0].length) {
        const word = m[0];
        // bare identifiers count only when they are keywords
        if (kind === 'kw' && (fam === 'c' || fam === 'hash' || fam === 'shell' || fam === 'sql')) {
          if (KEYWORDS.has(fam === 'sql' ? word.toLowerCase() : word)) toks.push({ from: i, to: i + word.length, kind });
        } else toks.push({ from: i, to: i + word.length, kind });
        i += word.length;
        continue outer;
      }
    }
    i++;
  }
  return toks;
}

/** `code` as React nodes with `.tok-*` spans. */
export function Highlighted({ code, lang }: { code: string; lang?: string | null }): ReactNode {
  const toks = lex(code, lang);
  if (!toks.length) return code;
  const out: ReactNode[] = [];
  let at = 0;
  toks.forEach((t, k) => {
    if (t.from > at) out.push(code.slice(at, t.from));
    out.push(createElement('span', { key: k, className: `tok-${t.kind}` }, code.slice(t.from, t.to)));
    at = t.to;
  });
  if (at < code.length) out.push(code.slice(at));
  return createElement(Fragment, null, ...out);
}

/** Highlighted lines for a line-numbered view: each line's nodes. */
export function highlightLines(code: string, lang?: string | null): ReactNode[][] {
  const toks = lex(code, lang);
  const lines: ReactNode[][] = [[]];
  let k = 0;
  const push = (text: string, kind?: TokKind) => {
    const parts = text.split('\n');
    parts.forEach((part, j) => {
      if (j) lines.push([]);
      if (part) lines[lines.length - 1].push(kind ? createElement('span', { key: k++, className: `tok-${kind}` }, part) : part);
    });
  };
  let at = 0;
  for (const t of toks) { if (t.from > at) push(code.slice(at, t.from)); push(code.slice(t.from, t.to), t.kind); at = t.to; }
  if (at < code.length) push(code.slice(at));
  return lines;
}
