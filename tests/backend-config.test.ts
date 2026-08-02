/** Fail-fast env validation: production requires real infra vars (no silent
 *  dev-credential fallback), dev keeps working with zero env, and malformed
 *  integers are rejected instead of becoming NaN. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv } from '../server/src/config/validation';

const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:pass@db.example.com:5432/yaamchat',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'yaam-chat-prod',
  S3_ACCESS_KEY_ID: 'AKIA...',
  S3_SECRET_ACCESS_KEY: 'secret',
};

test('production without DATABASE_URL/S3 throws an aggregated error naming every missing var', () => {
  assert.throws(
    () => validateEnv({ NODE_ENV: 'production' }),
    (err: Error) => {
      assert.match(err.message, /Invalid environment configuration/);
      for (const name of ['DATABASE_URL', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
        assert.match(err.message, new RegExp(name), `error should name ${name}`);
      }
      return true;
    },
  );
});

test('production with all required vars passes and returns the env untouched', () => {
  assert.equal(validateEnv({ ...productionEnv, EXTRA: 'kept' }).EXTRA, 'kept');
});

test('dev defaults: empty env is valid outside production', () => {
  assert.doesNotThrow(() => validateEnv({}));
  assert.doesNotThrow(() => validateEnv({ NODE_ENV: 'development' }));
});

test('non-integer PORT is rejected instead of parsing to NaN', () => {
  assert.throws(() => validateEnv({ PORT: 'abc' }), /PORT must be a non-negative integer/);
});
