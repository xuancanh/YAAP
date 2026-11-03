/**
 * Sub-channel tunables (docs/group-chat.md §9): how long an idle discussion
 * stays open, how many an agent may start, how many may be open under one
 * channel, and what the runtime does when agents go back and forth in a
 * parent channel's thread. Registered on the shared registry of
 * `org-tunables.ts`, so `org_tune` and `PUT …/org/tunables` reach them and
 * each workspace shapes them to how it works (`deriveDiscussionTunables`,
 * called by chief-os.ts `deriveOperatingSystem`, reads the operating
 * profile). Workspaces without an organization read the defaults. The
 * bounds are the fence.
 */
import type { ProfileDiagnosis } from '../org/chief-os';
import { registerTunables, tunable, type TunableDef } from '../org/org-tunables';

export const DISCUSSION_TUNABLES: Record<string, TunableDef> = {
  'discussion.autoCloseHours': { default: 24, min: 0, max: 720, area: 'chat', description: 'Hours without a message after which an open discussion sub-channel closes itself (read-only, folded into the parent\'s past discussions; people may reopen it); 0 never closes one automatically. Meetings close when they end.' },
  'discussion.agentDailyCap': { default: 3, min: 0, max: 20, area: 'chat', description: 'Discussions one agent may start per day with channel_start_discussion (0: agents start none; people are not limited).' },
  'discussion.openPerChannel': { default: 6, min: 1, max: 30, area: 'chat', description: 'Open discussions one channel may hold at a time; another waits until one closes.' },
  'discussion.autoMoveReplies': { default: 3, min: 1, max: 3, area: 'chat', description: 'Agent-to-agent replies in one thread of a channel (since the last person spoke) at which the runtime acts on the ping-pong — see discussion.autoMoveMode. Never above the three-round chain cap.' },
  'discussion.autoMoveMode': { default: 1, min: 0, max: 2, area: 'chat', description: 'What the runtime does when agents ping-pong in a channel thread: 0 nothing (the chain cap pauses it), 1 suggest moving it into a discussion (a line in the thread), 2 move it — open a discussion sub-channel with the thread\'s participants, post its link card, and continue there under the same wake rules and loop caps.' },
};
registerTunables(DISCUSSION_TUNABLES);

export function discussionTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof DISCUSSION_TUNABLES): number {
  return tunable(org, key);
}

/** The discussion tunables shaped by the operating profile (a heuristic,
 *  stated as one): a fast company closes idle discussions sooner and lets
 *  the runtime move an agent ping-pong out of the channel; a control- or
 *  writing-minded one keeps discussions open longer and only suggests. Pure. */
export function deriveDiscussionTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor' | 'writing'>): Array<{ key: string; value: number; why: string }> {
  const formal = d.rigor || d.cultureType === 'hierarchy';
  return [
    { key: 'discussion.autoCloseHours', value: d.speed ? 12 : formal || d.writing ? 72 : 24, why: d.speed ? 'speed is a value: an idle discussion closes after half a day' : formal || d.writing ? 'discussions stay open three days so written threads can mature' : 'an idle discussion closes after a day' },
    { key: 'discussion.autoMoveMode', value: d.speed || d.cultureType === 'adhocracy' ? 2 : 1, why: d.speed || d.cultureType === 'adhocracy' ? 'a back-and-forth between agents moves into its own discussion and the channel stays clean' : 'the runtime suggests a discussion when agents go back and forth; a person decides' },
    { key: 'discussion.agentDailyCap', value: d.stage === 'early' || formal ? 2 : 3, why: d.stage === 'early' || formal ? 'few discussions: a small or formal company keeps conversation in its channels' : 'three agent-started discussions a day per agent' },
  ];
}
