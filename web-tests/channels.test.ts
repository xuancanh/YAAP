/** Group-chat helpers (docs/group-chat.md): the @mention autocomplete
 *  parser, thread grouping, deep links and channel-session detection. */
import { describe, expect, it } from 'vitest';
import { applyMention, channelHash, goalMentions, goalRefs, groupThreads, handleOf, initials, isChannelSession, liveInThread, mentionQuery, mentionSuggestions, messageMentionSpans, parseChannelHash } from '../src/lib/channels';

describe('agent-to-agent tags (mirror of server/src/groupchat/mentions.ts)', () => {
  const team = [
    { kind: 'agent' as const, id: 'lead', name: 'Tutor Lead' },
    { kind: 'agent' as const, id: 'eng', name: 'Tutor Engineer' },
    { kind: 'agent' as const, id: 'cos', name: 'Chief of staff' },
    { kind: 'agent' as const, id: 'duc', name: 'Đức Anh' },
    { kind: 'agent' as const, id: 'ming', name: '小明' },
  ];
  const tagged = (text: string, ids: string[] = team.map((m) => m.id)) =>
    messageMentionSpans(text, JSON.stringify(ids.map((id) => ({ kind: 'agent', id }))), team).map((s) => [text.slice(s.start, s.end), s.member.id]);

  it('resolves display names the way agents write them, longest name first, as the server does', () => {
    expect(tagged('**`@Tutor Lead`** and @Tutor Engineer: and `@Chief of staff`')).toEqual([['@Tutor Lead', 'lead'], ['@Tutor Engineer', 'eng'], ['@Chief of staff', 'cos']]);
    expect(tagged('@tutor-lead, @ChiefOfStaff')).toEqual([['@tutor-lead', 'lead'], ['@ChiefOfStaff', 'cos']]);
    expect(tagged('@Đức Anh ơi, @小明')).toEqual([['@Đức Anh', 'duc'], ['@小明', 'ming']]);
    expect(tagged('@tutor is ambiguous; a@Tutor Lead is an address')).toEqual([]);
    expect(tagged('```\n@Tutor Lead\n```')).toEqual([]);
  });

  it('chips only what the server resolved for that message', () => {
    expect(tagged('@Tutor Lead and @Tutor Engineer', ['eng'])).toEqual([['@Tutor Engineer', 'eng']]);
    expect(tagged('@Tutor Lead', [])).toEqual([]);
  });

  it('autocompletes names in any script and inserts a handle the server resolves', () => {
    expect(mentionQuery('hỏi @Đứ')).toEqual({ start: 4, filter: 'đứ' });
    expect(mentionSuggestions('đứ', team).map((m) => m.id)).toEqual(['duc']);
    expect(mentionSuggestions('小', team).map((m) => m.id)).toEqual(['ming']);
    expect(handleOf('Đức Anh')).toBe('duc-anh');
    expect(applyMention('@Đứ', 0, 3, 'Đức Anh').text).toBe('@duc-anh ');
    // a name with no Latin spelling is inserted as written
    expect(applyMention('@小', 0, 2, '小明').text).toBe('@小明 ');
  });

  it('draws a live reply in the thread it lands in, also when the tag was top level', () => {
    // a person tagged an agent at top level: the reply lands in that message's thread
    expect(liveInThread({ threadRootId: null, replyRootId: 'm1' }, 'm1')).toBe(true);
    // an agent tagged inside a thread
    expect(liveInThread({ threadRootId: 'm1', replyRootId: 'm1' }, 'm1')).toBe(true);
    expect(liveInThread({ threadRootId: 'm1' }, 'm1')).toBe(true);
    expect(liveInThread({ threadRootId: null, replyRootId: 'm2' }, 'm1')).toBe(false);
    expect(liveInThread({ threadRootId: null }, null)).toBe(false);
  });
});

const members = [
  { kind: 'agent' as const, id: 'a1', name: 'Scout' },
  { kind: 'agent' as const, id: 'a2', name: 'Research Lead' },
  { kind: 'human' as const, id: 'h1', name: 'Bob Jones' },
];

describe('mention autocomplete', () => {
  it('finds the @query at the caret and nowhere else', () => {
    expect(mentionQuery('hello @sc')).toEqual({ start: 6, filter: 'sc' });
    expect(mentionQuery('hello @')).toEqual({ start: 6, filter: '' });
    expect(mentionQuery('(@research-l')).toEqual({ start: 1, filter: 'research-l' });
    expect(mentionQuery('mail a@b.com')).toBeNull();
    expect(mentionQuery('hello @sc there', 9)).toEqual({ start: 6, filter: 'sc' });
    expect(mentionQuery('hello @sc there')).toBeNull();
    expect(mentionQuery('')).toBeNull();
  });

  it('ranks suggestions by handle prefix, then word prefix, then substring', () => {
    expect(mentionSuggestions('', members).map((m) => m.id)).toEqual(['h1', 'a2', 'a1']);
    expect(mentionSuggestions('sc', members).map((m) => m.id)).toEqual(['a1']);
    expect(mentionSuggestions('lead', members).map((m) => m.id)).toEqual(['a2']);
    expect(mentionSuggestions('jon', members).map((m) => m.id)).toEqual(['h1']);
    expect(mentionSuggestions('zzz', members)).toEqual([]);
  });

  it('applies a pick as @handle with a trailing space and moves the caret', () => {
    const q = mentionQuery('ask @res about it', 8)!;
    const out = applyMention('ask @res about it', q.start, 8, 'Research Lead');
    expect(out.text).toBe('ask @research-lead  about it');
    expect(out.caret).toBe('ask @research-lead '.length);
    expect(handleOf('Zoë Q. Álvarez')).toBe('zoe-q-alvarez');
    expect(initials('Bob Jones')).toBe('BJ');
    expect(initials('alice')).toBe('A');
  });
});

describe('thread grouping', () => {
  const m = (id: string, createdAt: string, threadRootId: string | null = null) => ({ id, createdAt, threadRootId });
  it('groups replies under their root in time order and keeps server counts for unloaded replies', () => {
    const rows = [m('r2', '2026-11-01T10:05:00Z'), m('x', '2026-11-01T10:06:00Z', 'r1'), m('r1', '2026-11-01T10:00:00Z'), m('y', '2026-11-01T10:01:00Z', 'r1'), m('orphan', '2026-11-01T09:00:00Z', 'gone')];
    const groups = groupThreads(rows, { r2: { count: 4, lastAt: '2026-11-01T11:00:00Z' } });
    expect(groups.map((g) => g.root.id)).toEqual(['r1', 'r2']);
    expect(groups[0].replies.map((r) => r.id)).toEqual(['y', 'x']);
    expect(groups[0].replyCount).toBe(2);
    expect(groups[0].lastReplyAt).toBe('2026-11-01T10:06:00Z');
    expect(groups[1].replies).toEqual([]);
    expect(groups[1].replyCount).toBe(4);
    expect(groups[1].lastReplyAt).toBe('2026-11-01T11:00:00Z');
  });
});

describe('deep links and channel sessions', () => {
  it('round-trips #/ws/<id>/channel/<slug>[/<messageId>]', () => {
    expect(parseChannelHash('#/ws/w1/channel/general')).toEqual({ workspaceId: 'w1', slug: 'general', messageId: null });
    expect(parseChannelHash('#/ws/w1/channel/product-launch/m-9')).toEqual({ workspaceId: 'w1', slug: 'product-launch', messageId: 'm-9' });
    expect(parseChannelHash('#/chat/s1')).toBeNull();
    expect(parseChannelHash('#/ws/w1/channel/Bad')).toBeNull();
    expect(channelHash('w1', 'general', 'm1')).toBe('#/ws/w1/channel/general/m1');
    expect(parseChannelHash(channelHash('w1', 'general'))).toEqual({ workspaceId: 'w1', slug: 'general', messageId: null });
  });
  it('hides the agents\' channel sessions from the DM list by name or tag', () => {
    expect(isChannelSession({ name: '#general · Scout', tags: '[]' })).toBe(true);
    expect(isChannelSession({ name: 'Planning', tags: '["channel"]' })).toBe(true);
    expect(isChannelSession({ name: '#hashtag chat', tags: '[]' })).toBe(false);
    expect(isChannelSession({ name: 'Telegram · Scout', tags: 'not json' })).toBe(false);
  });
});

describe('goal references (docs/group-chat.md §7)', () => {
  it('finds #goal:<id> tokens, deduplicated, ignoring short ids and glued text', () => {
    expect(goalRefs('see #goal:abcd1234 and #goal:abcd1234, then #goal:zzzz9999.')).toEqual(['abcd1234', 'zzzz9999']);
    expect(goalRefs('#goal:ab is too short; mail#goal:abcd is glued')).toEqual([]);
    expect(goalRefs('')).toEqual([]);
  });
  it('reads resolved goal mentions from a message and ignores the rest', () => {
    expect(goalMentions('[{"kind":"agent","id":"a1"},{"kind":"goal","id":"g1"}]')).toEqual(['g1']);
    expect(goalMentions('not json')).toEqual([]);
    expect(goalMentions('')).toEqual([]);
  });
});
