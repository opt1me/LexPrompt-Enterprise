export function debug(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log('[lexprompt]', ...args);
  }
}
