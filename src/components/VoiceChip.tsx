/** Voice-note attachment chip (docs/voice.md): "Voice note · 0:42" with the
 *  transcript on hover (title) and on tap (expand), plus an optional remove
 *  button. Kept free of store access so it renders in isolation. */
import { useState } from 'react';
import { I, P } from '../lib/icons';
import { voiceLabel } from '../lib/voice';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

export function VoiceChip({ durationSeconds, transcript, onRemove, align = 'left' }: {
  durationSeconds?: number | null;
  /** null/undefined = transcription unavailable (the note still sends). */
  transcript?: string | null;
  onRemove?: () => void;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const label = voiceLabel(durationSeconds);
  const preview = transcript?.trim() || '';
  const hint = preview ? preview : 'Transcription unavailable — the audio still sends.';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'right' ? 'flex-end' : 'flex-start', maxWidth: '100%' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${label}. ${preview ? 'Tap to show the transcript' : 'Transcription unavailable'}`}
        title={hint}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--panel-2)', border: `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8, padding: '7px 10px', minHeight: 32, fontSize: 11.5, color: 'var(--text-dim)', cursor: 'pointer', ...mono }}>
        <I d={P.mic} size={13} stroke={preview ? 'var(--accent-hi)' : 'var(--text-faint)'} />
        <span data-testid="voice-chip-label">{label}</span>
        {onRemove && (
          <button
            type="button"
            aria-label="Remove voice note"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 4, margin: -4, display: 'flex' }}>
            <I d={P.x} size={12} />
          </button>
        )}
      </div>
      {open && (
        <div data-testid="voice-chip-transcript" style={{ marginTop: 5, maxWidth: 420, fontSize: 12, lineHeight: 1.5, color: preview ? 'var(--text-dim)' : 'var(--text-faint)', background: 'var(--panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '7px 10px', whiteSpace: 'pre-wrap', fontStyle: preview ? 'normal' : 'italic' }}>
          {hint}
        </div>
      )}
    </div>
  );
}
