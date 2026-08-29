import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MAIN = readFileSync(path.resolve(__dirname, 'main.tsx'), 'utf8');

/**
 * Two properties of the entry point that no component test can reach,
 * because both are about what happens BEFORE any component mounts.
 *
 * Scanned as source rather than executed: importing `main.tsx` in a test
 * would mount the real app against a real IndexedDB, and the thing under
 * test here is the module's own top-level shape.
 */
describe('the entry point', () => {
  /**
   * m4. `src/lib/config.ts` throws during module EVALUATION when a `VITE_*`
   * value is missing — deliberately, so a missing identity configuration
   * cannot become an app that runs and mostly works. With a static
   * `import App from './App'`, that throw happened before `createRoot(...)`
   * ran at all: the `ErrorBoundary` written to report it never mounted, and
   * the user got a white screen, indistinguishable from a broken CDN.
   */
  it('imports App dynamically, so a config throw can still be rendered', () => {
    expect(MAIN).not.toMatch(/^import App from/m);
    expect(MAIN).toContain("import('./App')");
    // …and the rejection is actually caught and rendered, not logged.
    expect(MAIN).toMatch(/\.catch\(/);
    expect(MAIN).toMatch(/root\.render\(<CrashScreen/);
  });

  /**
   * m3. `loadSettings` is where a stored OpenRouter key is deleted, and its
   * only other caller is `AppShell`'s `useState` initializer — which `App`
   * renders INSTEAD of `SignInScreen` for every status but `signed-in`. A
   * user who could not sign in therefore kept a live credential in
   * `localStorage` indefinitely, in a browser with no code left that could
   * use it. Stage 1's definition of done says no OpenRouter key exists in
   * ANY browser; that is only true if the purge runs before the gate.
   */
  it('purges any stored provider key before the sign-in gate, not inside it', () => {
    expect(MAIN).toContain('loadSettings');
    const purgeAt = MAIN.indexOf('loadSettings();');
    const renderAt = MAIN.indexOf("import('./App')");
    expect(purgeAt).toBeGreaterThan(-1);
    expect(purgeAt).toBeLessThan(renderAt);
  });
});
