/**
 * Where a persisted run record came from.
 *
 * A projection built from an acceptance fixture runs through the same pipeline
 * as a real run and lands in the same governed-executions directory, so the two
 * files are indistinguishable once written. Origin therefore has to be declared
 * by the producer and carried on the record: a reader cannot recover it later,
 * and an unmarked fixture reads as the most complete row in the directory
 * because a fixture always has the worker counts and runtime a real activation
 * often lacks. Measured on this repo before the contract existed: the only two
 * of 44 rows carrying worker counts and a resolved runtime were both fixtures,
 * and they sorted above every real run.
 *
 * Absent means governed run, so existing real records need no migration, and an
 * unrecognized value collapses to the same neutral default rather than reaching
 * a reader as a self-declared label.
 *
 * The service, the hub catalog and the fixture writer all read this one
 * definition. Two independent definitions would let the directory and the detail
 * view disagree about whether the same file is real.
 */
export {
  LIVE_DEFAULT_RECORD_ORIGIN, LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN, LIVE_DEMO_RECORD_ORIGIN,
  LIVE_RECORD_ORIGINS, liveRecordOrigin, liveRecordIsGovernedRun,
} from "../../../canonical/runtime-assets/shared/hooks/live-record-origin.mjs";

/**
 * Declaration order is the weight order the selection policy validates against,
 * best-provenance first. The vocabulary is derived from the named constants
 * rather than repeating the literals, so a producer that stamps a record and the
 * reader that ranks it cannot drift apart.
 */
