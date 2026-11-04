/** The project page's team block (docs/work-tracking.md "Project teams"):
 *  each member with its home unit, head, role and allocation; pending
 *  allocations wait on the member's head. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectTeam } from '../src/lib/api';
import { ProjectTeamBlock } from '../src/components/OrgRoadmapView';

afterEach(() => { cleanup(); });

const team: ProjectTeam = {
  projectId: 'p1', key: 'P-3', title: 'Enterprise pilot', lead: { agentId: 'pm', name: 'Pat' },
  channel: { id: 'c1', slug: 'p-p-3' }, standup: { cron: '0 9 * * 1-5', nextAt: null, lastAt: null },
  units: ['Sales', 'Engineering'],
  members: [
    { id: 'r1', kind: 'agent', agentId: 'e', humanId: null, name: 'Editor', title: 'Account Executive', role: 'account lead', allocation: 60, status: 'active', homeUnit: { id: 'u1', name: 'Sales', slug: 'sales' }, managerName: 'Writer', totalAllocation: 80, openTasks: 2, approvalId: null, joinedAt: '' },
    { id: 'r2', kind: 'agent', agentId: 's', humanId: null, name: 'Sam', title: 'Software Engineer', role: 'engineer', allocation: 40, status: 'pending', homeUnit: { id: 'u2', name: 'Engineering', slug: 'eng' }, managerName: 'Head of Engineering', totalAllocation: 40, openTasks: 0, approvalId: 'a1', joinedAt: '' },
  ],
};

describe('ProjectTeamBlock', () => {
  it('shows the cross-functional team with home units, heads, allocations and pending approvals', () => {
    render(<ProjectTeamBlock team={team} />);
    expect(screen.getByTestId('project-team').textContent).toMatch(/drawn from 2 departments: Sales, Engineering/);
    const rows = screen.getAllByTestId('project-team-member');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/Editor.*account lead.*60%.*home Sales · head Writer.*80% across projects · 2 open here/);
    expect(rows[1].getAttribute('data-status')).toBe('pending');
    expect(rows[1].textContent).toMatch(/pending head approval/);
    expect(screen.getByText(/#p-p-3 · standup 0 9 \* \* 1-5/)).toBeTruthy();
  });
});
