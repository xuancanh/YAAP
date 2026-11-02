/** Follow / Following toggle with follower avatars (docs/follows.md): on a
 *  channel thread panel and an org task's drawer. Opening it marks what is
 *  new as seen for the caller. Viewers see the followers but cannot follow. */
import { useEffect, useState } from 'react';
import { useApp, grad } from '../store';
import { api, type FollowTargetKind, type FollowView } from '../lib/api';
import { initials } from '../lib/channels';

const MAX_FACES = 5;

export function FollowToggle({ wsId, targetKind, targetId }: { wsId: string; targetKind: FollowTargetKind; targetId: string }) {
  const app = useApp();
  const [view, setView] = useState<FollowView | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setView(null);
    void api.follows(wsId, targetKind, targetId).then((v) => {
      if (!live) return;
      setView(v);
      if (v.following) void api.markFollowSeen(wsId, targetKind, targetId).catch(() => {});
    }).catch(() => { if (live) setView(null); });
    return () => { live = false; };
  }, [wsId, targetKind, targetId]);
  if (!view) return null;
  const readOnly = app.me?.role === 'viewer';
  const toggle = async () => {
    setBusy(true);
    try { setView(await (view.following ? api.unfollow : api.follow)(wsId, targetKind, targetId)); }
    catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'could not change the follow'); }
    finally { setBusy(false); }
  };
  const faces = view.followers.slice(0, MAX_FACES);
  const names = view.followers.map((f) => `${f.followerKind === 'agent' ? (app.agents.find((a) => a.id === f.followerId)?.name ?? 'agent') : app.nameOf(f.followerId)} (${f.reason})`).join(', ');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={names ? `Followers: ${names}` : 'Nobody follows this yet'}>
      {faces.length > 0 && (
        <div style={{ display: 'flex' }} aria-label={`${view.followers.length} follower${view.followers.length === 1 ? '' : 's'}`}>
          {faces.map((f, i) => {
            const agent = f.followerKind === 'agent' ? app.agents.find((a) => a.id === f.followerId) : undefined;
            const base: React.CSSProperties = { width: 18, height: 18, borderRadius: 6, marginLeft: i ? -5 : 0, border: '1.5px solid var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, flex: 'none' };
            return agent || f.followerKind === 'agent'
              ? <span key={`${f.followerKind}:${f.followerId}`} style={{ ...base, background: agent ? grad(agent.colors) : 'var(--panel-2)' }}>{agent?.emoji ?? '🤖'}</span>
              : <span key={`${f.followerKind}:${f.followerId}`} style={{ ...base, background: 'var(--accent-dim)', color: 'var(--text)', fontWeight: 700, fontSize: 8 }}>{initials(app.nameOf(f.followerId))}</span>;
          })}
          {view.followers.length > MAX_FACES && <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 4 }}>+{view.followers.length - MAX_FACES}</span>}
        </div>
      )}
      <button onClick={() => void toggle()} disabled={busy || readOnly} aria-pressed={view.following}
        title={view.following ? 'You follow this: new replies and changes reach your inbox. Click to unfollow.' : 'Follow to hear about new replies and changes'}
        style={{ background: view.following ? 'var(--accent-dim)' : 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 7, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: busy || readOnly ? 'default' : 'pointer', opacity: readOnly ? 0.6 : 1 }}>
        {view.following ? 'Following' : 'Follow'}
      </button>
    </div>
  );
}
