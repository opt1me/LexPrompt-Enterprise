# Troubleshooting

## Blank/Black Screen

- Verify `.env.local` values are valid.
- Restart dev server after env changes.
- Check browser console for missing env/runtime errors.

## AI 400 / Schema Errors

- Ensure model/provider combination is valid.
- Retry after confirming response schema requirements.
- If using OpenAI, confirm `responses` API path and key validity.

## Missing Bearer Authentication

- Confirm provider key is set for the active mode.
- In `platform` mode, ensure server env keys are present.
- In `byok` mode, ensure user key is saved in Engine Settings.

## No Results for Clauses

- Check token limit and truncation behavior.
- Confirm selected model is approved for configured region.
- Retry with smaller document or fewer clauses for diagnosis.

## Citation Click Does Not Highlight

- Citations must be exact text spans in source document.
- If no exact match exists, app shows a non-blocking toast.

## Review Link Fails

- Confirm user is a workspace member.
- Confirm review was not deleted.
- Confirm `workspaceId` and `reviewId` query params are correct.

## Collaboration Data Not Persisting

- Check Supabase env vars and schema migration.
- Verify API mode and workspace permissions.
- Inspect API responses for role/authorization failures.
