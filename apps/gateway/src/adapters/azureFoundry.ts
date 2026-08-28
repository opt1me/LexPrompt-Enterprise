import { openAiCompatible, trimSlash } from './openaiCompatible.ts';

export const azureFoundryAdapter = openAiCompatible({
  id: 'azure-foundry',
  url: entry =>
    `${trimSlash(entry.endpoint)}/models/chat/completions`
    + `?api-version=${entry.apiVersion ?? '2024-05-01-preview'}`,
  headers: (_entry, credential) =>
    credential.kind === 'bearer'
      ? { Authorization: `Bearer ${credential.token}` }
      : { 'api-key': credential.key },
});
