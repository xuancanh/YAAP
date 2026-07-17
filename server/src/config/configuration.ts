/**
 * Typed configuration factory (loaded once by @nestjs/config).
 *
 * All runtime knobs come from the environment; DATA_DIR defaults to ./data so
 * a bare `npm run dev` works with zero setup (SQLite file is created there).
 */
import { resolve } from 'node:path';

export default () => {
  const dataDir = resolve(process.env.DATA_DIR || './data');
  return {
    port: parseInt(process.env.PORT || '8790', 10),
    dataDir,
    appDbPath: process.env.APP_DB_PATH || resolve(dataDir, 'app.sqlite'),
    /** Default per-chat token ceiling (FR-7.1). 0 = unlimited. */
    defaultTokenCeiling: parseInt(process.env.DEFAULT_TOKEN_CEILING || '200000', 10),
    /** Max tool rounds inside a single turn (FR-3.1). */
    maxToolRounds: parseInt(process.env.MAX_TOOL_ROUNDS || '24', 10),
  };
};
