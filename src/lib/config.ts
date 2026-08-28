/**
 * The web app's ONE reader of `import.meta.env` (S30, §18 item 10(a)).
 *
 * Every deployment-varying value the browser needs is read here and nowhere
 * else, and `configSurface` (Task 26) fails the build on a second reader.
 * There is no `isLocal`, no `if (dev)` and no environment branch: the four
 * values below are all that differ between a laptop and a firm's tenant.
 */
export interface WebConfig {
  apiBaseUrl: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcScope: string;
}

function required(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(
      `${name} is not configured. LexPrompt will not start without it — a missing `
      + 'identity configuration must not become an app that runs and mostly works.',
    );
  }
  return value;
}

export const config: WebConfig = {
  apiBaseUrl: required('VITE_API_BASE_URL', import.meta.env.VITE_API_BASE_URL),
  oidcIssuer: required('VITE_OIDC_ISSUER', import.meta.env.VITE_OIDC_ISSUER),
  oidcClientId: required('VITE_OIDC_CLIENT_ID', import.meta.env.VITE_OIDC_CLIENT_ID),
  oidcScope: required('VITE_OIDC_SCOPE', import.meta.env.VITE_OIDC_SCOPE),
};

/**
 * Whether `debug()` prints. The one build-mode flag the web app reads, and
 * it is read HERE for the same reason as everything else in this file.
 *
 * It is NOT an environment branch in the S30 sense — nothing behaves
 * differently, a `console.log` is merely silent in a build — but it is an
 * `import.meta.env` read, and `configSurface` (Task 26) makes no exception
 * for a benign one. That is deliberate: an exception for "it's only a log"
 * is how the second one arrives.
 */
export const DEBUG: boolean = import.meta.env.DEV;
