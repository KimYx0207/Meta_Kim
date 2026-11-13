/** Producer provenance shared by the hook envelope and Live projections. */
export const LIVE_DEFAULT_RECORD_ORIGIN = "governed_run";
export const LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN = "acceptance_fixture";
export const LIVE_DEMO_RECORD_ORIGIN = "demo";
export const LIVE_RECORD_ORIGINS = Object.freeze([
  LIVE_DEFAULT_RECORD_ORIGIN, LIVE_ACCEPTANCE_FIXTURE_RECORD_ORIGIN, LIVE_DEMO_RECORD_ORIGIN,
]);
export function liveRecordOrigin(record) {
  const declared = record?.recordOrigin || record?.run?.recordOrigin || record?.session?.recordOrigin;
  return LIVE_RECORD_ORIGINS.includes(declared) ? declared : LIVE_DEFAULT_RECORD_ORIGIN;
}
export const liveRecordIsGovernedRun = record => liveRecordOrigin(record) === LIVE_DEFAULT_RECORD_ORIGIN;
