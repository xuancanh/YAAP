/**
 * SecurityController — GET /api/security: the published threat model's
 * headline facts and the disclosure contact, so the hosted product can show
 * the same policy the repo publishes in docs/security.md (execution plan
 * item 3). Read-only, no database, and left open by TokenAuthStrategy like
 * GET /api/status: a researcher who found something must be able to learn
 * where to report it without a credential.
 */
import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const SECURITY_POLICY_URL = 'https://github.com/xuancanh/yaam-chat/blob/main/docs/security.md';

/** One line per guarantee the full document expands on; kept in step with
 *  docs/security.md §(c)-(h) by tests/backend-security.test.ts. */
export const SECURITY_SUMMARY: readonly string[] = [
  'Agents have no host: every capability is a brokered tool, and the only code execution is in a network-denied OS sandbox or a CSP-sealed iframe.',
  'Mutating tools pause for approval in Ask mode; confirm-always tools (sending mail) pause in every mode; MCP tools always gate.',
  'Turns that originate from a channel or a mini app run in Ask mode with gated tools auto-denied, and their lessons are quarantined.',
  'Outbound fetches pass an SSRF guard that checks literal IPs, resolved addresses and every redirect hop.',
  'Provider keys and OAuth tokens are sealed with AES-256-GCM at rest when TOKEN_ENCRYPTION_KEY is set, and never returned by the API.',
  'Nothing is remembered about the user without a human approving it: profile proposals, skill drafts and untrusted lessons wait for review.',
  'Nothing unattended is silent: every loop run, budget stop and queued action writes an agent event.',
];

@Controller('security')
export class SecurityController {
  // Explicit @Inject: tsx (dev/test runner) doesn't emit design:paramtypes.
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  @Get()
  policy() {
    return {
      contact: this.config.get<string>('securityContact') ?? '',
      policyUrl: SECURITY_POLICY_URL,
      summary: SECURITY_SUMMARY,
    };
  }
}
