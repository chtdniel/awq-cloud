/**
 * Test value helpers.
 *
 * A single place for the constants the suite asserts against, so a changed
 * vocabulary fails in one obvious spot rather than in several scattered literals.
 */

import type { MinimaStatus } from '../../src/minima';

/** Every minima review state, in the order the lifecycle moves through them. */
export const MINIMA_STATUSES: readonly MinimaStatus[] = ['draft', 'approved', 'superseded', 'rejected'];
