const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** A numerical promise is part of the existing acceptance contract, not a score. */
export function normalizeMeasurementRule(value) {
  const fields = ['kind', 'unit', 'scope', 'conditions', 'comparison', 'target', 'minimumSamples', 'expectedTotal'];
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key)) ||
      !['count', 'duration', 'ratio', 'value'].includes(value.kind) ||
      !['unit', 'scope', 'conditions'].every(key => text(value[key])) ||
      !['lte', 'gte', 'eq'].includes(value.comparison) || !Number.isFinite(value.target) ||
      (value.minimumSamples !== undefined && (!Number.isSafeInteger(value.minimumSamples) || value.minimumSamples < 1))) {
    throw new TypeError('Measurement requires a known kind, unit, scope, conditions, comparison, finite target and positive sample count');
  }
  if (value.kind === 'count' && (!Number.isSafeInteger(value.target) || value.target < 0)) {
    throw new TypeError('Count targets must be nonnegative safe integers');
  }
  if (value.kind === 'duration' && (!['ms', 's'].includes(value.unit) || value.target < 0)) {
    throw new TypeError('Duration targets require milliseconds or seconds and a nonnegative limit');
  }
  if (value.kind === 'ratio' && (!['ratio', 'percent'].includes(value.unit) ||
      !Number.isSafeInteger(value.expectedTotal) || value.expectedTotal <= 0 ||
      value.target < 0 || value.target > (value.unit === 'percent' ? 100 : 1))) {
    throw new TypeError('Coverage requires a bound positive denominator and a target in the declared ratio unit');
  }
  if (value.kind !== 'ratio' && value.expectedTotal !== undefined) {
    throw new TypeError('Only ratio measurements have an expectedTotal');
  }
  return {
    kind: value.kind, unit: value.unit.trim(), scope: value.scope.trim(), conditions: value.conditions.trim(),
    comparison: value.comparison, target: value.target, minimumSamples: value.minimumSamples ?? 1,
    ...(value.kind === 'ratio' ? { expectedTotal: value.expectedTotal } : {}),
  };
}

/** Calculate from supplied, evidence-bound records; authenticating their producer
 * remains the existing host/independent-review responsibility. */
export function evaluateNumericMeasurement(rule, observation) {
  const invalid = reason => ({ status: 'invalid', reason });
  if (observation === undefined || observation === null) return { status: 'missing', reason: 'numeric_measurement_missing' };
  if (!object(observation) || observation.unit !== rule.unit || observation.scope !== rule.scope || observation.conditions !== rule.conditions) {
    return invalid('numeric_measurement_context_mismatch');
  }
  if (!Array.isArray(observation.samples)) return invalid('numeric_samples_invalid');
  const ids = new Set();
  const evidence = new Set();
  const results = [];
  for (const sample of observation.samples) {
    if (!object(sample) || !text(sample.id) || !text(sample.evidenceRef) || !digest(sample.evidenceDigest)) {
      return invalid('numeric_sample_evidence_missing');
    }
    // Renaming an evidence path or a sample never creates an independent run.
    if (ids.has(sample.id) || evidence.has(sample.evidenceDigest)) return invalid('numeric_sample_replayed');
    ids.add(sample.id); evidence.add(sample.evidenceDigest);
    let value;
    if (rule.kind === 'count' || rule.kind === 'ratio') {
      const entries = sample[rule.kind === 'count' ? 'eventIds' : 'itemIds'];
      if (!Array.isArray(entries) || entries.some(id => !text(id))) return invalid('numeric_event_identities_invalid');
      const count = new Set(entries).size;
      if (rule.kind === 'ratio' && count > rule.expectedTotal) return invalid('numeric_coverage_exceeds_population');
      value = rule.kind === 'count' ? count : count / rule.expectedTotal * (rule.unit === 'percent' ? 100 : 1);
    } else if (rule.kind === 'duration') {
      if (!Number.isFinite(sample.startedAt) || !Number.isFinite(sample.finishedAt) ||
          sample.startedAt < 0 || sample.finishedAt < sample.startedAt) return invalid('numeric_clock_invalid');
      value = (sample.finishedAt - sample.startedAt) / (rule.unit === 's' ? 1000 : 1);
    } else {
      if (!Number.isFinite(sample.value)) return invalid('numeric_value_invalid');
      value = sample.value;
    }
    if (!Number.isFinite(value)) return invalid('numeric_value_invalid');
    const passed = rule.comparison === 'lte' ? value <= rule.target : rule.comparison === 'gte' ? value >= rule.target : value === rule.target;
    results.push({ sampleId: sample.id, value, passed, evidenceRef: sample.evidenceRef, evidenceDigest: sample.evidenceDigest });
  }
  const status = results.some(result => !result.passed) ? 'fail'
    : results.length < rule.minimumSamples ? 'missing' : 'pass';
  return { status, reason: status === 'fail' ? 'numeric_target_not_met'
    : status === 'missing' ? 'numeric_sample_count_not_met' : 'numeric_target_met',
  kind: rule.kind, unit: rule.unit, target: rule.target, comparison: rule.comparison,
  scope: rule.scope, conditions: rule.conditions, minimumSamples: rule.minimumSamples,
  sampleCount: results.length, ...(rule.kind === 'ratio' ? { expectedTotal: rule.expectedTotal } : {}), samples: results,
  evidenceBoundary: 'Calculated from supplied measurement records; source authenticity and live execution require host evidence.' };
}
