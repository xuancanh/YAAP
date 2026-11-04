/** Program management on screen (docs/work-tracking.md "Program management:
 *  the matrix"): the owner badge (a Program Manager, or the chief acting as
 *  one), a project's rhythms and resource requests, a goal's review line,
 *  the Direction card's health counts and People's members × projects
 *  matrix with the stretched total. */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProgramItem, ProgramMatrix } from '../src/lib/api';
import { GoalProgramLine, ProgramBlock, ProgramHealthCard, ProgramMatrixTable, ProgramOwnerBadge } from '../src/components/ProgramMatrixView';

afterEach(cleanup);

const soon = new Date(Date.now() + 86_400_000).toISOString();
const project: ProgramItem = {
  refType: 'project', id: 'p1', key: 'P-3', kind: 'project', title: 'Enterprise pilot', status: 'active', lane: 'now', health: 'on_track',
  owner: { agentId: 'pm', name: 'Pat', role: 'pm' },
  cadences: [
    { kind: 'sync', label: 'Project sync', cron: '0 9 * * 1,4', everyDays: 3.5, nextAt: soon, lastAt: null, enabled: true, stale: false },
    { kind: 'milestone_review', label: 'Milestone review', cron: '0 10 * * 3', everyDays: 7, nextAt: soon, lastAt: null, enabled: true, stale: true },
    { kind: 'status_update', label: 'Status update', cron: null, everyDays: 7, nextAt: soon, lastAt: null, enabled: true, stale: false },
  ],
  team: [{ agentId: 'e', name: 'Editor', role: 'account lead', allocation: 50, status: 'active', headName: 'Writer' }],
  requests: [{
    id: 'r1', projectId: 'p1', projectKey: 'P-3', projectTitle: 'Enterprise pilot', goalId: null, pmAgentId: 'pm', pmName: 'Pat', headAgentId: 'w', headName: 'Writer', unitName: 'Sales',
    role: 'analyst', skills: '', agentId: null, agentName: null, allocation: 30, startDate: null, endDate: null, budgetUsd: 0, why: 'pipeline data',
    status: 'open', decidedAgentId: null, decidedAgentName: null, decidedAllocation: null, decisionNote: '', decidedBy: '', decidedAt: null, approvalId: null, memberRowId: null,
    answerBy: soon, overdue: false, createdAt: '',
  }],
  links: [], stale: true,
};
const goal: ProgramItem = {
  ...project, refType: 'goal', id: 'g1', key: null, kind: 'objective', title: 'First paying cohort', lane: null, health: null,
  owner: { agentId: 'c', name: 'Chief', role: 'acting_chief' },
  cadences: [{ kind: 'goal_review', label: 'Goal review', cron: '0 10 * * 2', everyDays: 7, nextAt: soon, lastAt: null, enabled: true, stale: false }],
  team: [], requests: [], stale: false,
};
const matrix: ProgramMatrix = {
  pms: [{ agentId: 'pm', name: 'Pat', owns: 2 }], chiefActing: false, chiefName: 'Chief',
  items: [goal, project, { ...project, id: 'p2', key: 'P-4', title: 'Renewals', owner: { agentId: 'pm', name: 'Pat', role: 'pm' }, requests: [] }],
  members: [
    { agentId: 'e', name: 'Editor', title: 'Account Executive', lineManager: 'Writer', unitName: 'Sales', total: 90, stretched: true, isPm: false, isHead: false, owns: [],
      assignments: [{ projectId: 'p1', key: 'P-3', title: 'Enterprise pilot', role: 'account lead', allocation: 50, status: 'active', pmName: 'Pat' }, { projectId: 'p2', key: 'P-4', title: 'Renewals', role: 'analyst', allocation: 40, status: 'pending', pmName: 'Pat' }] },
    { agentId: 'pm', name: 'Pat', title: 'Program Manager', lineManager: 'Chief', unitName: null, total: 0, stretched: false, isPm: true, isHead: false, assignments: [], owns: [{ refType: 'project', id: 'p1', key: 'P-3', title: 'Enterprise pilot' }] },
    { agentId: 'x', name: 'Idle', title: 'Writer', lineManager: 'Chief', unitName: null, total: 0, stretched: false, isPm: false, isHead: false, assignments: [], owns: [] },
  ],
  requests: project.requests,
  health: { items: 3, unowned: 1, acting: 1, nonPm: 0, stretched: 1, staleCadences: 2, openRequests: 1, overdueRequests: 0 },
  bounds: { syncMinDays: 1, syncMaxDays: 7, reviewMinDays: 7, reviewMaxDays: 31, allocationWarnPct: 85, requestAnswerHours: 24 },
};

describe('program on screen', () => {
  it('names the owner: a Program Manager, the chief as acting PM, a warning when nobody owns it', () => {
    render(<><ProgramOwnerBadge owner={project.owner} /><ProgramOwnerBadge owner={goal.owner} /><ProgramOwnerBadge owner={{ agentId: null, name: 'nobody', role: 'none' }} /></>);
    const badges = screen.getAllByTestId('program-owner');
    expect(badges[0].textContent).toBe('Pat · Program Manager');
    expect(badges[1].textContent).toBe('Chief · acting PM');
    expect(badges[2].textContent).toBe('No owner');
  });

  it('the project block shows the rhythms with their next occurrence and stale marker, and the requests waiting on heads', () => {
    render(<ProgramBlock item={project} />);
    const rows = screen.getAllByTestId('program-cadence');
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['sync', 'milestone_review', 'status_update']);
    expect(rows[0].textContent).toMatch(/Project sync.*0 9 \* \* 1,4.*next/);
    expect(rows[1].getAttribute('data-stale')).toBe('1');
    expect(rows[1].textContent).toMatch(/stale/);
    const req = screen.getByTestId('program-request');
    expect(req.textContent).toMatch(/analyst.*30%.*open.*head Writer · answer by/);
  });

  it('a goal shows its owner role and its review rhythm', () => {
    render(<GoalProgramLine item={goal} />);
    expect(screen.getByTestId('goal-program').textContent).toMatch(/Chief · acting PM.*Goal review · next/);
  });

  it('the Direction card counts the matrix health and lists the PMs', () => {
    render(<ProgramHealthCard matrix={matrix} />);
    const card = screen.getByTestId('dash-card-program');
    expect(card.textContent).toMatch(/Program Managers: Pat \(2\)/);
    expect(within(card).getByTestId('program-fig-unowned').textContent).toBe('1unowned');
    expect(within(card).getByTestId('program-fig-acting').textContent).toBe('1chief acting');
    expect(within(card).getByTestId('program-fig-stretched').textContent).toBe('1stretched');
    expect(within(card).getByTestId('program-fig-stale').textContent).toBe('2stale rhythms');
    expect(within(card).getByTestId('program-fig-requests').textContent).toBe('1open requests');
  });

  it('the matrix: members × projects with allocations, the line manager, a stretched total; members with no stake are left out', () => {
    render(<ProgramMatrixTable matrix={matrix} />);
    const rows = screen.getAllByTestId('program-matrix-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-stretched')).toBe('1');
    expect(rows[0].textContent).toMatch(/Editor.*Writer.*50%.*40%.*90% · stretched/);
    expect(rows[1].textContent).toMatch(/Pat.*Chief.*PM/);
    expect(screen.getByTestId('program-matrix').textContent).toMatch(/P-3.*P-4/);
  });
});
