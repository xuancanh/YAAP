import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// No `globals: true` in vitest.config.ts, so RTL does not auto-clean between tests.
afterEach(cleanup);
import { VoiceChip } from '../src/components/VoiceChip';
import { fmtDuration, isAudioFile, pickAudioMime, voiceLabel } from '../src/lib/voice';

describe('voice helpers', () => {
  it('formats durations as m:ss and h:mm:ss', () => {
    expect(fmtDuration(0)).toBe('0:00');
    expect(fmtDuration(42)).toBe('0:42');
    expect(fmtDuration(725)).toBe('12:05');
    expect(fmtDuration(3723)).toBe('1:02:03');
    expect(fmtDuration(null)).toBe('0:00');
  });

  it('labels voice notes with the duration when known', () => {
    expect(voiceLabel(42)).toBe('Voice note · 0:42');
    expect(voiceLabel(null)).toBe('Voice note');
    expect(voiceLabel(0)).toBe('Voice note');
  });

  it('detects audio by type or extension (matches the server set)', () => {
    expect(isAudioFile({ name: 'clip.bin', type: 'audio/webm' })).toBe(true);
    expect(isAudioFile({ name: 'note.m4a', type: '' })).toBe(true);
    expect(isAudioFile({ name: 'song.MP3' })).toBe(true);
    expect(isAudioFile({ name: 'report.pdf', type: 'application/pdf' })).toBe(false);
  });

  it('picks webm/opus first, mp4 on Safari, null when nothing is supported', () => {
    expect(pickAudioMime((m) => m.startsWith('audio/webm'))).toEqual({ mime: 'audio/webm;codecs=opus', ext: 'webm' });
    expect(pickAudioMime((m) => m === 'audio/mp4')).toEqual({ mime: 'audio/mp4', ext: 'mp4' });
    expect(pickAudioMime(() => false)).toBeNull();
    expect(pickAudioMime(() => { throw new Error('no MediaRecorder'); })).toBeNull();
  });
});

describe('VoiceChip', () => {
  it('shows "Voice note · 0:42", the transcript on hover, and expands it on tap', () => {
    render(<VoiceChip durationSeconds={42} transcript="remind me to send the invoice" />);
    const chip = screen.getByRole('button', { name: /Voice note · 0:42/ });
    expect(screen.getByTestId('voice-chip-label')).toHaveTextContent('Voice note · 0:42');
    expect(chip).toHaveAttribute('title', 'remind me to send the invoice');
    expect(screen.queryByTestId('voice-chip-transcript')).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByTestId('voice-chip-transcript')).toHaveTextContent('remind me to send the invoice');
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(screen.queryByTestId('voice-chip-transcript')).toBeNull();
  });

  it('explains an unavailable transcript and still renders the note', () => {
    render(<VoiceChip durationSeconds={null} transcript={null} />);
    expect(screen.getByTestId('voice-chip-label')).toHaveTextContent('Voice note');
    fireEvent.click(screen.getByRole('button', { name: /Voice note/ }));
    expect(screen.getByTestId('voice-chip-transcript')).toHaveTextContent(/Transcription unavailable/);
  });

  it('remove button calls onRemove without toggling the transcript', () => {
    const onRemove = vi.fn();
    render(<VoiceChip durationSeconds={5} transcript="hi" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove voice note' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('voice-chip-transcript')).toBeNull();
  });
});
