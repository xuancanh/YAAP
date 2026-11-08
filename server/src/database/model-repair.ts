/**
 * Model repair (docs/agent-types.md "Backfill"), run on every boot after the
 * migrations: an agent — or a chat session with a pinned model — whose model
 * its agent type does not serve moves to the type's default model. The type
 * is resolved the way a turn resolves it (TurnContextService.typeFor): the
 * session's own type, the agent's enabled type, an enabled type of the
 * agent's provider (the account default first), the account default, the
 * first enabled type. Echo types and rows with no resolvable type are left
 * alone, as is a model of no recognisable family on a type with no list
 * (model-resolution.ts isKnownModel). Plain reads + targeted UPDATEs across
 * every account; idempotent (a repaired row is known on the next boot).
 */
import type { Queryable } from './migrator';
import { declaredFamily, isKnownModel, modelFamily } from '../agent-types/model-resolution';
import { presetForFamily } from '../agent-types/provider-presets';

interface TypeRow { id: string; accountId: string; name: string; provider: string; model: string; models: string; baseUrl: string | null; tierModels: string | null; enabled: number; createdAt: string }
interface AgentRow { id: string; accountId: string; provider: string; model: string; agentTypeId: string | null }
interface SessionRow { id: string; accountId: string; agentId: string | null; agentTypeId: string | null; model: string }

async function hasTable(db: Queryable, table: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return r.rows.length > 0;
}

export async function repairAgentModels(db: Queryable): Promise<{ agents: number; sessions: number }> {
  if (!(await hasTable(db, 'agent_types')) || !(await hasTable(db, 'agents'))) return { agents: 0, sessions: 0 };
  const types = (await db.query(`SELECT "id", "accountId", "name", "provider", "model", "models", "baseUrl", "tierModels", "enabled", "createdAt" FROM agent_types ORDER BY "createdAt" ASC, "id" ASC`)).rows as TypeRow[];
  if (types.length === 0) return { agents: 0, sessions: 0 };
  const defaults = new Map(((await db.query(`SELECT "accountId", "value" FROM app_settings WHERE "key" = 'defaultAgentTypeId'`)).rows as Array<{ accountId: string; value: string }>).map((r) => [r.accountId, r.value]));
  const byId = new Map(types.map((t) => [t.id, t]));
  const enabledOf = (accountId: string) => types.filter((t) => t.accountId === accountId && t.enabled === 1);

  const agentType = (a: Pick<AgentRow, 'accountId' | 'provider' | 'agentTypeId'>): TypeRow | undefined => {
    const own = a.agentTypeId ? byId.get(a.agentTypeId) : undefined;
    if (own && own.enabled === 1 && own.accountId === a.accountId) return own;
    const enabled = enabledOf(a.accountId);
    const def = defaults.get(a.accountId);
    const byProvider = enabled.find((t) => t.provider === a.provider && t.id === def) ?? enabled.find((t) => t.provider === a.provider);
    return byProvider ?? enabled.find((t) => t.id === def) ?? enabled[0];
  };

  let agentsFixed = 0;
  const agents = (await db.query(`SELECT "id", "accountId", "provider", "model", "agentTypeId" FROM agents`)).rows as AgentRow[];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  for (const a of agents) {
    if (!a.model) continue;
    const t = agentType(a);
    if (!t || t.provider === 'echo' || isKnownModel(t, a.model)) continue;
    await db.query(`UPDATE agents SET "model" = $1 WHERE "id" = $2`, [t.model, a.id]);
    a.model = t.model;
    agentsFixed++;
  }

  let sessionsFixed = 0;
  if (await hasTable(db, 'chat_sessions')) {
    const sessions = (await db.query(`SELECT "id", "accountId", "agentId", "agentTypeId", "model" FROM chat_sessions WHERE "model" <> ''`)).rows as SessionRow[];
    for (const s of sessions) {
      const own = s.agentTypeId ? byId.get(s.agentTypeId) : undefined;
      const agent = s.agentId ? agentById.get(s.agentId) : undefined;
      const t = own && own.accountId === s.accountId ? own : agent ? agentType(agent) : agentType({ accountId: s.accountId, provider: '', agentTypeId: null });
      if (!t || t.provider === 'echo' || isKnownModel(t, s.model)) continue;
      await db.query(`UPDATE chat_sessions SET "model" = $1 WHERE "id" = $2`, [t.model, s.id]);
      sessionsFixed++;
    }
  }
  return { agents: agentsFixed, sessions: sessionsFixed };
}

/**
 * A type's own default of another vendor's family (docs/agent-types.md
 * "Backfill"): the Settings add form used to start every new type on
 * claude-sonnet-4-5 whatever provider was picked, so a DeepSeek type could
 * default to a model DeepSeek cannot serve. Such a type moves to its
 * family's preset default (a listed model of that family when the preset's
 * is not on its list). A type nobody can place (custom gateway) and one of
 * no recognisable default are left alone. Returns how many moved;
 * idempotent. Runs before repairAgentModels so agents follow the fixed default.
 */
export async function repairTypeDefaults(db: Queryable): Promise<number> {
  if (!(await hasTable(db, 'agent_types'))) return 0;
  const types = (await db.query(`SELECT "id", "provider", "model", "models", "baseUrl" FROM agent_types`)).rows as Array<{ id: string; provider: string; model: string; models: string; baseUrl: string | null }>;
  let fixed = 0;
  for (const t of types) {
    const fam = declaredFamily(t);
    const mf = modelFamily(t.model || '');
    if (!fam || !mf || fam === mf) continue;
    const list = (() => { try { const v = JSON.parse(t.models || '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } })();
    const preset = presetForFamily(fam);
    const to = list.length > 0
      ? (preset && list.includes(preset.model) ? preset.model : list.find((m) => modelFamily(m) === fam))
      : preset?.model;
    if (!to || to === t.model) continue;
    await db.query(`UPDATE agent_types SET "model" = $1 WHERE "id" = $2`, [to, t.id]);
    fixed++;
  }
  return fixed;
}
