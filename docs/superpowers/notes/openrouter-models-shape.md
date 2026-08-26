# OpenRouter `/api/v1/models` — observed response shape

Observed by: `GET https://openrouter.ai/api/v1/models` (no API key), on 2026-08-26.
HTTP status: 200. Total entries returned: **417**.

This document records what was actually observed in the live response, not what
was assumed going in. Where it differs from the assumption in the Task 6 brief
or the Task 7 sketch, that is called out explicitly.

## Top-level envelope

The brief expected the top-level key to be `data`. That is confirmed, but the
envelope also carries two more keys not mentioned in the brief:

```json
{
  "data": [ /* 417 model objects */ ],
  "total_count": 417,
  "links": { "next": null }
}
```

- `data` — array of model objects. **Confirmed**, matches assumption.
- `total_count` (number) — equals `data.length` in this response (417 == 417).
- `links.next` — `null` in this response. Presumably a pagination cursor for a
  future/paginated form of this endpoint; not populated today. Safe to ignore,
  but do not assume `data` is always complete without checking this field if
  the API changes later.

## Field names (per model object)

| Concept | Field | Type observed | Notes |
|---|---|---|---|
| Model id | `id` | string | e.g. `"anthropic/claude-opus-5-fast"`. Always contains a `/` (provider/slug). 417/417 present, all unique. |
| Display name | `name` | string | e.g. `"Claude Opus 5 (Fast)"`. Present 417/417. |
| Context length | `context_length` | number | Present 417/417, always a number (not string). This is the field to use — do NOT use `top_provider.context_length` as the primary source (see below). |
| Prompt price | `pricing.prompt` | **string** | e.g. `"0.00001"`. Present 417/417. Not a number — must be parsed with `Number()`/`parseFloat()`. |
| Completion price | `pricing.completion` | **string** | e.g. `"0.00005"`. Present 417/417. Also a string. |

Other fields present in every entry: `canonical_slug` (string), `architecture`
(object), `description` (string), `created` (number, unix seconds),
`supported_parameters` (array of strings), `top_provider` (object),
`default_parameters` (object), `links` (object with a `details` URL),
`per_request_limits` (always `null` in this response — 417/417 null),
`hugging_face_id` (string or `null`), `supported_voices` (null in the sampled
entry), `knowledge_cutoff` / `expiration_date` (null in the sampled entry),
`reasoning` (object, but see field-omission table below).

## Capabilities: how they're expressed

There is **no boolean `supports_structured_output` or `supports_json` field.**
Capabilities are expressed as membership in the `supported_parameters` array
— a flat array of strings naming which request parameters the model accepts.
Structured-output support is indicated by two *separate* possible entries:

- `"response_format"` — present in 360/417 models. This is the OpenAI-style
  `response_format: { type: "json_object" | "json_schema" }` parameter.
- `"structured_outputs"` — present in 331/417 models. This is a distinct,
  narrower flag (OpenRouter's own strict-schema mode). A model can have
  `response_format` without `structured_outputs`, so **treat these as two
  separate capabilities**, not synonyms. If Task 7's `ModelInfo` needs a single
  "supports structured output" boolean, decide explicitly whether that means
  "has `response_format`" or "has `structured_outputs`" (or both) — they are
  not interchangeable, and picking the wrong one changes which ~30 models are
  included/excluded.

Other values seen in `supported_parameters` (not exhaustive capability list,
just what's observed, with counts out of 417): `max_tokens` (406), `tools`
(348), `tool_choice` (342), `temperature` (330), `seed` (318), `top_p` (314),
`stop` (285), `reasoning` (285), `include_reasoning` (285), `frequency_penalty`
(220), `presence_penalty` (214), `top_k` (199), `logprobs`/`top_logprobs`
(145 each), `reasoning_effort` (143), `repetition_penalty` (136), `logit_bias`
(130), `min_p` (100), `verbosity` (22), `web_search_options` (17), `top_a`
(11), `prediction` (11), `max_completion_tokens` (56), `parallel_tool_calls`
(5). This is a flat string array on every model (never missing), but its
*contents* vary per model — always check membership, never assume a fixed set.

## Image input support

Also **not a boolean flag.** Expressed via `architecture.input_modalities`,
an array of strings, e.g. `["text", "image", "file"]`. Image support = the
array `.includes("image")`. 250/417 models include `"image"` in
`input_modalities`.

There is a redundant, human-readable summary of the same information at
`architecture.modality`, a single string like `"text+image+file->text"`
(input modalities joined by `+`, then `->`, then output modalities joined by
`+`). 16 distinct values for `modality` were observed, including multimodal
*outputs* too, e.g. `"text+image->text+image"` and `"text+audio->text+audio"`.
Do not parse this string — use `architecture.input_modalities` /
`architecture.output_modalities` arrays instead; they carry the same
information structurally.

## One complete example entry (verbatim)

Matched `/claude|gpt|gemini/` against `id`, first hit was
`anthropic/claude-opus-5-fast`:

```json
{
  "id": "anthropic/claude-opus-5-fast",
  "canonical_slug": "anthropic/claude-opus-5-fast-20260723",
  "hugging_face_id": null,
  "name": "Claude Opus 5 (Fast)",
  "created": 1784912546,
  "description": "Fast-mode variant of [Opus 5](/anthropic/claude-opus-5) - identical capabilities with higher output speed at 2x pricing relative to regular Opus 5.\n\nLearn more in Anthropic's docs: https://platform.claude.com/docs/en/build-with-claude/fast-mode",
  "context_length": 1000000,
  "architecture": {
    "modality": "text+image+file->text",
    "input_modalities": ["text", "image", "file"],
    "output_modalities": ["text"],
    "tokenizer": "Claude",
    "instruct_type": null
  },
  "pricing": {
    "prompt": "0.00001",
    "completion": "0.00005",
    "web_search": "0.01",
    "input_cache_read": "0.000001",
    "input_cache_write": "0.0000125",
    "input_cache_write_1h": "0.00002"
  },
  "top_provider": {
    "context_length": 1000000,
    "max_completion_tokens": 128000,
    "is_moderated": true
  },
  "per_request_limits": null,
  "supported_parameters": [
    "include_reasoning",
    "max_tokens",
    "reasoning",
    "reasoning_effort",
    "response_format",
    "stop",
    "structured_outputs",
    "tool_choice",
    "tools",
    "verbosity"
  ],
  "default_parameters": {},
  "supported_voices": null,
  "knowledge_cutoff": null,
  "expiration_date": null,
  "links": {
    "details": "/api/v1/models/anthropic/claude-opus-5-fast-20260723/endpoints"
  },
  "reasoning": {
    "mandatory": false,
    "default_enabled": true,
    "supported_efforts": ["max", "xhigh", "high", "medium", "low"],
    "default_effort": "high"
  }
}
```

## Total model count

**417** entries in `data`, matching `total_count: 417`.

## Surprises for anyone writing the mapping function

Checked programmatically across all 417 entries (not eyeballed):

1. **Prices are strings, not numbers.** `pricing.prompt` and
   `pricing.completion` are always strings (0/417 numeric, 0/417 non-numeric
   garbage) — e.g. `"0.00001"`, not `0.00001`. Every mapping must
   `Number(...)`/`parseFloat(...)` them.

2. **Units are USD per single token**, not per million tokens. Observed
   `pricing.prompt: "0.00001"` for a flagship model ($0.00001/token = $10 per
   million tokens, a plausible premium-model rate). If Task 7's context-budget
   or cost-estimate math assumes "per million tokens" units, it will be off by
   6 orders of magnitude unless it multiplies by 1,000,000 itself for display.

3. **Prices can be negative.** Five router/meta models —
   `openrouter/auto-beta`, `openrouter/auto`, `openrouter/fusion`,
   `openrouter/pareto-code`, `openrouter/bodybuilder` — report
   `pricing.prompt: "-1"` and `pricing.completion: "-1"`. These are
   dynamic-routing pseudo-models where a fixed price doesn't apply; `-1` is a
   sentinel, not a real per-token cost. A naive `price * tokens` cost estimate
   will silently produce negative "costs" for these five entries unless
   explicitly guarded (e.g. treat `< 0` as "variable/unknown price").

4. **`pricing` can contain far more than `prompt`/`completion`.** Other keys
   seen across the dataset: `web_search`, `input_cache_read`,
   `input_cache_write`, `input_cache_write_1h`, `image`, `image_output`,
   `audio`, `audio_output`, `input_audio_cache`, `internal_reasoning`, and
   `overrides`. Do not assume `pricing` has exactly two keys.

5. **`pricing.overrides` is a nested array of time/volume-conditional pricing
   objects, not a number.** 60/417 models have it. Example: some models charge
   different rates on weekdays vs. weekends, or above a token-count threshold
   (`min_prompt_tokens`), by UTC hour range (`utc_start`/`utc_end`). If a
   mapping function ever iterates `Object.values(pricing)` expecting numeric
   strings, `overrides` will break it — it's an array of objects. Simplest safe
   approach for Task 7: read only `pricing.prompt` and `pricing.completion`
   directly by name, and ignore other pricing keys including `overrides`.

6. **`context_length` (top-level) vs. `top_provider.context_length` can
   diverge/be absent.** Top-level `context_length` is present and numeric on
   417/417 entries — use this one. `top_provider.context_length` and
   `top_provider.max_completion_tokens` are `null` on 6/417 entries. Don't rely
   on the `top_provider` sub-object for context length; it's the less reliable
   field.

7. **`hugging_face_id` is `null` on 113/417 entries** (present as a string on
   the other 304). Handle `null`, don't assume a string.

8. **`reasoning` is entirely absent (not even `null` — the key itself is
   missing) on 131/417 entries**, present as an object on the other 286. Never
   present as `null` — it's either the object or the key doesn't exist. Guard
   with `m.reasoning?.field`, not `m.reasoning !== null`.

9. **`per_request_limits` is `null` on all 417/417 entries** in this response
   — never seen populated. Fine to ignore for now, but don't build logic that
   assumes it's usually an object.

10. **No single boolean flags for "structured output" or "image support"** —
    both are inferred from array membership (`supported_parameters.includes(...)`
    and `architecture.input_modalities.includes("image")` respectively). See
    "Capabilities" and "Image input support" above.

11. **Free models exist** (21/417) where both `pricing.prompt` and
    `pricing.completion` parse to `0` (e.g. `stealth/ox-alpha`,
    `liquid/lfm-2.5-2.6b:free`) — `0` is a legitimate real price, distinct from
    the `-1` sentinel above. Don't conflate "zero cost" with "unknown/variable
    cost."

## Bottom line for Task 7

- Envelope: read `response.data` (array). `total_count` and `links` exist but
  aren't needed for a basic model list.
- Use `id`, `name`, `context_length` directly — all reliably present and
  correctly typed.
- Parse `pricing.prompt` / `pricing.completion` with `Number(...)`, treat
  negative results as "variable pricing, cannot estimate," and treat `0` as a
  valid free price.
- Derive structured-output support from `supported_parameters` array
  membership — decide explicitly whether "structured output capable" means
  `includes("response_format")`, `includes("structured_outputs")`, or both.
- Derive image support from `architecture.input_modalities.includes("image")`.
