/** The role shown beside an agent's name (chat header, the chat rail,
 *  channel messages): its role title, left out when it only repeats the
 *  name ("Head of Engineering" named Head of Engineering). */
export function roleBeside(agent: { name: string; role?: string | null } | null | undefined): string {
  const role = (agent?.role ?? '').trim();
  if (!agent || !role) return '';
  const norm = (s: string) => s.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(role) === norm(agent.name) ? '' : role;
}
