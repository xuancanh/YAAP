/**
 * Placeholder shell — the real frontend design arrives later. This proves the
 * full round trip: workspace bootstrap → create chat → send a message → SSE
 * stream renders token by token.
 */
import { useEffect, useRef, useState } from 'react';
import { api, sendTurn, type ChatMessage, type ChatSession, type Workspace } from './lib/api';

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [chat, setChat] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState('');
  const [input, setInput] = useState('');
  const busy = useRef(false);

  useEffect(() => {
    api.workspaces().then(async (ws) => {
      setWorkspace(ws[0]);
      const chats = await api.chats(ws[0].id);
      const first = chats[0] ?? (await api.createChat(ws[0].id, 'First chat'));
      setChat(first);
      const t = await api.transcript(first.id);
      setMessages(t.messages);
    }).catch(() => setWorkspace(null));
  }, []);

  const send = async () => {
    if (!chat || !input.trim() || busy.current) return;
    busy.current = true;
    const text = input.trim();
    setInput('');
    try {
      await sendTurn(chat.id, text, (ev) => {
        if (ev.type === 'answer') setStreaming((s) => s + ev.text);
      });
      const t = await api.transcript(chat.id);
      setMessages(t.messages);
    } finally {
      setStreaming('');
      busy.current = false;
    }
  };

  return (
    <div className="shell">
      <header>
        <h1>YAAM Chat</h1>
        <span className="meta">{workspace ? `workspace: ${workspace.name}` : 'API offline'}</span>
      </header>
      <main>
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            <b>{m.role}</b>
            <p>{m.content}</p>
          </div>
        ))}
        {streaming && (
          <div className="msg msg-assistant">
            <b>assistant</b>
            <p>{streaming}</p>
          </div>
        )}
      </main>
      <footer>
        <textarea
          value={input}
          placeholder={chat ? 'Message…' : 'Connecting…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
        <button onClick={() => void send()} disabled={!chat}>Send</button>
      </footer>
    </div>
  );
}
