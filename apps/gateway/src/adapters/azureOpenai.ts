import { openAiCompatible, trimSlash } from './openaiCompatible.ts';

/**
 * Azure OpenAI takes the deployment name in the PATH and the model field is
 * ignored, and it accepts either an `api-key` header or an Entra bearer
 * token. Which one is decided by the resolved credential's kind — so an
 * operator moves from a vaulted key to a managed identity by editing
 * configuration, with no code change and no second adapter.
 */
export const azureOpenaiAdapter = openAiCompatible({
  id: 'azure-openai',
  url: entry =>
    `${trimSlash(entry.endpoint)}/openai/deployments/${entry.model}/chat/completions`
    + `?api-version=${entry.apiVersion ?? '2024-10-21'}`,
  headers: (_entry, credential) =>
    credential.kind === 'bearer'
      ? { Authorization: `Bearer ${credential.token}` }
      : { 'api-key': credential.key },
});
