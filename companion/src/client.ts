/** The companion's view of the API: four routes, all outbound, all under
 *  /api/computer. Pairing is code-protected; the rest carry the token. */

export interface WorkItem { id: string; tool: string; input: Record<string, unknown>; deadlineMs: number }
export interface ActionResult { ok: boolean; output?: string; pngBase64?: string; width?: number; height?: number }

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export class CompanionClient {
  constructor(private readonly serverUrl: string, private readonly token: string) {}

  private url(p: string): string { return `${this.serverUrl.replace(/\/+$/, '')}${p}`; }

  static async pair(serverUrl: string, body: { code: string; name: string; platform: string; scopes: string[] }): Promise<{ runnerId: string; token: string; scopes: string[] }> {
    const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/computer/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new ApiError(res.status, await errorText(res));
    return res.json() as Promise<{ runnerId: string; token: string; scopes: string[] }>;
  }

  /** Long poll: resolves with the next action or null on 204. */
  async nextWork(): Promise<WorkItem | null> {
    const res = await fetch(this.url('/api/computer/work'), {
      headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(45_000),
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new ApiError(res.status, await errorText(res));
    return res.json() as Promise<WorkItem>;
  }

  async submit(actionId: string, result: ActionResult): Promise<void> {
    const res = await fetch(this.url(`/api/computer/result/${encodeURIComponent(actionId)}`), {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(result), signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new ApiError(res.status, await errorText(res));
  }

  async heartbeat(): Promise<{ ok: boolean; paused: boolean; scopes: string[] }> {
    const res = await fetch(this.url('/api/computer/heartbeat'), {
      method: 'POST', headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new ApiError(res.status, await errorText(res));
    return res.json() as Promise<{ ok: boolean; paused: boolean; scopes: string[] }>;
  }
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { message?: string | string[] };
    const m = Array.isArray(j.message) ? j.message.join('; ') : j.message;
    if (m) return `${res.status}: ${m}`;
  } catch { /* not JSON */ }
  return `${res.status}: ${text.slice(0, 200) || res.statusText}`;
}
