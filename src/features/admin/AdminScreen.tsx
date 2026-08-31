import React from 'react';
import type { AdminSection } from '../../lib/router';
import { ADMIN_SECTIONS } from '../../lib/router';
import type { RoleState } from '../../lib/role';
import { RoleMappingPanel } from './RoleMappingPanel';

/**
 * §7's ADMINISTRATION SCREENS — a shell with four sections, behind a role.
 *
 * ## The gate here is a COURTESY, and the API is the control
 *
 * Every route these panels call is `admin` in `ROUTE_POLICY` and is refused
 * by the server whatever this component renders (§18 item 3). What the check
 * below buys is different and still worth having: a non-administrator who
 * reaches `/admin/roles` by URL gets a refusal that says what to do, instead
 * of a half-drawn screen whose every fetch 403s — which reads as a broken
 * application rather than as a boundary.
 *
 * ## Three states, never two
 *
 * `useRole()` has `unknown`, `known` and `failed`, and this renders all
 * three. Treating `unknown` as "not an admin" would be a refusal produced by
 * a loading state, and treating it as "an admin" would be the opposite and
 * worse.
 */

export interface AdminScreenProps {
  section: AdminSection;
  role: RoleState;
  onSelect(section: AdminSection): void;
}

const SECTION_LABEL: Record<AdminSection, string> = {
  roles: 'Roles',
  people: 'People',
  providers: 'Providers',
  audit: 'Audit export',
};

/** Complete literal class names per state — never built by interpolation. */
const TAB_CLASS = {
  on: 'font-ui text-ui-sm px-2.5 py-1.5 rounded-inset font-semibold text-ink-1 bg-accent-tint',
  off: 'font-ui text-ui-sm px-2.5 py-1.5 rounded-inset font-medium text-ink-3 hover:text-ink-1',
};

export function AdminScreen({ section, role, onSelect }: AdminScreenProps) {
  if (role.status === 'unknown') {
    return (
      <div className="p-8 font-ui text-ui text-ink-3" data-busy="true" aria-live="polite">
        Checking what you can do…
      </div>
    );
  }

  if (role.status === 'failed') {
    return (
      <div className="p-8 max-w-lg mx-auto space-y-3 text-center">
        <p className="font-prose text-screen-title text-ink-1">
          LexPrompt could not check what you are allowed to do.
        </p>
        <p className="font-ui text-ui text-ink-3">
          This is not a refusal — it is a check that did not complete. Reload the page; if it
          keeps happening, this is something an administrator has to look at.
        </p>
      </div>
    );
  }

  if (role.role !== 'admin') {
    return (
      <div className="p-8 max-w-lg mx-auto space-y-3 text-center">
        <p className="font-prose text-screen-title text-ink-1">
          These screens are for administrators.
        </p>
        <p className="font-ui text-ui text-ink-3">
          Your LexPrompt role is {role.role}. Ask an administrator if you need something changed
          here — nothing on these screens would work for you if it were shown, because the
          server refuses each of these requests as well.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <nav className="flex items-center gap-2 border-b border-rule pb-3" aria-label="Administration">
        {ADMIN_SECTIONS.map(s => (
          <button
            key={s}
            type="button"
            onClick={() => onSelect(s)}
            aria-current={s === section ? 'page' : undefined}
            className={s === section ? TAB_CLASS.on : TAB_CLASS.off}
          >
            {SECTION_LABEL[s]}
          </button>
        ))}
      </nav>

      {section === 'roles' && <RoleMappingPanel />}
      {section !== 'roles' && (
        /*
         * NAMED AS NOT BUILT YET rather than rendered as an empty section.
         * The three remaining panels arrive in Tasks 12, 14 and 15; a blank
         * tab in the meantime is indistinguishable from a firm with no
         * people, no providers and no audit trail.
         */
        <p className="font-ui text-ui text-ink-3">
          {SECTION_LABEL[section]} is not built yet. Nothing is missing from this workspace —
          this screen is.
        </p>
      )}
    </div>
  );
}
