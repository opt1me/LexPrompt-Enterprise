import { DEBUG } from './config';

export function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[lexprompt]', ...args);
  }
}
