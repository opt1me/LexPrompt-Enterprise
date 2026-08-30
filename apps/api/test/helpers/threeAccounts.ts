import { signIn, type TestAccount } from './twoAccounts.ts';

/**
 * A TRAINEE, A PARTNER AND AN ADMIN.
 *
 * `twoAccounts()` answers *"two people in one review"*. Every privilege
 * assertion in Part 5C needs a THIRD shape: a caller who holds the
 * privilege, and two who do not and must be refused for two different
 * reasons — a reviewer because they are a reviewer, a partner because
 * `partner` is not a superset of `admin` (§7: *"an admin is not a
 * super-reviewer"*).
 *
 * A test with only the admin proves the route works and proves nothing about
 * the gate, which is the shape of a test that cannot fail.
 *
 * ## The bystander, which Part 5A needs it for too
 *
 * Stage 4's final review found a third reviewer told *"You asked B. Trainee
 * to look at this"* with a live **Withdraw** button, for a request they had
 * nothing to do with. Proving that closed needs a real third session, not a
 * unit test with three ids in it — the assignee, the assigner, and somebody
 * who is neither. `twoAccounts()` cannot express that at all.
 *
 * The premise is checked rather than assumed: `signIn('admin')` must come
 * back with `role: 'admin'`, or the realm's group mapping is the finding.
 * `nogroups` is deliberately absent — the realm seeds it and the API refuses
 * it by design, so it is not an account anything here can sign in as.
 */
export async function threeAccounts(): Promise<{
  trainee: TestAccount; partner: TestAccount; admin: TestAccount;
}> {
  const [trainee, partner, admin] = await Promise.all([
    signIn('trainee'), signIn('partner'), signIn('admin'),
  ]);
  return { trainee, partner, admin };
}
