/** CSV/TSV (docs/filesystem.md "Editing"): the read-only table with sorting,
 *  and the editable grid — click a cell, type or press Enter to edit, arrows
 *  and Tab to move, Delete to clear, paste a block from a spreadsheet, add
 *  or remove rows and columns. Saved back as CSV/TSV with the file's line
 *  endings; untouched files are never rewritten. */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { compareCells, delimitedRowSources, parseDelimited, serializeDelimited } from '../lib/artifacts';

const CSV_ROW_CAP = 500;
const isNum = (s: string) => s !== '' && !Number.isNaN(Number(s.replace(/[,$%\s]/g, '')));

/** CSV/TSV as a table: first row is the header, click a header to sort
 *  (asc → desc → original), rows capped so a huge export stays responsive. */
export function CsvTable({ text, sep = ',', maxRows = CSV_ROW_CAP }: { text: string; sep?: string; maxRows?: number }) {
  const rows = useMemo(() => parseDelimited(text, sep), [text, sep]);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const header = rows[0] ?? [];
  const body = useMemo(() => {
    const data = rows.slice(1);
    if (!sort) return data;
    return [...data].sort((a, b) => sort.dir * compareCells(a[sort.col] ?? '', b[sort.col] ?? ''));
  }, [rows, sort]);
  if (rows.length === 0) return <div className="grid-foot">Empty table.</div>;
  const cols = Math.max(header.length, ...body.slice(0, maxRows).map((r) => r.length));
  const shown = body.slice(0, maxRows);
  const numeric = Array.from({ length: cols }, (_, i) => shown.length > 0 && shown.every((r) => (r[i] ?? '') === '' || isNum(r[i] ?? '')));
  const click = (col: number) => setSort((s) => (!s || s.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));
  return (
    <div>
      <div className="grid-wrap">
        <table data-testid="csv-table" className="grid">
          <thead>
            <tr>
              <th className="rn" aria-hidden />
              {Array.from({ length: cols }, (_, i) => (
                <th key={i} aria-sort={sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="sort" onClick={() => click(i)}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{header[i] ?? ''}</span>
                    <span aria-hidden style={{ color: sort?.col === i ? 'var(--accent-hi)' : 'var(--text-faint)', fontSize: 10 }}>{sort?.col === i ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, ri) => (
              <tr key={ri}>
                <td className="rn" aria-hidden>{ri + 1}</td>
                {Array.from({ length: cols }, (_, ci) => <td key={ci} title={r[ci] ?? ''} className={numeric[ci] ? 'num' : undefined}><span className="cell">{r[ci] ?? ''}</span></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid-foot">
        {body.length > maxRows ? `Showing the first ${maxRows} of ${body.length} rows` : `${body.length} row${body.length === 1 ? '' : 's'}`}, {cols} column{cols === 1 ? '' : 's'}
      </div>
    </div>
  );
}

interface Pos { r: number; c: number }

export function CsvGrid({ text, sep = ',', onChange }: { text: string; sep?: string; onChange: (get: () => string) => void }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text === '' || /\n$/.test(text);
  const [original] = useState(() => ({ rows: parseDelimited(text, sep), sources: delimitedRowSources(text, sep) }));
  const [rows, setRows] = useState<string[][]>(() => (original.rows.length ? original.rows : [['']]));
  const [active, setActive] = useState<Pos | null>(null);
  const [edit, setEdit] = useState<{ pos: Pos; value: string } | null>(null);
  const [limit, setLimit] = useState(CSV_ROW_CAP);
  const wrap = useRef<HTMLDivElement>(null);
  const cols = Math.max(1, ...rows.map((r) => r.length));

  const commit = useCallback((next: string[][]) => {
    setRows(next);
    onChange(() => serializeDelimited(next, sep, eol, trailing, original));
  }, [onChange, sep, eol, trailing, original]);

  const setCell = (rs: string[][], { r, c }: Pos, v: string): string[][] => {
    const next = rs.map((row) => [...row]);
    while (next.length <= r) next.push([]);
    const row = next[r];
    while (row.length <= c) row.push('');
    row[c] = v;
    return next;
  };
  const finishEdit = (move?: Pos) => {
    if (edit) { if ((rows[edit.pos.r]?.[edit.pos.c] ?? '') !== edit.value) commit(setCell(rows, edit.pos, edit.value)); setEdit(null); }
    if (move) setActive(move);
    requestAnimationFrame(() => wrap.current?.focus({ preventScroll: true }));
  };
  const clamp = (p: Pos): Pos => ({ r: Math.max(0, Math.min(rows.length - 1, p.r)), c: Math.max(0, Math.min(cols - 1, p.c)) });

  const onKey = (e: KeyboardEvent) => {
    if (edit || !active) return;
    const mv: Record<string, Pos> = { ArrowUp: { r: -1, c: 0 }, ArrowDown: { r: 1, c: 0 }, ArrowLeft: { r: 0, c: -1 }, ArrowRight: { r: 0, c: 1 }, Tab: { r: 0, c: e.shiftKey ? -1 : 1 } };
    if (mv[e.key]) { e.preventDefault(); setActive(clamp({ r: active.r + mv[e.key].r, c: active.c + mv[e.key].c })); return; }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); setEdit({ pos: active, value: rows[active.r]?.[active.c] ?? '' }); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if ((rows[active.r]?.[active.c] ?? '') !== '') commit(setCell(rows, active, '')); return; }
    if (e.key === 'Escape') { setActive(null); return; }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setEdit({ pos: active, value: e.key }); }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (edit || !active) return;
    const data = e.clipboardData.getData('text/plain');
    if (!data) return;
    e.preventDefault();
    const block = parseDelimited(data, data.includes('\t') ? '\t' : sep);
    let next = rows;
    block.forEach((br, i) => br.forEach((v, j) => { next = setCell(next, { r: active.r + i, c: active.c + j }, v); }));
    const width = Math.max(...next.map((r) => r.length));
    if (width > cols) next = next.map((r) => (r.length < width && r.length >= cols ? [...r, ...Array(width - r.length).fill('')] : r));
    commit(next);
  };
  const onCopy = (e: React.ClipboardEvent) => {
    if (edit || !active) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', rows[active.r]?.[active.c] ?? '');
  };

  const pad = (rs: string[][], n: number) => rs.map((r) => (r.length < n ? [...r, ...Array(n - r.length).fill('')] : r));
  const addRow = (at = rows.length) => { const next = [...rows]; next.splice(at, 0, Array(cols).fill('')); commit(next); setActive({ r: at, c: active?.c ?? 0 }); };
  const addCol = (at = cols) => { const next = pad(rows, cols).map((r) => { const x = [...r]; x.splice(at, 0, ''); return x; }); commit(next); setActive({ r: active?.r ?? 0, c: at }); };
  const delRow = () => { if (!active || rows.length <= 1) return; const next = rows.filter((_, i) => i !== active.r); commit(next); setActive(clamp({ r: Math.min(active.r, next.length - 1), c: active.c })); };
  const delCol = () => { if (!active || cols <= 1) return; const next = rows.map((r) => r.filter((_, i) => i !== active.c)); commit(next); setActive({ r: active.r, c: Math.min(active.c, cols - 2) }); };

  useEffect(() => { if (!edit) return; const el = wrap.current?.querySelector<HTMLInputElement>('input.cell-input'); el?.focus(); const n = el?.value.length ?? 0; el?.setSelectionRange(n, n); }, [edit]);

  const cell = (r: number, c: number, head: boolean) => {
    const on = active?.r === r && active.c === c;
    const v = rows[r]?.[c] ?? '';
    const Tag = head ? 'th' : 'td';
    return (
      <Tag key={c} className={on ? 'active' : undefined} aria-selected={on}
        onMouseDown={(e) => { if (edit && edit.pos.r === r && edit.pos.c === c) return; e.preventDefault(); finishEdit({ r, c }); }}
        onDoubleClick={() => setEdit({ pos: { r, c }, value: v })}>
        {edit && edit.pos.r === r && edit.pos.c === c
          ? <input className="cell-input" aria-label={`Row ${r + 1}, column ${c + 1}`} value={edit.value}
              onChange={(e) => setEdit({ pos: edit.pos, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); finishEdit(clamp({ r: r + 1, c })); }
                else if (e.key === 'Tab') { e.preventDefault(); finishEdit(clamp({ r, c: c + (e.shiftKey ? -1 : 1) })); }
                else if (e.key === 'Escape') { e.preventDefault(); setEdit(null); wrap.current?.focus(); }
              }}
              onBlur={() => finishEdit()} />
          : <span className="cell" title={v}>{v}</span>}
      </Tag>
    );
  };

  const shown = rows.slice(1, limit + 1);
  return (
    <div data-testid="csv-grid">
      <div className="grid-bar" role="toolbar" aria-label="Table">
        <button type="button" className="art-btn solid" onClick={() => addRow(active ? active.r + 1 : rows.length)}>Add row</button>
        <button type="button" className="art-btn solid" onClick={() => addCol(active ? active.c + 1 : cols)}>Add column</button>
        <button type="button" className="art-btn" disabled={!active || rows.length <= 1} onClick={delRow}>Delete row</button>
        <button type="button" className="art-btn" disabled={!active || cols <= 1} onClick={delCol}>Delete column</button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-faint)' }}>Enter to edit · paste a block from a spreadsheet</span>
      </div>
      <div className="grid-wrap" ref={wrap} tabIndex={0} onKeyDown={onKey} onPaste={onPaste} onCopy={onCopy} role="grid" aria-label="Cells" aria-rowcount={rows.length} aria-colcount={cols}>
        <table className="grid">
          <thead><tr><th className="rn" aria-hidden />{Array.from({ length: cols }, (_, c) => cell(0, c, true))}</tr></thead>
          <tbody>
            {shown.map((_, i) => <tr key={i + 1}><td className="rn" aria-hidden>{i + 1}</td>{Array.from({ length: cols }, (_, c) => cell(i + 1, c, false))}</tr>)}
          </tbody>
        </table>
      </div>
      <div className="grid-foot">
        {rows.length - 1} row{rows.length === 2 ? '' : 's'}, {cols} column{cols === 1 ? '' : 's'}
        {rows.length - 1 > limit && <> · <button type="button" className="art-btn" onClick={() => setLimit(limit + CSV_ROW_CAP)}>Show {Math.min(CSV_ROW_CAP, rows.length - 1 - limit)} more</button></>}
      </div>
    </div>
  );
}
