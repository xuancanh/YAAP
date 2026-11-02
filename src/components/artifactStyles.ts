/** Shared button styles for the Artifacts views. */
import type { CSSProperties } from 'react';

export const btn: CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, flex: 'none', whiteSpace: 'nowrap' };
export const primaryBtn: CSSProperties = { ...btn, background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff' };
