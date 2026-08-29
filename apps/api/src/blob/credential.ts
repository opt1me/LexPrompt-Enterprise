/**
 * The Blob Storage credential comes from ONE configured source, and there is
 * no fallback between them.
 *
 * This is §10's rule — the gateway's `DefaultCredentialResolver` next door —
 * restated for the store that holds the firm's document bytes. The reason is
 * the same and is worth reading before changing anything here: *"managed
 * identity is unavailable locally, so read the connection string instead" is
 * a two-line change that turns a deployed API's Entra failure into a silent
 * switch to whatever key happens to be in its environment.* A fallback means
 * the system used a different identity than the operator configured, and
 * said nothing.
 *
 * So: one `switch`, no `catch` that reaches another branch, and a refusal
 * that names ONLY the material the CONFIGURED source is missing. Naming the
 * other source in the message would be an invitation to the fallback this
 * refuses — `blobCredential.test.ts` asserts it does not.
 *
 * Deliberately NOT merged with `credentials/resolve.ts`: that resolver
 * answers a MODEL's credential out of four sources for the gateway, a
 * different service with no database and no blob store, and giving it a
 * fifth case for a storage account would couple two services' configuration
 * through one type. What is shared is the RULE, and the rule is written down
 * in both places rather than abstracted into one that neither owns.
 */

/** The two sources this API supports, and no default. */
export type BlobCredentialSource = 'connection-string' | 'managed-identity';

export interface BlobCredentialConfig {
  source: BlobCredentialSource;
  connectionString?: string;
  accountUrl?: string;
}

export type BlobCredential =
  | { kind: 'connection-string'; connectionString: string }
  | { kind: 'managed-identity'; accountUrl: string };

export class BlobCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobCredentialError';
  }
}

export function resolveBlobCredential(config: BlobCredentialConfig): BlobCredential {
  switch (config.source) {
    case 'connection-string': {
      const value = (config.connectionString ?? '').trim();
      if (!value) {
        throw new BlobCredentialError(
          'API_BLOB_CREDENTIAL_SOURCE is connection-string, but API_BLOB_CONNECTION_STRING is '
          + 'unset or empty. LexPrompt will not start without the credential it was configured '
          + 'to use, and it will not look for another one.',
        );
      }
      return { kind: 'connection-string', connectionString: value };
    }
    case 'managed-identity': {
      const value = (config.accountUrl ?? '').trim();
      if (!value) {
        throw new BlobCredentialError(
          'API_BLOB_CREDENTIAL_SOURCE is managed-identity, but API_BLOB_ACCOUNT_URL is unset or '
          + 'empty. LexPrompt will not start without the credential it was configured to use, '
          + 'and it will not look for another one.',
        );
      }
      return { kind: 'managed-identity', accountUrl: value };
    }
    default: {
      // An UNKNOWN source is refused, never defaulted. A default here would
      // be this code choosing an identity on the operator's behalf, which is
      // the same fault as a fallback with one fewer step.
      const unknown: string = config.source;
      throw new BlobCredentialError(
        `API_BLOB_CREDENTIAL_SOURCE is ${JSON.stringify(unknown)}, which is not one of `
        + 'connection-string, managed-identity. There is no default: LexPrompt will not guess '
        + 'which identity it should hold the firm\'s documents with.',
      );
    }
  }
}
