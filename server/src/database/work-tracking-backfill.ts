/**
 * The work-tracking backfill (migration 0060, docs/work-tracking.md
 * "Migration"). Pure SQL over a pg-shaped `query()`, idempotent — every step
 * touches only rows it has not touched before — so it is safe to run again:
 *
 *  1. projects: a `P-<n>` key, `goalIds` from `goalId`, a unit, the Now lane
 *     for the active ones; per live unit the two system projects — Unsorted
 *     (orphans) and Operating improvements (retro and postmortem actions);
 *  2. tasks: a `source` (escalation child, meeting or retro thread, the CEO,
 *     a chat, the chief's planning, an agent), a project for every orphan
 *     (retro work → Operating improvements, the rest → Unsorted), one
 *     structured `blockedOn` for every blocked task from the five legacy
 *     forms (blocker lines, a pending CEO card, the latest comment);
 *  3. transitions: the status history rebuilt from the audit log
 *     (task_create, task_update{status}, task_claim, task_assign,
 *     review_request, review_accept, review_request_changes, task_escalate,
 *     task_unblocked), then `startedAt` / `doneAt`;
 *  4. the kanban merge: every company member's open kanban item becomes a
 *     checklist step on the org task it mirrors (its key in the note, or a
 *     similar title on one of the member's tasks), or else an org task of
 *     its own under the member's unit, keeping its key. The kanban row is
 *     kept and marked `mergedInto`, so nothing is lost and it never merges
 *     twice. Personal agents (no company) keep their board.
 */
import { legacyBlockedOn, serializeBlockedOn, type BlockedOn } from '../org/blocked-on';
import { MIRROR_SIMILARITY, SYSTEM_PROJECT_TITLES, nextStepId, parseSteps, titleSimilarity, type TaskStep } from '../org/work-model';

export interface BackfillQueryable { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const list = (raw: unknown): string[] => { try { const v = JSON.parse(s(raw) || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
const obj = (raw: unknown): Record<string, unknown> => { try { const v = JSON.parse(s(raw) || '{}') as unknown; return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; } catch { return {}; } };
const rid = (seed: string) => `${seed}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export interface WorkBackfillResult { projects: number; systemProjects: number; sources: number; placed: number; blocked: number; transitions: number; merged: { tasks: number; steps: number } }

export async function backfillWorkTracking(db: BackfillQueryable, now = new Date().toISOString()): Promise<WorkBackfillResult> {
  const out: WorkBackfillResult = { projects: 0, systemProjects: 0, sources: 0, placed: 0, blocked: 0, transitions: 0, merged: { tasks: 0, steps: 0 } };
  const orgs = (await db.query(`SELECT "id", "accountId", "chiefOfStaffAgentId", "workspaceId" FROM organizations WHERE "status" <> 'archived'`)).rows as Row[];
  for (const org of orgs) {
    const orgId = s(org.id); const accountId = s(org.accountId) || 'single';
    const units = (await db.query(`SELECT "id", "leadAgentId", "parentUnitId" FROM org_units WHERE "orgId" = $1 AND "archivedAt" IS NULL`, [orgId])).rows as Row[];
    const root = units.find((u) => !u.parentUnitId) ?? null;
    const members = (await db.query(`SELECT "agentId", "reportsToAgentId", "status" FROM org_members WHERE "orgId" = $1`, [orgId])).rows as Row[];
    const managerOf = new Map(members.map((m) => [s(m.agentId), s(m.reportsToAgentId) || null]));
    const unitOfLead = new Map(units.map((u) => [s(u.leadAgentId), s(u.id)]));
    /** The default rule: the unit led by the agent's nearest unit-leading manager; the root otherwise. */
    const unitFor = (agentId: string | null): string | null => {
      let cur = agentId ? managerOf.get(agentId) ?? null : null;
      for (let i = 0; cur && i < 10; i++) { const u = unitOfLead.get(cur); if (u) return u; cur = managerOf.get(cur) ?? null; }
      return root ? s(root.id) : null;
    };

    // ---- 1. projects ----
    const projects = (await db.query(`SELECT * FROM org_projects WHERE "orgId" = $1 ORDER BY "createdAt" ASC, "id" ASC`, [orgId])).rows as Row[];
    let n = projects.reduce((m, p) => Math.max(m, Number(/^P-(\d+)$/.exec(s(p.key))?.[1] ?? 0)), 0);
    for (const p of projects.filter((x) => !x.key)) {
      const goalIds = list(p.goalIds).length ? list(p.goalIds) : p.goalId ? [s(p.goalId)] : [];
      const unitId = s(p.unitId) || (p.ownerAgentId ? unitOfLead.get(s(p.ownerAgentId)) ?? unitFor(s(p.ownerAgentId)) : root ? s(root.id) : null);
      const lane = s(p.status) === 'active' ? 'now' : s(p.lane) || 'later';
      await db.query(`UPDATE org_projects SET "key" = $2, "goalIds" = $3, "unitId" = $4, "lane" = $5, "updatedAt" = COALESCE("updatedAt", $6) WHERE "id" = $1`, [p.id, `P-${++n}`, JSON.stringify(goalIds), unitId, lane, now]);
      out.projects++;
    }
    const systemOf = new Map<string, string>(); // `${unitId}:${kind}` → project id
    for (const p of (await db.query(`SELECT "id", "unitId", "kind" FROM org_projects WHERE "orgId" = $1 AND "kind" IN ('unsorted', 'operating')`, [orgId])).rows as Row[]) systemOf.set(`${s(p.unitId)}:${s(p.kind)}`, s(p.id));
    for (const u of units) {
      for (const kind of ['unsorted', 'operating'] as const) {
        if (systemOf.has(`${s(u.id)}:${kind}`)) continue;
        const id = rid('proj');
        await db.query(
          `INSERT INTO org_projects ("id", "accountId", "orgId", "key", "goalId", "goalIds", "title", "status", "ownerAgentId", "unitId", "kind", "brief", "milestones", "lane", "createdBy", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, NULL, '[]', $5, 'active', $6, $7, $8, $9, '[]', 'now', 'system', $10, $10)`,
          [id, accountId, orgId, `P-${++n}`, SYSTEM_PROJECT_TITLES[kind], s(u.leadAgentId) || null, s(u.id), kind,
            JSON.stringify(kind === 'unsorted'
              ? { problem: 'Tasks that arrived without a project.', hypothesis: '', done_when: 'Empty: every task here is placed under the project it serves (or closed) within the orphan grace.', mvp: '' }
              : { problem: 'Retro and postmortem actions: work about how the company works.', hypothesis: 'A few chosen improvements at a time beat a long list of unpicked ones.', done_when: 'Each action is done, or expired and dropped.', mvp: '' }),
            now],
        );
        systemOf.set(`${s(u.id)}:${kind}`, id);
        out.systemProjects++;
      }
    }
    const systemProject = (unitId: string | null, kind: 'unsorted' | 'operating') => systemOf.get(`${unitId ?? ''}:${kind}`) ?? (root ? systemOf.get(`${s(root.id)}:${kind}`) ?? null : null);

    // ---- 2. tasks: source, project, blockedOn ----
    const meetings = (await db.query(`SELECT "id", "kind", "threadRootId" FROM org_meetings WHERE "orgId" = $1`, [orgId]).catch(() => ({ rows: [] as unknown[] }))).rows as Row[];
    const meetingKindByThread = new Map(meetings.filter((m) => m.threadRootId).map((m) => [s(m.threadRootId), s(m.kind)]));
    const tasks = (await db.query(`SELECT * FROM org_tasks WHERE "orgId" = $1 ORDER BY "createdAt" ASC`, [orgId])).rows as Row[];
    for (const t of tasks) {
      if (s(t.source) === '') {
        const by = s(t.createdBy);
        const mk = t.messageId ? meetingKindByThread.get(s(t.messageId)) : undefined;
        const source = t.parentTaskId && s(t.title).startsWith('Escalation:') ? 'escalation'
          : mk ? (mk === 'retro' ? 'retro' : 'meeting')
          : by === 'user' || by.startsWith('human:') ? (t.channelId ? 'chat' : 'ceo')
          : by === 'chief' || by === 'approval' ? 'plan'
          : t.channelId ? 'chat' : 'agent';
        await db.query(`UPDATE org_tasks SET "source" = $2 WHERE "id" = $1`, [t.id, source]);
        t.source = source;
        out.sources++;
      }
      if (!t.unitId && root) { await db.query(`UPDATE org_tasks SET "unitId" = $2 WHERE "id" = $1`, [t.id, s(root.id)]); t.unitId = s(root.id); }
      if (!t.projectId) {
        const pid = systemProject(s(t.unitId) || null, s(t.source) === 'retro' ? 'operating' : 'unsorted');
        if (pid) { await db.query(`UPDATE org_tasks SET "projectId" = $2 WHERE "id" = $1`, [t.id, pid]); t.projectId = pid; out.placed++; }
      }
    }
    const pendingCards = (await db.query(`SELECT "id", "payload" FROM org_approvals WHERE "orgId" = $1 AND "kind" = 'escalation' AND "status" = 'pending'`, [orgId])).rows as Row[];
    const cardOf = (taskId: string) => s(pendingCards.find((a) => s(obj(a.payload).taskId) === taskId)?.id) || null;
    const agentNames = (await db.query(`SELECT "id", "name" FROM agents WHERE "accountId" = $1`, [accountId])).rows as Row[];
    const byRef = (ref: string): string | null => {
      const q = ref.trim();
      const hit = tasks.find((x) => s(x.id) === q || (q.length >= 8 && s(x.id).startsWith(q)) || (x.key && s(x.key).toUpperCase() === q.toUpperCase()));
      return hit ? s(hit.id) : null;
    };
    for (const t of tasks.filter((x) => s(x.status) === 'blocked' && !s(x.blockedOn))) {
      const comment = ((await db.query(`SELECT "text" FROM org_messages WHERE "taskId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [t.id])).rows[0] as Row | undefined)?.text;
      const b: BlockedOn = legacyBlockedOn({
        lines: list(t.blockers), comment: comment ? s(comment) : null, pendingCard: cardOf(s(t.id)), since: s(t.updatedAt) || now,
        agentByName: (name) => s(agentNames.find((a) => s(a.name).toLowerCase() === name.trim().toLowerCase())?.id) || null,
        managerId: t.assigneeAgentId ? managerOf.get(s(t.assigneeAgentId)) ?? null : null,
        taskByRef: byRef,
      });
      // A block on the CEO written only in text never reached Needs you: give it its card now.
      if (b.kind === 'ceo' && !b.ref) {
        const cardId = rid('appr');
        await db.query(`INSERT INTO org_approvals ("id", "accountId", "orgId", "kind", "payload", "requestedBy", "recommendation", "status", "createdAt") VALUES ($1, $2, $3, 'escalation', $4, 'migration', '', 'pending', $5)`,
          [cardId, accountId, orgId, JSON.stringify({ taskId: t.id, taskKey: t.key ?? null, title: t.title, reason: b.reason, ownerAgentId: org.chiefOfStaffAgentId ?? null, assigneeAgentId: t.assigneeAgentId ?? null, projectId: t.projectId ?? null }), now]);
        b.ref = cardId;
      }
      await db.query(`UPDATE org_tasks SET "blockedOn" = $2 WHERE "id" = $1`, [t.id, serializeBlockedOn(b)]);
      out.blocked++;
    }

    // ---- 3. transitions from the audit log ----
    const withHistory = new Set(((await db.query(`SELECT DISTINCT "taskId" FROM task_transitions WHERE "orgId" = $1`, [orgId])).rows as Row[]).map((r) => s(r.taskId)));
    const audit = (await db.query(`SELECT "actor", "action", "refId", "payload", "createdAt" FROM org_audit WHERE "orgId" = $1 AND "refType" = 'task' ORDER BY "seq" ASC`, [orgId])).rows as Row[];
    const byTask = new Map<string, Row[]>();
    for (const r of audit) { const l = byTask.get(s(r.refId)) ?? []; l.push(r); byTask.set(s(r.refId), l); }
    for (const t of tasks) {
      if (withHistory.has(s(t.id))) continue;
      const rows = byTask.get(s(t.id)) ?? [];
      let cur = '';
      const steps: Array<{ to: string; actor: string; at: string }> = [];
      const push = (to: string, actor: string, at: string) => { if (to && to !== cur) { steps.push({ to, actor, at }); cur = to; } };
      for (const r of rows) {
        const p = obj(r.payload);
        const at = s(r.createdAt); const actor = s(r.actor);
        switch (s(r.action)) {
          case 'task_create': push(s(p.status) || 'backlog', actor, at); break;
          case 'task_update': if (typeof p.status === 'string') push(p.status, actor, at); break;
          case 'task_claim': push('claimed', actor, at); break;
          case 'task_assign': push(p.waiting ? 'waiting' : 'todo', actor, at); break;
          case 'task_assign_human': push('todo', actor, at); break;
          case 'review_request': push('in_review', actor, at); break;
          case 'review_accept': push('done', actor, at); break;
          case 'review_request_changes': push('todo', actor, at); break;
          case 'task_escalate': push('blocked', actor, at); break;
          case 'task_unblocked': push(s(p.status) || 'todo', actor, at); break;
          default: break;
        }
      }
      if (steps.length === 0) steps.push({ to: s(t.status), actor: s(t.createdBy), at: s(t.createdAt) });
      // The row's status is the truth: close the history on it.
      if (cur !== s(t.status) && steps.at(-1)!.to !== s(t.status)) steps.push({ to: s(t.status), actor: 'migration', at: s(t.updatedAt) || now });
      let from = '';
      for (const st of steps) {
        await db.query(`INSERT INTO task_transitions ("id", "accountId", "orgId", "taskId", "fromStatus", "toStatus", "actor", "reason", "backfilled", "at") VALUES ($1, $2, $3, $4, $5, $6, $7, '', 1, $8)`,
          [rid('tt'), accountId, orgId, t.id, from, st.to, st.actor, st.at]);
        from = st.to;
        out.transitions++;
      }
      const started = steps.find((x) => ['claimed', 'in_progress', 'in_review', 'done'].includes(x.to))?.at ?? null;
      const done = s(t.status) === 'done' ? steps.filter((x) => x.to === 'done').at(-1)?.at ?? s(t.updatedAt) : null;
      await db.query(`UPDATE org_tasks SET "startedAt" = COALESCE("startedAt", $2), "doneAt" = COALESCE("doneAt", $3) WHERE "id" = $1`, [t.id, started, done]);
    }

    // ---- 4. the kanban merge (company members only) ----
    const active = members.filter((m) => s(m.status) === 'active' || s(m.status) === 'paused').map((m) => s(m.agentId));
    for (const agentId of active) {
      const items = (await db.query(`SELECT * FROM agent_tasks WHERE "agentId" = $1 AND "mergedInto" IS NULL ORDER BY "createdAt" ASC`, [agentId])).rows as Row[];
      if (items.length === 0) continue;
      const mine = (await db.query(`SELECT "id", "key", "title", "steps", "status" FROM org_tasks WHERE "orgId" = $1 AND "assigneeAgentId" = $2`, [orgId, agentId])).rows as Row[];
      for (const k of items) {
        const text = `${s(k.title)} ${s(k.note)}`;
        const byKey = mine.find((m) => m.key && new RegExp(`(^|[^\\w-])${s(m.key)}(?![\\w-])`, 'i').test(text));
        const best = byKey ?? mine.map((m) => ({ m, sim: titleSimilarity(s(k.title), s(m.title)) })).filter((x) => x.sim >= MIRROR_SIMILARITY).sort((a, b) => b.sim - a.sim)[0]?.m;
        if (best) {
          const steps = parseSteps(s(best.steps));
          if (!steps.some((x) => x.from === s(k.key) && s(k.key))) {
            const step: TaskStep = { id: nextStepId(steps), text: s(k.title).slice(0, 300), done: s(k.status) === 'done' || s(k.status) === 'abandoned', ...(s(k.status) === 'done' ? { doneAt: s(k.updatedAt) } : {}), ...(s(k.status) === 'abandoned' ? { dropped: true } : {}), ...(k.key ? { from: s(k.key) } : {}) };
            steps.push(step);
            await db.query(`UPDATE org_tasks SET "steps" = $2 WHERE "id" = $1`, [best.id, JSON.stringify(steps)]);
            best.steps = JSON.stringify(steps);
          }
          await db.query(`UPDATE agent_tasks SET "mergedInto" = $2 WHERE "id" = $1`, [k.id, `step:${s(best.id)}`]);
          out.merged.steps++;
          continue;
        }
        const unitId = unitFor(agentId);
        const status = ({ todo: 'todo', doing: 'in_progress', blocked: 'blocked', done: 'done', abandoned: 'cancelled' } as Record<string, string>)[s(k.status)] ?? 'todo';
        const reason = (/(Blocked|Abandoned) \([0-9-]+\): ([^\n]*)\s*$/.exec(s(k.note))?.[2] ?? '').trim();
        const blockedOn = status === 'blocked' ? serializeBlockedOn(legacyBlockedOn({ lines: reason ? [reason] : [], since: s(k.updatedAt) || now })) : '';
        const id = rid('task');
        const key = k.key ? s(k.key) : null;
        const clash = key ? (await db.query(`SELECT 1 FROM org_tasks WHERE "orgId" = $1 AND "key" = $2`, [orgId, key])).rows.length > 0 : false;
        await db.query(
          `INSERT INTO org_tasks ("id", "accountId", "orgId", "key", "projectId", "parentTaskId", "title", "brief", "status", "assigneeAgentId", "blockers", "fileScope", "createdBy", "channelId", "messageId", "unitId", "unitExplicit", "class", "checks", "acceptedBy", "dependsOn", "source", "blockedOn", "steps", "startedAt", "doneAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, '[]', $11, $12, $13, $14, 0, 'general', '[]', '', '[]', $15, $16, '[]', $17, $18, $19, $20)`,
          [id, accountId, orgId, clash ? null : key, systemProject(unitId, 'unsorted'), s(k.title).slice(0, 200),
            JSON.stringify({ outcome: s(k.title).slice(0, 400), context: `From ${s(k.origin) === 'user' ? 'the CEO' : 'the member'}'s kanban board${key ? ` (${key})` : ''}.${k.note ? ` Note: ${s(k.note).slice(0, 1_500)}` : ''}`, constraints: '', done_when: '' }),
            status, agentId, reason && status === 'blocked' ? JSON.stringify([reason.slice(0, 300)]) : '[]', s(k.origin) === 'user' ? 'user' : `agent:${agentId}`,
            k.channelId ?? null, k.messageId ?? null, unitId, s(k.origin) === 'user' ? 'ceo' : k.channelId ? 'chat' : 'agent', blockedOn,
            status === 'in_progress' || status === 'done' ? s(k.updatedAt) : null, status === 'done' ? s(k.updatedAt) : null, s(k.createdAt) || now, s(k.updatedAt) || now],
        );
        await db.query(`INSERT INTO task_transitions ("id", "accountId", "orgId", "taskId", "fromStatus", "toStatus", "actor", "reason", "backfilled", "at") VALUES ($1, $2, $3, $4, '', $5, 'migration', 'merged from the kanban board', 1, $6)`, [rid('tt'), accountId, orgId, id, status, s(k.updatedAt) || now]);
        await db.query(`UPDATE agent_tasks SET "mergedInto" = $2 WHERE "id" = $1`, [k.id, `task:${id}`]);
        mine.push({ id, key, title: k.title, steps: '[]', status });
        out.merged.tasks++;
      }
    }
  }
  return out;
}
