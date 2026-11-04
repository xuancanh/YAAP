/** Personality (docs/agent-writing.md "Personalities"): the agent's
 *  temperament, picked at random when it was hired, changeable here. It
 *  shapes tone and word choice only; "None" is a neutral voice. The
 *  workspace switch is Settings › Context & budget › Agents have personalities. */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { api, type Agent, type AgentPersonality } from '../lib/api';

const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 14, background: 'var(--panel)' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--text-faint)' };

export function PersonalityCard({ a }: { a: Agent }) {
  const app = useApp();
  const [catalog, setCatalog] = useState<AgentPersonality[] | null>(null);
  const [value, setValue] = useState(a.personality ?? 'none');
  useEffect(() => { setValue(a.personality ?? 'none'); }, [a.id, a.personality]);
  useEffect(() => {
    let live = true;
    api.agentPersonalities().then((list) => { if (live) setCatalog(list); }).catch(() => { if (live) setCatalog([]); });
    return () => { live = false; };
  }, []);
  const off = app.settings?.agentPersonalities === 'off';
  const picked = catalog?.find((p) => p.id === value) ?? null;
  const save = async (next: string) => {
    const before = value;
    setValue(next);
    try {
      await api.updateAgent(a.id, { personality: next });
      await app.refreshAgents();
      app.showToast(next === 'none' ? `${a.name} now speaks neutrally` : `${a.name} is now ${catalog?.find((p) => p.id === next)?.name.toLowerCase() ?? next}`);
    } catch (err) {
      setValue(before);
      app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'could not save');
    }
  };
  return (
    <div style={{ ...card, padding: '16px 18px' }}>
      <div style={{ marginBottom: 6 }}><span style={label}>Personality</span></div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 11, lineHeight: 1.5 }}>
        How {a.name} sounds in chats, channels and meetings. It changes tone and word choice, never accuracy or how much it writes.
        {off && ' Personalities are off for this workspace (Settings › Context & budget), so it speaks neutrally for now.'}
      </div>
      <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--text-faint)', maxWidth: 360 }}>
        Personality
        <select aria-label="Personality" value={value} disabled={catalog === null} onChange={(e) => void save(e.target.value)}
          style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', color: 'var(--text)', fontSize: 13, outline: 'none', minWidth: 0, cursor: 'pointer' }}>
          {(catalog ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value="none">None (neutral)</option>
        </select>
      </label>
      <div data-testid="personality-description" style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 9, lineHeight: 1.5 }}>
        {picked ? <>{picked.description} <span style={{ color: 'var(--text-faint)' }}>e.g. “{picked.example}”</span></> : value === 'none' ? 'A neutral voice: plain and friendly, no particular temperament.' : ''}
      </div>
    </div>
  );
}
