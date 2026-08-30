import { describe, it, expect } from 'vitest';
import { parseRoleMappings } from '../src/auth/roles.ts';
import { loadConfig, describeConfig, ConfigError } from '../src/config.ts';

/**
 * The parser and the startup refusal — no database, so these run in the
 * DEFAULT suite rather than in `test:pg`.
 *
 * That placement is deliberate and it is a correction to the task brief,
 * which put these four cases in `roles.pg.test.ts` while also naming this
 * file. `npm run test:pg` needs Docker and is not part of `npm test`, so a
 * parser that has no database dependency at all would have been covered only
 * by a suite most runs never execute.
 */
const KC = 'http://localhost:8088/realms/lexprompt';

describe('parseRoleMappings', () => {
  it('reads issuer|group|role triples', () => {
    expect(parseRoleMappings(`${KC}|partners|partner, ${KC}|admins|admin`)).toEqual([
      { issuer: KC, groupValue: 'partners', role: 'partner' },
      { issuer: KC, groupValue: 'admins', role: 'admin' },
    ]);
  });

  it('refuses a role outside the three, naming the entry', () => {
    expect(() => parseRoleMappings(`${KC}|everyone|superuser`)).toThrow(/superuser/);
  });

  it('refuses a malformed entry rather than skipping it', () => {
    // Skipping is how a firm ends up with a partner group nobody mapped and
    // a partner who is told, confidently, that they have no access.
    expect(() => parseRoleMappings('not-a-triple')).toThrow(/issuer\|group\|role/);
  });

  it('refuses an entry with a blank field rather than storing an empty group', () => {
    // A mapping whose group value is the empty string would be dead weight at
    // best; at worst it is a row that matches nothing and looks like coverage.
    expect(() => parseRoleMappings(`${KC}||partner`)).toThrow(/issuer\|group\|role/);
  });

  it('reads an unset value as no mappings, which the API then refuses at startup', () => {
    expect(parseRoleMappings(undefined)).toEqual([]);
    expect(parseRoleMappings('   ')).toEqual([]);
  });
});

const ENV = {
  API_ISSUER: KC,
  API_DISCOVERY_URL: 'http://keycloak:8080/realms/lexprompt',
  API_AUDIENCE: 'lexprompt-api',
  API_GATEWAY_URL: 'https://gateway:8081',
  API_WORKSPACE_ID: '00000000-0000-0000-0000-000000000001',
  API_DATABASE_URL: 'postgres://lexprompt_app:pw@postgres:5432/lexprompt',
  API_WORKER_DATABASE_URL: 'postgres://lexprompt_worker:pw@postgres:5432/lexprompt',
  API_DATABASE_MIGRATION_URL: 'postgres://lexprompt_migrator:pw@postgres:5432/lexprompt',
  API_ROLE_MAPPINGS: `${KC}|reviewers|reviewer,${KC}|partners|partner,${KC}|admins|admin`,
};

describe('the API refuses to start with no role mapping (S29, P4s posture)', () => {
  it('loads the mappings when they are set', () => {
    expect(loadConfig({ ...ENV })).toMatchObject({
      roleMappings: [
        { issuer: KC, groupValue: 'reviewers', role: 'reviewer' },
        { issuer: KC, groupValue: 'partners', role: 'partner' },
        { issuer: KC, groupValue: 'admins', role: 'admin' },
      ],
    });
  });

  it('refuses an unset API_ROLE_MAPPINGS, because that deployment refuses everybody', () => {
    // A misconfiguration must not become a system that runs and mostly
    // works. With no mapping, every user who signs in is told they have no
    // access — a stack that is up, green, and useless to the whole firm.
    const env = { ...ENV, API_ROLE_MAPPINGS: '' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/API_ROLE_MAPPINGS/);
    expect(() => loadConfig(env)).toThrow(/no access/);
  });

  it('raises a malformed entry as a ConfigError, like every other bad key here', () => {
    // `parseRoleMappings` throws a plain Error so it need not import the
    // config module that imports it; `loadConfig` is where it becomes the
    // one error type this process treats as "your configuration is wrong".
    expect(() => loadConfig({ ...ENV, API_ROLE_MAPPINGS: 'nope' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ENV, API_ROLE_MAPPINGS: `${KC}|x|superuser` }))
      .toThrow(ConfigError);
  });

  it('prints the mapping table at boot, so "why can nobody sign in" is in the logs', () => {
    const banner = describeConfig(loadConfig({ ...ENV }));
    expect(banner).toMatch(/Role mappings/);
    expect(banner).toContain(`${KC} | partners -> partner`);
    expect(banner).toContain(`${KC} | admins -> admin`);
  });
});
