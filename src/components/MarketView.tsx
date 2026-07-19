/** Agent Market: registry cards + the capability-review hire modal (FR-11.7). */
import { useState } from 'react';
import { I, P, CAP_ICON } from '../lib/icons';
import { useApp, gradPair } from '../store';

/** Rail chip order: professional clusters first, then personal life; anything
 *  the catalog adds beyond this list appends at the end. */
const CAT_ORDER = [
  'Workplace', 'Product & Engineering', 'Education', 'Legal & Finance', 'Writing & Media',
  'Care & Community', 'Property & Field', 'Small Business',
  'Family & Care', 'Home & Money', 'Health & Growth', 'Events & Travel', 'Hobbies & Leisure',
];

/** Category list for the market rails, in canonical order, 'All' first. */
export function marketCats(market: Array<{ cat: string }>): string[] {
  const found = Array.from(new Set(market.map((m) => m.cat)));
  return ['All', ...CAT_ORDER.filter((c) => found.includes(c)), ...found.filter((c) => !CAT_ORDER.includes(c))];
}

export function MarketView({ cat, setCat }: { cat: string; setCat: (c: string) => void }) {
  const app = useApp();
  const [search, setSearch] = useState('');
  const q = search.toLowerCase();
  const cats = marketCats(app.market);
  const items = app.market.filter((m) => (cat === 'All' || m.cat === cat) && (!q || m.name.toLowerCase().includes(q) || m.role.toLowerCase().includes(q)));

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '30px 28px 60px' }}>
        <div style={{ fontSize: 23, fontWeight: 700, letterSpacing: '-.4px' }}>Agent Market</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 13.5, marginTop: 4, maxWidth: 560 }}>
          Hire durable agents from the registry. Each install runs a capability review first — imported loops enable immediately.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 9, padding: '8px 11px', flex: 1, minWidth: 200 }}>
            <I d={P.search} size={15} stroke="var(--text-faint)" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the market" style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13 }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          {cats.map((c) => (
            <div key={c} onClick={() => setCat(c)} style={{ padding: '6px 14px', borderRadius: 20, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${c === cat ? 'var(--accent)' : 'var(--border)'}`, background: c === cat ? 'var(--accent)' : 'var(--panel)', color: c === cat ? '#fff' : 'var(--text-dim)' }}>{c}</div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(2,1fr)', gap: 16, marginTop: 18 }}>
          {items.map((m) => (
            <div key={m.id} style={{ border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: 18, display: 'flex', flexDirection: 'column', gap: 13 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                <div style={{ width: 46, height: 46, borderRadius: 13, background: gradPair(m.colors), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 22 }}>{m.emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.2px' }}>{m.name}</span>
                    {m.verified && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--blue)"><path d="M12 2l2.4 1.8 3 .2.2 3L19.4 9.6l-1.8 2.4 1.8 2.4-1.8 2.6-.2 3-3 .2L12 22l-2.4-1.8-3-.2-.2-3L4.6 14.4 6.4 12 4.6 9.6l1.8-2.4.2-3 3-.2z" /><path d="M9 12l2 2 4-4" stroke="#fff" strokeWidth="2" fill="none" /></svg>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{m.author}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--amber)' }}>★ {m.stars}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{m.installs}</div>
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>{m.tagline}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {m.caps.map((cap) => <span key={cap} style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px', fontFamily: 'var(--mono)' }}>{cap}</span>)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 12, borderTop: '1px solid var(--border-soft)' }}>
                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{m.price === 'free' ? 'Free' : 'Metered · tokens'}</span>
                {m.hired ? (
                  <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--green)', fontWeight: 600 }}>
                    <I d={P.check} size={14} sw={2.4} />Hired
                  </span>
                ) : (
                  <button onClick={() => app.setHireId(m.id)} style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '7px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Hire</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function HireModal() {
  const app = useApp();
  const item = app.market.find((m) => m.id === app.hireId);
  if (!item) return null;
  return (
    <div onClick={() => app.setHireId(null)} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '22px 24px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 13, background: gradPair(item.colors), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 23 }}>{item.emoji}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Review before hiring {item.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>{item.author} · {item.price === 'free' ? 'Free' : 'Metered'}</div>
          </div>
          <button onClick={() => app.setHireId(null)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 4, display: 'flex' }}><I d={P.x} size={18} /></button>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 11 }}>Capabilities requested</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {item.capsFull.map((c) => (
              <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 10 }}>
                <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', color: 'var(--accent-hi)' }}>
                  <I d={CAP_ICON[c.icon] ?? CAP_ICON.file} size={15} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono)' }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{c.desc}</div>
                </div>
              </div>
            ))}
          </div>
          {(item.skills?.length ?? 0) > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 11 }}>
                Bundled skills · {item.skills!.length}
              </div>
              <div style={{ maxHeight: 210, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel-2)' }}>
                {item.skills!.map((s) => (
                  <div key={s.name} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-soft)' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--mono)' }}>/{s.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 1, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{s.description}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 7 }}>
                Skills install private to this agent — read, edit, or remove them any time in its Skills &amp; tools tab.
              </div>
            </div>
          )}
          {item.loops.length > 0 && (
            <div style={{ marginTop: 18, padding: '13px 15px', border: '1px solid var(--amber)', borderRadius: 11, background: 'color-mix(in oklab,var(--amber) 12%,transparent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--amber)', marginBottom: 8 }}>
                <I d={P.warn} size={15} />Scheduled loops enable immediately on install
              </div>
              {item.loops.map((l) => (
                <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: 'var(--text-dim)', padding: '3px 0' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)', flex: 'none' }} />
                  <span style={{ flex: 1 }}>{l.name}</span>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>{l.cron}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Runs under your active workspace credentials.</span>
          <button onClick={() => app.setHireId(null)} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => void app.confirmHire()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Approve & hire</button>
        </div>
      </div>
    </div>
  );
}
