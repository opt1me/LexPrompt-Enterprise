import { BlobServiceClient, RestError, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { resolveBlobCredential, type BlobCredentialConfig } from './credential.ts';

/**
 * `workspace/{workspaceId}/document/{documentId}` — §6.5's key, built here
 * and nowhere else.
 *
 * One function for the same reason `findingsKeyFor` is one function: six
 * defects in sub-project C came from code that derived a key inline. A blob
 * key derived in two places is a blob that a delete cascade cannot find,
 * which makes the README's "deleting a matter deletes its documents' bytes"
 * false in exactly the direction nobody would notice — the row goes, the
 * bytes stay, and every screen agrees the document is gone.
 */
export function blobKeyFor(workspaceId: string, documentId: string): string {
  return `workspace/${workspaceId}/document/${documentId}`;
}

/** Everything under one workspace — the prefix a `list` or a reconciliation
 *  pass walks. Derived from `blobKeyFor` rather than retyped, so the two
 *  cannot disagree about where a workspace's blobs live. */
export function workspacePrefix(workspaceId: string): string {
  return blobKeyFor(workspaceId, '');
}

export interface StoredBlob {
  bytes: Buffer;
  mime: string;
}

export interface BlobStore {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  /**
   * `null` when there is no blob — NOT an error.
   *
   * A `DocumentRecord` can outlive its bytes (a partial failure, a manual
   * purge), and the UI must still show that document's metadata with an
   * "unavailable" state rather than the whole view blowing up.
   * `getDocumentBlob`'s docstring already says this at length; the rule is
   * unchanged by the store moving.
   */
  get(key: string): Promise<StoredBlob | null>;
  /** Resolves whether or not the blob was there. Deleting a blob that has
   *  already gone is the cascade succeeding, not failing. */
  delete(key: string): Promise<void>;
  /** For the matter cascade and for orphan reconciliation. */
  list(prefix: string): Promise<string[]>;
  /** Creates the container if it is not there. Called once at startup, and
   *  separate from the constructor so building the client cannot do network
   *  work as a side effect of configuration. */
  ensureContainer(): Promise<void>;
}

/**
 * The one implementation, over `@azure/storage-blob`.
 *
 * The credential is whatever `resolveBlobCredential` returned and NOTHING
 * ELSE — there is no `catch` here that reaches for the other source, which
 * is the whole point of that module. Azurite locally and a storage account
 * in Azure are the same code path with a different credential; there is no
 * environment branch (S30), and `AzureBlobStore` cannot tell which it is
 * talking to.
 */
export class AzureBlobStore implements BlobStore {
  readonly #container: ContainerClient;

  constructor(config: BlobCredentialConfig, containerName: string) {
    const credential = resolveBlobCredential(config);
    const service = credential.kind === 'connection-string'
      ? BlobServiceClient.fromConnectionString(credential.connectionString)
      : new BlobServiceClient(credential.accountUrl, new DefaultAzureCredential());
    this.#container = service.getContainerClient(containerName);
  }

  async ensureContainer(): Promise<void> {
    // `access: undefined`, EXPLICITLY. The two other values this option
    // takes — 'blob' and 'container' — are both PUBLIC access, and §6.5 says
    // private container, no public access. Writing the option and picking
    // the wrong value is the easy mistake, so the right value is written
    // down rather than left off.
    await this.#container.createIfNotExists({ access: undefined });
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    await this.#container.getBlockBlobClient(key).uploadData(bytes, {
      blobHTTPHeaders: { blobContentType: mime },
    });
  }

  async get(key: string): Promise<StoredBlob | null> {
    const blob = this.#container.getBlockBlobClient(key);
    try {
      const response = await blob.downloadToBuffer();
      const properties = await blob.getProperties();
      return {
        bytes: response,
        // `application/octet-stream` only when the store genuinely has no
        // content type — never a guess from the key's extension, which
        // would be this layer inventing a fact about bytes it did not read.
        mime: properties.contentType ?? 'application/octet-stream',
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      // EVERY other failure propagates. A permission error or an unreachable
      // account answered as `null` would render "this document's bytes are
      // unavailable" over a store that is simply refusing us — the empty-is-
      // not-broken rule, at the one place a caller is told to expect `null`.
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#container.getBlockBlobClient(key).deleteIfExists();
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const blob of this.#container.listBlobsFlat({ prefix })) keys.push(blob.name);
    return keys;
  }
}

/** A 404 from the service, as `@azure/storage-blob` reports it. Checked on
 *  the status code rather than on a message, because a message is not an
 *  API. */
function isNotFound(err: unknown): boolean {
  return err instanceof RestError && (err.statusCode === 404 || err.code === 'BlobNotFound');
}
