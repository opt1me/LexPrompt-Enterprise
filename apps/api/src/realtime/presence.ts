import { subscriptionKey, type PresenceMember, type PresenceScreen, type ServerFrame,
  type SubscriptionRef } from '@lexprompt/core';

/**
 * WHO ELSE IS HERE — EPHEMERAL, ADVISORY, AND GONE WITHIN ITS TTL (§8, S6).
 *
 * ## Presence is the one thing in this system allowed to be wrong
 *
 * Everything else this app renders is a claim about a document or about a
 * person's judgement, and the rule over all of them is *"fail loudly rather
 * than answer quietly wrong"*. Presence cannot meet that bar and does not
 * pretend to: an absent name does not mean nobody is there, and a present
 * name is a claim about a few seconds ago. So the rule applies at a slant —
 * **a stale roster claiming somebody is here is worse than no roster at
 * all**, because a reviewer might defer to a colleague who left ten minutes
 * ago. The TTL is what makes that impossible rather than unlikely, and it is
 * the reason `sweep` exists and runs whether or not anything else happens.
 *
 * ## Never persisted, and this file is the proof rather than the promise
 *
 * There is no `insert`, no `update`, no blob, and no import of anything that
 * could reach either — this module does not import `db/pool.ts` at all, so
 * the absence is structural rather than remembered. *"A stale 'Priya is
 * here' row surviving a crash is a lie the app would tell indefinitely."* A
 * roster lives in one process's memory, expires on a clock, and dies with
 * the process; there is no table to leave a corpse in.
 *
 * ## Advisory: it locks nothing, blocks nothing, gates no write
 *
 * Nothing in this file is consulted by any write path, and
 * `presence.pg.test.ts` asserts a disposition change succeeds while somebody
 * else is present on that clause. Somebody will eventually propose "warn
 * before overwriting while another person is on this clause", and the day
 * that warning becomes a REFUSAL is the day presence stops being advisory
 * and starts being a lock whose correctness nobody has reasoned about. That
 * test is what makes such a change deliberate.
 *
 * ## What is a member, and why the key is a CONNECTION
 *
 * The roster is keyed by connection id, not by user id, and deduplicated by
 * user on the way out. A person with two tabs open is two connections; a
 * roster keyed by user would have the first tab's `leave` remove somebody
 * whose second tab is still watching, and they would flicker back on their
 * own next beat. Keying by connection makes a departure exact.
 */

/** One live beat, as this process holds it. `PresenceMember` is what goes on
 *  the wire and carries neither of the two fields below: `connectionId` is
 *  this process's own bookkeeping, and `at` is the sweep's input — see the
 *  type's own comment for why a timestamp must not reach a browser. */
export interface PresenceBeat {
  connectionId: string;
  userId: string;
  screen: PresenceScreen;
  clauseId?: string;
  /** When this beat arrived, by the receiving replica's clock. */
  at: number;
}

/** Where a beat belongs: one workspace, one subscription. The workspace is
 *  half the key ALWAYS, exactly as it is in `hub.ts` — two firms whose
 *  review ids collide (a review id is minted in a browser and imported) must
 *  never appear on each other's rosters. */
export interface PresenceScope {
  workspaceId: string;
  sub: SubscriptionRef;
}

export interface PresenceRegistry {
  /** Records a beat and broadcasts the roster IF IT CHANGED. */
  beat(scope: PresenceScope, beat: PresenceBeat): void;
  /** Drops one connection from one subscription, or — with no `scope` —
   *  from every subscription it was on, which is what a closed socket
   *  means. Broadcasts each roster that changed. */
  leave(connectionId: string, scope?: PresenceScope): void;
  /** Who this replica believes is on `scope`, deduplicated by person. */
  roster(scope: PresenceScope): PresenceMember[];
  /** Expires every beat older than the TTL. Returns the scopes whose roster
   *  changed, having already broadcast each one. */
  sweep(now: number): PresenceScope[];
  /** How many buckets this registry is holding, for a test and for an
   *  operator counting what a replica keeps in memory. */
  size(): number;
}

export interface PresenceDeps {
  /**
   * How long a beat is believed. `API_PRESENCE_TTL_MS`.
   *
   * INJECTED rather than imported from `config.ts`: the mutation this
   * module's suite turns on is raising it to `Infinity`, and a test that
   * cannot set it could not perform that mutation on the shipped code.
   */
  ttlMs: number;
  /** Sends one frame to everybody joined to `scope`. `hub.publish` in the
   *  server; a recorder in a test. */
  publish(scope: PresenceScope, frame: ServerFrame): void;
}

/**
 * The channel a beat is fanned out on across replicas.
 *
 * PRESENCE IS THE ONE THING THAT RIDES THE NOTIFICATION PAYLOAD, and it is
 * the one thing *because* it is never persisted (P39, interface note 6).
 * Everything durable goes through the outbox and is read by cursor, with
 * `pg_notify` as a doorbell carrying nothing — a lost notification then
 * costs latency and never content. Presence has no outbox to read from
 * (`NOTIFY` stores nothing, and neither does this registry), so the payload
 * IS the delivery, and the cost of losing one is exactly right for an
 * advisory signal: a replica that misses a beat loses that person from its
 * roster for at most one TTL and gets them back on the next beat.
 *
 * A separate channel from `EVENT_CHANNEL` rather than a discriminated
 * payload on it, because `feed.ts`'s handler for that channel reads NOTHING
 * from its payload by design, and giving it a payload to parse is how the
 * doorbell quietly becomes a delivery.
 */
export const PRESENCE_CHANNEL = 'lexprompt_presence';

/** What one replica tells the others. `k` distinguishes an arrival from a
 *  departure: a departure is broadcast rather than left to the far end's TTL
 *  so a colleague's face goes when they close the tab, not fifteen seconds
 *  later — the TTL is the backstop for a replica that crashed, not the
 *  ordinary path. */
export interface PresenceNotification {
  k: 'beat' | 'leave';
  workspaceId: string;
  sub: SubscriptionRef;
  beat: PresenceBeat;
}

export function encodePresence(n: PresenceNotification): string {
  return JSON.stringify(n);
}

/**
 * A notification back into a shape, or `undefined`.
 *
 * VALIDATED even though the only writer is another replica of this same
 * program. A `NOTIFY` payload is a string in a database any role with
 * `pg_notify` can call, and this one is applied to a roster that names
 * people; a malformed one must produce nothing rather than a member whose
 * `userId` is an object.
 */
export function decodePresence(raw: string): PresenceNotification | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const n = parsed as Record<string, unknown>;
  if (n.k !== 'beat' && n.k !== 'leave') return undefined;
  if (typeof n.workspaceId !== 'string' || n.workspaceId.length === 0) return undefined;
  if (typeof n.sub !== 'object' || n.sub === null) return undefined;
  const beat = n.beat as Record<string, unknown> | undefined;
  if (!beat || typeof beat.connectionId !== 'string' || typeof beat.userId !== 'string') {
    return undefined;
  }
  if (typeof beat.screen !== 'string' || typeof beat.at !== 'number') return undefined;
  if (beat.clauseId !== undefined && typeof beat.clauseId !== 'string') return undefined;
  return parsed as PresenceNotification;
}

const bucketKey = (scope: PresenceScope): string =>
  `${scope.workspaceId}|${subscriptionKey(scope.sub)}`;

/**
 * What a roster SAYS, as a comparable string — the change detector.
 *
 * The roster is broadcast ON CHANGE ONLY (§8). A frame per heartbeat per
 * person per subscription, for a roster that has not moved, is one frame
 * every ten seconds per reader for no information at all.
 *
 * `at` is deliberately NOT part of this: every beat moves it, so including
 * it would make every beat a change and the "on change only" rule would
 * silently do nothing. That is also why `at` never reaches the wire.
 */
function signatureOf(members: PresenceMember[]): string {
  return members.map(m => `${m.userId}:${m.screen}:${m.clauseId ?? ''}`).join('|');
}

export function createPresenceRegistry(deps: PresenceDeps): PresenceRegistry {
  /** bucket key -> connection id -> that connection's last beat. */
  const buckets = new Map<string, Map<string, PresenceBeat>>();
  /** bucket key -> the scope it was built from, so a sweep can publish
   *  without reconstructing a `SubscriptionRef` from its key string. */
  const scopes = new Map<string, PresenceScope>();
  /** bucket key -> what was last broadcast, for the change check. */
  const published = new Map<string, string>();

  function membersIn(bucket: Map<string, PresenceBeat> | undefined): PresenceMember[] {
    if (!bucket || bucket.size === 0) return [];
    // DEDUPLICATED BY PERSON, most recent beat winning. Two tabs are one
    // colleague; a roster showing them twice would answer "who else is
    // here" with a number nobody could act on, and showing the older tab's
    // clause would point at the clause they left.
    const latest = new Map<string, PresenceBeat>();
    for (const beat of bucket.values()) {
      const held = latest.get(beat.userId);
      if (!held || beat.at >= held.at) latest.set(beat.userId, beat);
    }
    return [...latest.values()]
      // Sorted so two replicas' rosters of the same people compare equal and
      // a reader's list does not reorder itself on every beat.
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .map(b => ({
        userId: b.userId,
        screen: b.screen,
        ...(b.clauseId === undefined ? {} : { clauseId: b.clauseId }),
      }));
  }

  /** Broadcasts `scope`'s roster if it differs from what was last sent.
   *  Returns whether it did. */
  function broadcastIfChanged(scope: PresenceScope): boolean {
    const key = bucketKey(scope);
    const members = membersIn(buckets.get(key));
    const signature = signatureOf(members);
    if (published.get(key) === signature) return false;
    if (members.length === 0) {
      // The bucket is FORGOTTEN once it is empty — but the empty frame is
      // sent first. That frame is what takes a colleague's face off a
      // clause, and dropping it because "there is nobody to tell about
      // nobody" would leave the last thing every reader was told standing
      // for the rest of their session.
      published.delete(key);
      buckets.delete(key);
      scopes.delete(key);
    } else {
      published.set(key, signature);
    }
    deps.publish(scope, { t: 'presence', sub: scope.sub, members });
    return true;
  }

  return {
    beat(scope, beat) {
      const key = bucketKey(scope);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = new Map<string, PresenceBeat>();
        buckets.set(key, bucket);
      }
      scopes.set(key, scope);
      bucket.set(beat.connectionId, beat);
      broadcastIfChanged(scope);
    },

    leave(connectionId, scope) {
      if (scope) {
        const bucket = buckets.get(bucketKey(scope));
        if (!bucket?.delete(connectionId)) return;
        broadcastIfChanged(scope);
        return;
      }
      // Every bucket this connection was in. A socket closes once and may
      // have been watching a review and a matter.
      for (const [key, bucket] of [...buckets]) {
        if (!bucket.delete(connectionId)) continue;
        const held = scopes.get(key);
        if (held) broadcastIfChanged(held);
      }
    },

    roster(scope) {
      return membersIn(buckets.get(bucketKey(scope)));
    },

    sweep(now) {
      const changed: PresenceScope[] = [];
      for (const [key, bucket] of [...buckets]) {
        let dropped = false;
        for (const [connectionId, beat] of [...bucket]) {
          // STRICTLY OLDER THAN THE TTL. `>` rather than `>=` costs a
          // millisecond of belief and makes the boundary case ("a beat
          // exactly one TTL old") survive rather than vanish, which is the
          // direction a heartbeat arriving on schedule needs.
          if (now - beat.at > deps.ttlMs) {
            bucket.delete(connectionId);
            dropped = true;
          }
        }
        if (!dropped) continue;
        const scope = scopes.get(key);
        if (scope && broadcastIfChanged(scope)) changed.push(scope);
      }
      return changed;
    },

    size() {
      return buckets.size;
    },
  };
}
