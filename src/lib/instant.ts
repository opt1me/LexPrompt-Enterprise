/**
 * An epoch instant, as a person reads it.
 *
 * Extracted because Stage 4 needed it in two new places at once — the
 * `DispositionAudience` `App.tsx` builds, and the fallback a `FindingCard`
 * rendered with no audience uses — and this project's rule is "when you find
 * yourself writing a second copy, extract it then", not after the third.
 *
 * **It is not yet the only copy, and saying so is the point.** Nine
 * components already carry their own `new Date(at).toLocale…()` expression
 * (`NotesPanel`, `NetPositionPanel`, `MatterActivity`, `MatterHome`,
 * `MattersList`, `VariationTrailModal`, `VersionHistory`, `TemplateLibrary`,
 * `upload/scan.ts`), in four different shapes — a date, a date and time, a
 * long date, a short date. That is pre-existing drift on a field a reader
 * uses to place an event in time, and folding all nine into this would be a
 * behavioural change to nine screens inside a task about attribution. What
 * this does is stop the count reaching ten.
 *
 * `toLocaleString` with no explicit locale, deliberately: the reader's own,
 * which is what every one of those nine already does. A test that needs a
 * stable string injects its own `timeOf` through `DispositionAudience`
 * rather than depending on the runner's timezone.
 */
export function formatInstant(at: number): string {
  return new Date(at).toLocaleString();
}
