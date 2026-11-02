/** Auto-archive of finished-task chats (docs/chat-archiving.md): the chat
 *  header's control for a task chat and the agent Settings field for the
 *  default its new task chats start with. */
import { useApp } from '../store';
import { api, type Agent, type ChatSession } from '../lib/api';

/** The choices: days after the task is done; '' = the workspace (or agent) default, 0 = off. */
export const AUTO_ARCHIVE_CHOICES = [0, 1, 3, 7, 14, 30] as const;

const toValue = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));
const fromValue = (v: string): number | null => (v === '' ? null : Number(v));
const optionLabel = (d: number) => (d === 0 ? 'Off' : `${d} day${d === 1 ? '' : 's'}`);

const chip: React.CSSProperties = {
  background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-dim)',
  fontSize: 11, padding: '1px 4px', cursor: 'pointer', maxWidth: 150, minWidth: 0, flex: '0 1 auto',
};

/** Header control of a chat linked to a task: Off / 1 / 3 / 7 / 14 / 30 days
 *  after the task is done, or the workspace default. */
export function AutoArchiveMenu({ s }: { s: ChatSession }) {
  const app = useApp();
  if (!s.taskId) return null;
  const value = toValue(s.autoArchiveDays);
  return (
    <label title="Archive this chat automatically some days after its task is done (and the chat has gone quiet). Restore it any time from the Archived group."
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--text-faint)', minWidth: 0, flex: '0 1 auto' }}>
      {app.width >= 700 && <span style={{ whiteSpace: 'nowrap' }}>Auto-archive</span>}
      <select aria-label="Auto-archive after the task is done" value={value} style={chip}
        onChange={(e) => {
          const days = fromValue(e.target.value);
          void app.patchSession(s.id, { autoArchiveDays: days })
            .then(() => app.showToast(days === null ? 'Auto-archive follows the workspace default' : days === 0 ? 'Auto-archive off for this chat' : `Archives ${optionLabel(days)} after its task is done`))
            .catch(() => app.showToast('Could not change auto-archive'));
        }}>
        <option value="">Default</option>
        {AUTO_ARCHIVE_CHOICES.map((d) => <option key={d} value={String(d)}>{d === 0 ? 'Off' : `${optionLabel(d)} after done`}</option>)}
      </select>
    </label>
  );
}

/** Agent Settings: the auto-archive its new task chats start with. */
export function AgentAutoArchiveCard({ a }: { a: Agent }) {
  const app = useApp();
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 14, background: 'var(--panel)', padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 160, fontSize: 11, fontWeight: 600, letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Auto-archive task chats</span>
        <select aria-label={`Auto-archive ${a.name}'s task chats`} value={toValue(a.chatAutoArchiveDays)}
          onChange={async (e) => {
            try {
              await api.updateAgent(a.id, { chatAutoArchiveDays: fromValue(e.target.value) });
              await app.refreshAgents();
              app.showToast('Saved — applies to new task chats');
            } catch (err) {
              app.showToast(err instanceof Error ? err.message.slice(0, 120) : 'could not save');
            }
          }}
          style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 12.5, padding: '5px 8px', cursor: 'pointer' }}>
          <option value="">Workspace default</option>
          {AUTO_ARCHIVE_CHOICES.map((d) => <option key={d} value={String(d)}>{d === 0 ? 'Off' : `${optionLabel(d)} after the task is done`}</option>)}
        </select>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
        A chat {a.name} works a task in starts with this. Each chat can change it from its header, and {a.name} can with set_chat_auto_archive. Archived chats restore from the Archived group.
      </div>
    </div>
  );
}
