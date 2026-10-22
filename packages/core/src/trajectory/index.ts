/**
 * The session log, read for a person.
 *
 * One stream, three uses: viewing it by source, searching it, and forking from a point in it. They
 * share a reader deliberately — separate definitions of "what happened" are chances to disagree
 * about it.
 */

export { readTrajectory } from "./read.ts";
export { TrajectoryReader } from "./changes.ts";
export type { TrajectoryChanges } from "./types.ts";
export { countBySource, filterTrajectory, matchRanges } from "./filter.ts";
export { forkAfterMessage, forkBeforeMessage, forkSession } from "./fork.ts";
export type { Entry } from "./types.ts";
