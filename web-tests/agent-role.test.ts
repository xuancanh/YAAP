/** The role beside an agent's name (src/lib/agent-role.ts). */
import { describe, expect, it } from 'vitest';
import { roleBeside } from '../src/lib/agent-role';

describe('roleBeside', () => {
  it('shows the role when it says something the name does not', () => {
    expect(roleBeside({ name: 'Bảo', role: 'Software Engineer' })).toBe('Software Engineer');
    expect(roleBeside({ name: 'Trạng Tí', role: 'Chief of staff' })).toBe('Chief of staff');
  });
  it('leaves it out when it repeats the name, or is empty', () => {
    expect(roleBeside({ name: 'Head of Engineering', role: 'Head of Engineering' })).toBe('');
    expect(roleBeside({ name: 'Content Marketer', role: 'Content Marketer (Marketing)' })).toBe('');
    expect(roleBeside({ name: 'Ada', role: '' })).toBe('');
    expect(roleBeside(null)).toBe('');
  });
});
