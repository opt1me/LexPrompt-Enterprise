import type { CredentialConfig } from '../config.ts';

export type ResolvedCredential =
  | { kind: 'bearer'; token: string }
  | { kind: 'api-key'; key: string };

export interface CredentialResolver {
  resolve(config: CredentialConfig): Promise<ResolvedCredential>;
}
