/** AppHost — the host side of the mini-app capability bridge
 *  (docs/miniapp-capabilities.md). Wraps every app iframe, injects the
 *  window.yaam shim, and routes its postMessage RPC: filtering against the
 *  approved manifest, rendering confirms in our chrome (never the app's),
 *  and forwarding to the scoped server endpoints, which re-verify every
 *  grant. The iframe stays opaque-origin with no network of its own. */
import { useEffect, useRef, useState } from 'react';
import { api, appLlmStream, type AgentApp } from '../lib/api';
import { CSP_META } from '../lib/sandbox';
import { useApp } from '../store';

/** Injected before the app's own HTML; defines the promise-based RPC. */
const SHIM = `<script>window.yaam=(()=>{let q=0;const p={},s={};addEventListener('message',e=>{const m=e.data;if(!m||!m.__yaam)return;if(m.chunk!==undefined){const f=s[m.id];if(f)f(m.chunk);return}if(p[m.id]){const{ok,er}=p[m.id];delete p[m.id];delete s[m.id];m.error?er(new Error(m.error)):ok(m.result)}});const c=(op,args,onChunk)=>new Promise((ok,er)=>{const id=++q;p[id]={ok,er};if(onChunk)s[id]=onChunk;parent.postMessage({__yaam:true,id,op,args:args||{}},'*')});return{
storage:{get:()=>c('storage.get'),set:(state)=>c('storage.set',{state})},
files:{list:(prefix)=>c('files.list',{prefix}),read:(path,offset)=>c('files.read',{path,offset}),write:(path,content)=>c('files.write',{path,content}),propose:(path,content)=>c('files.propose',{path,content}),watch:(prefix,since)=>c('files.watch',{prefix,since})},
tasks:{list:()=>c('tasks.list'),add:(t)=>c('tasks.add',t),move:(id,status)=>c('tasks.move',{id,status})},
chat:{compose:(text)=>c('chat.compose',{text})},
agent:{ask:(prompt)=>c('agent.ask',{prompt})},
llm:{complete:(prompt,opts)=>c('llm.complete',Object.assign({prompt},opts||{})),stream:(prompt,onChunk,opts)=>c('llm.stream',Object.assign({prompt},opts||{}),onChunk)},
data:{put:(collection,row)=>c('data.put',{collection,row}),query:(collection,q)=>c('data.query',Object.assign({collection},q||{})),remove:(collection,id)=>c('data.delete',{collection,id})},
sql:{engine:()=>c('sql.engine')},
connections:{list:()=>c('connections.list'),read:(provider,op,params)=>c('connections.read',{provider,op,params:params||{}}),propose:(provider,op,payload)=>c('connections.propose',{provider,op,payload:payload||{}})},
compute:{status:()=>c('compute.status'),run:(language,code,stdin,timeoutSeconds)=>c('compute.run',{language,code,stdin,timeoutSeconds})},
ui:{theme:()=>c('ui.theme'),toast:(text)=>c('ui.toast',{text})}
}})();</script>`;

/** Capability metadata: plain words for chips, review, and confirms. */
export const CAP_INFO: Record<string, { label: string; desc: string; free?: boolean; confirm?: boolean }> = {
  'storage': { label: 'storage', desc: 'Keep its own saved state (64 KB, private to this app)', free: true },
  'chat.compose': { label: 'chat.compose', desc: 'Prefill the chat box — you still press send', free: true },
  'files.read': { label: 'files.read', desc: "Read the agent's working folder, including the shared/ mount" },
  'files.write': { label: 'files.write', desc: 'Write files, only inside its own app folder' },
  'tasks.read': { label: 'tasks.read', desc: "See the agent's kanban board" },
  'tasks.write': { label: 'tasks.write', desc: 'File new tasks and move task status', confirm: true },
  'agent.ask': { label: 'agent.ask', desc: 'Ask the agent questions (Ask mode, tools denied, 20 turns/day)', confirm: true },
  // act two (docs/miniapp-roadmap.md). llm is cost-risk, not agency-risk —
  // no tools, no agent context — so it activates without a per-call confirm.
  'llm': { label: 'llm', desc: 'Use the model directly for its own text work (no tools, daily token budget)' },
  'data': { label: 'data', desc: 'Keep structured rows it can query (its own namespace)' },
  'connections': { label: 'connections', desc: "Read your connected calendar and mail through the agent's grant; changes need your approval", confirm: true },
  'compute': { label: 'compute', desc: 'Run code in the sandboxed runner (no network, scratch files only)', confirm: true },
};

/** Elevated caps requested but not yet activated by the user. */
export function pendingCaps(a: AgentApp): string[] {
  const approved = new Set(a.approved ?? []);
  return (a.capabilities ?? []).filter((c) => !CAP_INFO[c]?.free && !approved.has(c));
}

interface Msg { __yaam: true; id: number; op: string; args: Record<string, unknown> }

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** Consecutive-ish denials tolerated before an app loses the confirm channel
 *  for this mount. Generous for honest mis-clicks, fatal to a nag loop. */
const MAX_DENIALS = 3;

/** Ops that confirm on first use per app, then remember for this mount. */
const CONFIRM_ONCE = new Set(['tasks.add', 'tasks.move', 'agent.ask', 'compute.run']);
/** Ops that confirm *every* time, because the payload is the decision: a
 *  file leaving the app's folder, or a change to your real calendar/mail.
 *  Remembering these would be remembering "yes to whatever it sends next". */
const CONFIRM_ALWAYS = new Set(['files.propose', 'connections.propose']);

/** What the confirm card says: a verb the user can weigh, and the actual
 *  payload — the whole reason this replaced window.confirm. */
function describe(m: Msg): { verb: string; payload: string } {
  const s = (k: string, cap: number) => String(m.args[k] ?? '').slice(0, cap);
  switch (m.op) {
    case 'agent.ask': return { verb: 'ask the agent a question', payload: s('prompt', 1_000) };
    case 'tasks.add': return { verb: 'file a task on the board', payload: s('title', 200) + (m.args.note ? `\n\n${s('note', 500)}` : '') };
    case 'tasks.move': return { verb: 'move a task on the board', payload: `task ${s('id', 40)} → ${s('status', 20)}` };
    case 'files.propose': return { verb: `save ${s('path', 120)} into the agent's folder`, payload: s('content', 4_000) };
    case 'connections.propose': return { verb: `change your connected ${s('provider', 40)} (${s('op', 40)})`, payload: JSON.stringify(m.args.payload ?? {}, null, 2).slice(0, 2_000) };
    case 'compute.run': return { verb: `run ${s('language', 20)} in the sandbox`, payload: s('code', 4_000) };
    default: return { verb: m.op, payload: JSON.stringify(m.args).slice(0, 800) };
  }
}

export function AppHost({ agentId, miniApp, style }: { agentId: string; miniApp: AgentApp; style?: React.CSSProperties }) {
  const app = useApp();
  const frame = useRef<HTMLIFrameElement>(null);
  // approvals the user granted this render's confirms ("remember for this app")
  const remembered = useRef(new Set<string>());
  // A denied confirm is not a "no" the app has to respect — it can loop and
  // re-prompt until the user clicks Allow out of fatigue
  // (docs/miniapp-capabilities.md, the nagging attack). Count denials and cut
  // the app off after a few, instead of relaying an unbounded prompt stream.
  const denials = useRef(0);
  const stable = useRef({ miniApp, app });
  stable.current = { miniApp, app };
  // Execution confirms render here, in our chrome. This was window.confirm,
  // which is unspoofable but cannot show what is actually being approved —
  // and "allow the agent to be asked something" is not a decision anyone can
  // make from the operation name alone.
  const [confirmReq, setConfirmReq] = useState<{ verb: string; payload: string; always: boolean; resolve: (ok: boolean) => void } | null>(null);

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const m = e.data as Msg;
      if (!m || m.__yaam !== true || e.source !== frame.current?.contentWindow) return;
      const { miniApp: ma, app: st } = stable.current;
      const reply = (result?: unknown, error?: string) =>
        frame.current?.contentWindow?.postMessage({ __yaam: true, id: m.id, result, error }, '*');

      const cap = ({
        'storage.get': 'storage', 'storage.set': 'storage',
        'files.list': 'files.read', 'files.read': 'files.read', 'files.write': 'files.write',
        'tasks.list': 'tasks.read', 'tasks.add': 'tasks.write', 'tasks.move': 'tasks.write',
        'chat.compose': 'chat.compose', 'agent.ask': 'agent.ask',
        'files.propose': 'files.write', 'files.watch': 'files.read',
        'llm.complete': 'llm', 'llm.stream': 'llm',
        'data.put': 'data', 'data.query': 'data', 'data.delete': 'data', 'sql.engine': 'data',
        'connections.list': 'connections', 'connections.read': 'connections', 'connections.propose': 'connections',
        'compute.run': 'compute', 'compute.status': 'compute',
      } as Record<string, string>)[m.op];

      try {
        if (cap && !(ma.approved ?? []).includes(cap)) {
          throw new Error(`capability "${cap}" is not activated for this app — the user can review it on the app card`);
        }
        // mutating ops confirm in our chrome — once per app, or every time
        // when the payload itself is what the user is approving
        const always = CONFIRM_ALWAYS.has(m.op);
        if ((always || CONFIRM_ONCE.has(m.op)) && (always || !remembered.current.has(m.op))) {
          if (denials.current >= MAX_DENIALS) {
            throw new Error('denied — this app asked too many times and is cut off until you reopen it');
          }
          const { verb, payload } = describe(m);
          const ok = await new Promise<boolean>((resolve) => setConfirmReq({ verb, payload, always, resolve }));
          setConfirmReq(null);
          if (!ok) {
            denials.current++;
            if (denials.current >= MAX_DENIALS) st.showToast(`"${ma.name}" kept asking after you said no — further requests are blocked`);
            throw new Error('denied by the user');
          }
          if (!always) remembered.current.add(m.op);
        }

        const ws = st.workspaceId || undefined;
        switch (m.op) {
          case 'storage.get': return reply((await api.appStorageGet(agentId, ma.id)).state);
          case 'storage.set': return reply(await api.appStoragePut(agentId, ma.id, m.args.state));
          case 'files.list': return reply(await api.appFilesList(agentId, ma.id, String(m.args.prefix ?? ''), ws));
          case 'files.read': return reply(await api.appFileRead(agentId, ma.id, String(m.args.path ?? ''), ws, num(m.args.offset)));
          case 'files.propose': return reply(await api.appFilePropose(agentId, ma.id, String(m.args.path ?? ''), String(m.args.content ?? '')));
          case 'files.watch': return reply(await api.appFilesWatch(agentId, ma.id, String(m.args.prefix ?? ''), typeof m.args.since === 'string' ? m.args.since : undefined, ws));
          case 'files.write': return reply(await api.appFileWrite(agentId, ma.id, String(m.args.path ?? ''), String(m.args.content ?? '')));
          case 'tasks.list': return reply(await api.appTasksList(agentId, ma.id));
          case 'tasks.add': return reply(await api.appTaskAdd(agentId, ma.id, String(m.args.title ?? ''), typeof m.args.note === 'string' ? m.args.note : undefined));
          case 'tasks.move': return reply(await api.appTaskMove(agentId, ma.id, String(m.args.id ?? ''), String(m.args.status ?? '')));
          case 'chat.compose': { await st.composeInChat(agentId, String(m.args.text ?? '')); return reply({ ok: true }); }
          case 'agent.ask': return reply(await api.appAsk(agentId, ma.id, String(m.args.prompt ?? ''), ws));
          case 'llm.complete':
            return reply(await api.appLlmComplete(agentId, ma.id, String(m.args.prompt ?? ''), m.args.schema, num(m.args.maxTokens)));
          case 'llm.stream': {
            // the frame has no network; the host streams and relays chunks
            const relay = (text: string) =>
              frame.current?.contentWindow?.postMessage({ __yaam: true, id: m.id, chunk: text }, '*');
            return reply(await appLlmStream(agentId, ma.id, String(m.args.prompt ?? ''), relay, num(m.args.maxTokens)));
          }
          case 'data.put': return reply(await api.appDataPut(agentId, ma.id, String(m.args.collection ?? ''), m.args.row));
          case 'data.query': {
            const { collection, ...q } = m.args;
            return reply(await api.appDataQuery(agentId, ma.id, String(collection ?? ''), q));
          }
          case 'data.delete': return reply(await api.appDataDelete(agentId, ma.id, String(m.args.collection ?? ''), String(m.args.id ?? '')));
          case 'sql.engine': return reply(await api.appSqlEngine(agentId, ma.id));
          case 'connections.list': return reply(await api.appConnections(agentId, ma.id));
          case 'connections.read':
            return reply(await api.appConnRead(agentId, ma.id, String(m.args.provider ?? 'google'), String(m.args.op ?? ''), m.args.params));
          case 'connections.propose':
            return reply(await api.appConnPropose(agentId, ma.id, String(m.args.provider ?? 'google'), String(m.args.op ?? ''), m.args.payload));
          case 'compute.status': return reply(await api.appComputeStatus(agentId, ma.id));
          case 'compute.run':
            return reply(await api.appComputeRun(agentId, ma.id, String(m.args.language ?? ''), String(m.args.code ?? ''),
              typeof m.args.stdin === 'string' ? m.args.stdin : undefined, num(m.args.timeoutSeconds)));
          case 'ui.theme': return reply({ theme: st.theme });
          case 'ui.toast': { st.showToast(String(m.args.text ?? '').slice(0, 120)); return reply({ ok: true }); }
          default: return reply(undefined, `unknown operation: ${m.op}`);
        }
      } catch (err) {
        reply(undefined, err instanceof Error ? err.message : String(err));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [agentId]);

  return (
    <>
      <iframe ref={frame} title={miniApp.name} sandbox="allow-scripts" srcDoc={CSP_META + SHIM + miniApp.html}
        style={{ flex: 1, width: '100%', border: 'none', background: '#fff', ...style }} />
      {confirmReq && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ width: 460, maxWidth: '100%', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
            <div style={{ padding: '18px 22px 12px', borderBottom: '1px solid var(--border-soft)' }}>
              <div style={{ fontSize: 15.5, fontWeight: 700 }}>Mini app wants to {confirmReq.verb}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
                Requested by “{miniApp.name}”, built by its agent. {confirmReq.always
                  ? 'This one is asked every time — you are approving this exact payload, not a standing permission.'
                  : 'Allowing remembers this until you close the app.'}
              </div>
            </div>
            <pre style={{ margin: 0, padding: '14px 22px', maxHeight: 260, overflow: 'auto', fontSize: 12, fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>
              {confirmReq.payload || '(no details)'}
            </pre>
            <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => confirmReq.resolve(false)} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '8px 15px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Deny</button>
              <button onClick={() => confirmReq.resolve(true)} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 17px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>Allow</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Activation review: the second gate. Per-capability, host-rendered. */
export function CapReviewModal({ agentId, miniApp, onClose }: { agentId: string; miniApp: AgentApp; onClose: () => void }) {
  const app = useApp();
  const pending = pendingCaps(miniApp);
  const [picked, setPicked] = useState<Set<string>>(new Set(pending));

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: '100%', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontSize: 15.5, fontWeight: 700 }}>Review capabilities — {miniApp.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
            Built by its agent, sandboxed, no network. These grants stay until the app is edited (edits park them again).
          </div>
        </div>
        <div style={{ padding: '14px 22px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pending.map((c) => (
            <label key={c} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 11px', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.has(c)} onChange={(e) => {
                setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c); else n.delete(c); return n; });
              }} style={{ marginTop: 2 }} />
              <span>
                <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--mono)' }}>{c}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-dim)', marginTop: 1 }}>{CAP_INFO[c]?.desc ?? c}</span>
              </span>
            </label>
          ))}
          {pending.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Nothing awaiting review.</div>}
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '8px 15px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={async () => {
            await api.approveAppCaps(agentId, miniApp.id, [...picked]);
            await app.refreshAgents();
            app.showToast(picked.size > 0 ? `Activated ${[...picked].join(', ')} for ${miniApp.name}` : 'No capabilities activated');
            onClose();
          }} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 17px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
            Activate selected
          </button>
        </div>
      </div>
    </div>
  );
}
