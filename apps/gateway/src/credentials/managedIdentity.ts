import { DefaultAzureCredential } from '@azure/identity';

/**
 * `DefaultAzureCredential` covers both deployment postures with no code
 * difference: a managed identity in Container Apps, and a developer's own
 * `az login` locally. That is why local development against a real Azure
 * model needs no key either — S2's stronger property survives development,
 * not only deployment.
 */
export function makeGetToken(): (scope: string) => Promise<{ token: string; expiresOnTimestamp: number }> {
  const credential = new DefaultAzureCredential();
  return async (scope: string) => {
    const token = await credential.getToken(scope);
    if (!token) throw new Error(`No token was returned for scope ${scope}.`);
    return { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp };
  };
}
