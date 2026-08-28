import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

export function makeGetSecret(): (vaultUrl: string, name: string) => Promise<string> {
  const credential = new DefaultAzureCredential();
  const clients = new Map<string, SecretClient>();
  return async (vaultUrl: string, name: string) => {
    let client = clients.get(vaultUrl);
    if (!client) {
      client = new SecretClient(vaultUrl, credential);
      clients.set(vaultUrl, client);
    }
    const secret = await client.getSecret(name);
    if (!secret.value) throw new Error(`Secret ${name} has no value.`);
    return secret.value;
  };
}
