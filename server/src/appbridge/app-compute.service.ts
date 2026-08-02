/**
 * AppComputeService — `yaam.compute.run` (docs/miniapp-roadmap.md §5, §8).
 *
 * When an app needs real computation — parse a 40 MB CSV, fit a curve, pivot
 * a year of rows — the answer is not to ship pandas to the browser. It is the
 * sandbox we already run agent code in (docs/code-execution.md): network
 * denied at the OS level, writes confined to a scratch directory, fresh
 * environment per call, killed on a timer.
 *
 * This adds no new safety properties and deliberately invents none: it is the
 * same RunnerService the agent's own `run_js` / `run_python` use, reached
 * through the app's capability gate instead of the turn loop's. If the runner
 * is disabled, apps get the same honest refusal the agent does.
 *
 * The app supplies code, so the host confirms the first run per app and shows
 * the source — code the model wrote under the influence of whatever text it
 * read is exactly the input this whole document distrusts.
 */
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { RunnerService } from '../runner/runner.service';
import { AppBridgeService } from './app-bridge.service';

const CODE_CAP = 100_000;
const STDIN_CAP = 1_000_000;

@Injectable()
export class AppComputeService {
  constructor(
    private readonly bridge: AppBridgeService,
    @Optional() private readonly runner?: RunnerService,
  ) {}

  /** Which languages an app may run, if any. Apps feature-detect on this the
   *  same way they feature-detect `window.yaam` itself. */
  async status(agentId: string, appId: string) {
    await this.bridge.gate(agentId, appId, 'compute', 'compute.status');
    return this.runner?.status() ?? { backend: null, languages: [], detail: 'the code runner is not configured' };
  }

  async run(agentId: string, appId: string, language: string, code: string, stdin?: string) {
    const entry = await this.bridge.gate(agentId, appId, 'compute', 'compute.run');
    if (!this.runner) throw new BadRequestException('the code runner is not configured on this server');
    if (typeof code !== 'string' || !code.trim()) throw new BadRequestException('code is required');
    if (code.length > CODE_CAP) throw new BadRequestException(`code exceeds ${CODE_CAP} bytes`);
    if (stdin !== undefined && (typeof stdin !== 'string' || stdin.length > STDIN_CAP)) {
      throw new BadRequestException(`stdin must be a string of at most ${STDIN_CAP} bytes`);
    }

    const tool = language === 'python' ? 'run_python' : language === 'javascript' ? 'run_js' : null;
    if (!tool) throw new BadRequestException('language must be "javascript" or "python"');

    const output = await this.runner.execute(tool, { code, stdin });
    await this.bridge.note(agentId, `App "${entry.name}" ran ${language} in the sandbox`);
    return { language, output };
  }
}
