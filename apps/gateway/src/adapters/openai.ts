import { openAiCompatible, trimSlash } from './openaiCompatible.ts';

export const openaiAdapter = openAiCompatible({
  id: 'openai',
  url: entry => `${trimSlash(entry.endpoint)}/v1/chat/completions`,
  headers: (_entry, credential) => ({
    Authorization: `Bearer ${credential.kind === 'bearer' ? credential.token : credential.key}`,
  }),
});
