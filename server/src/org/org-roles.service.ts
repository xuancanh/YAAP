/**
 * OrgRolesService — the role catalog as data (docs/company-vision.md §4,
 * execution-plan item 24). `list(profileText)` ranks the seed roles against
 * the operating profile with a pure string match; `resolveHire` turns a
 * `role:<id>` into the template hire the approvals path already knows
 * (charter, title, requested scopes, model tier → model), so a role hire and
 * a pack hire meet the chief's holdings through the same `prepareHire`.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { tierModel, type OrgRouting } from './org-routing';
import { ROLES, rankRoles, roleById, roleCharter, roleRef, type ModelTier, type Role } from './roles/catalog';

export interface RoleHireTemplate {
  roleId: string;
  name: string;
  title: string;
  charter: string;
  scopes: string[];
  modelTier: ModelTier;
  /** A concrete model when the tier implies one for the provider; '' keeps the agent default. */
  model: string;
  estMonthlyUsd: number;
  /** The role's authored pack (Role.packId): its skills install on the hire. */
  packId?: string;
}

/** The model a tier maps to for a provider — one tier table, item 23's
 *  `tierModel` (org-routing.ts): `cheap` is the provider's cheapest sibling,
 *  `strong` the provider's strong model, `standard` the default model (''
 *  here keeps the agent type's default). `routing` lets a CEO-pinned tier
 *  model win. */
export function modelForTier(tier: ModelTier, provider = 'anthropic', baseUrl?: string, routing: OrgRouting = { classes: {}, models: {} }): string {
  return tierModel(routing, tier, provider, '', baseUrl);
}

/** `templateOrPack` names a role (`role:<id>`) → the template hire, or null.
 *  Pure, so OrgApprovalsService.prepareHire can call it without the service. */
export function resolveRoleHire(templateOrPack: string, input: { orgName: string; name?: string; title?: string; scopes?: string[]; provider?: string; model?: string }): RoleHireTemplate | null {
  const role = roleRef(templateOrPack);
  if (!role) return null;
  return {
    roleId: role.id,
    // The agent is named after the title the chief gave (one role, several seats), else the role.
    name: (input.name ?? input.title ?? role.title).trim().slice(0, 60),
    title: (input.title ?? role.title).slice(0, 80),
    charter: roleCharter(role, input.orgName),
    scopes: [...new Set([...role.toolScopes, ...(input.scopes ?? [])])],
    modelTier: role.modelTier,
    model: input.model ?? modelForTier(role.modelTier, input.provider),
    estMonthlyUsd: role.estMonthlyUsd,
    ...(role.packId ? { packId: role.packId } : {}),
  };
}

@Injectable()
export class OrgRolesService {
  /** The catalog ranked by the profile text (values + culture + vision), with the matched tags. */
  list(profileText?: string | null): Array<Role & { score: number; matched: string[] }> {
    return rankRoles(profileText ?? '');
  }

  get(id: string): Role {
    const r = roleById(id);
    if (!r) throw new BadRequestException(`unknown role "${id}" — roles: ${ROLES.map((x) => x.id).join(', ')}`);
    return r;
  }

  resolveHire(templateOrPack: string, input: { orgName: string; name?: string; title?: string; scopes?: string[]; provider?: string; model?: string }): RoleHireTemplate | null {
    return resolveRoleHire(templateOrPack, input);
  }
}
