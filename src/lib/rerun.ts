/** Why a Work log rerun did not start, in words (docs/work-log.md "Rerun").
 *  `status` is the dispatcher's word: a skip reason like 'skipped:closed',
 *  or a gate word like 'cap' or 'quiet'. */
const WHY: Record<string, string> = {
  closed: 'its task is already done or cancelled. Reopen the task to run it again.',
  paused: 'the company or this task\'s wakes are paused. Resume first.',
  busy: 'the task already has a run in progress.',
  member_inactive: 'the agent is paused or no longer an active member.',
  not_owner: 'the task is now assigned to someone else.',
  disabled: 'organization mode is off.',
  cap: 'the agent reached its daily run cap.',
  quiet: 'it is quiet hours for this workspace.',
  budget: 'the spend budget is used up.',
};

export function rerunRefusal(status: string, error?: string | null): string {
  if (error) return `The rerun did not start: ${error}`;
  const word = status.replace(/^skipped:/, '');
  return `The rerun did not start: ${WHY[word] ?? word.replace(/_/g, ' ')}`;
}
