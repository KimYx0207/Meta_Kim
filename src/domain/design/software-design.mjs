/** Software-specific views of the existing product design. This module owns no
 * task queue, approval, runtime selection or execution state. */
const text = value => typeof value === "string" && value.trim().length > 0;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
function requireThat(condition, message) { if (!condition) throw new TypeError(message); }
function rows(value, label) {
  requireThat(Array.isArray(value), `${label} must be an array`);
  const ids = value.map(row => row?.id);
  requireThat(ids.every(text) && new Set(ids).size === ids.length, `${label} requires unique IDs`);
  return new Set(ids);
}
function references(value, known, label, required = false) {
  requireThat(strings(value) && (!required || value.length > 0) && value.every(id => known.has(id)), `${label} references missing or duplicate current IDs`);
}

export function normalizeSoftwareDesign({ input, design, settledDecisionIds, criterionIds }) {
  if (input == null) return null;
  requireThat(object(input) && input.schemaVersion === 1, "Software design requires schemaVersion 1");
  const result = structuredClone(input);
  const architecture = result.architecture;
  requireThat(object(architecture) && text(architecture.id) && Number.isInteger(architecture.revision) && architecture.revision > 0 && text(architecture.summary), "Architecture needs identity, revision and a concrete system summary");
  references(architecture.decisionRefs, settledDecisionIds, "Architecture decisions");
  const technologies = architecture.technologyChoices;
  rows(technologies, "Technology choices");
  requireThat(design.mode !== "delivery" || technologies.length > 0, "Software delivery needs an evidenced technology baseline");
  for (const choice of technologies) requireThat(text(choice.name) && text(choice.version) && text(choice.rationale) && strings(choice.evidenceRefs) && choice.evidenceRefs.length > 0, "Technology choice needs version, rationale and evidence");
  rows(architecture.constraints, "Architecture constraints");
  for (const constraint of architecture.constraints) requireThat(text(constraint.requirement) && text(constraint.verification), "Architecture constraint needs a requirement and verification procedure");
  const modules = result.modules;
  const moduleIds = rows(modules, "Software modules");
  references(architecture.moduleIds, moduleIds, "Architecture module boundary", design.mode === "delivery");
  requireThat(architecture.moduleIds.length === moduleIds.size, "Architecture must account for every module");
  const journeys = new Set(design.userJourneys.map(row => row.id));
  const interfaces = new Set((design.interfaces ?? []).map(row => row.id));
  const states = new Set((design.sharedState ?? []).map(row => row.id));
  const tasks = new Map(design.taskSlices.map(row => [row.id, row]));
  for (const module of modules) {
    requireThat(text(module.purpose), "Module needs a user purpose");
    if (design.mode === "delivery" || module.implementationNotes !== undefined) requireThat(text(module.implementationNotes), "Module needs an implementation approach");
    for (const key of ["journeyRefs", "decisionRefs", "interfaceRefs", "stateRefs", "taskIds", "acceptanceCriterionIds"]) module[key] ??= [];
    references(module.journeyRefs, journeys, "Module journeys");
    references(module.decisionRefs, settledDecisionIds, "Module decisions");
    references(module.interfaceRefs, interfaces, "Module interfaces");
    references(module.stateRefs, states, "Module shared state");
    references(module.taskIds, new Set(tasks.keys()), "Module tasks", design.mode === "delivery");
    references(module.acceptanceCriterionIds, criterionIds, "Module acceptance criteria", design.mode === "delivery");
    if (design.mode === "delivery" || module.businessRules !== undefined) requireThat(strings(module.businessRules) && module.businessRules.length > 0, "Module requires explicit business rules");
    if (design.mode === "delivery" || module.states !== undefined) requireThat(Array.isArray(module.states) && module.states.length > 0 && module.states.every(state => text(state.name) && text(state.behavior)) && new Set(module.states.map(state => state.name)).size === module.states.length, "Module requires distinct observable interaction or domain states");
    requireThat(Array.isArray(module.removalCandidates ?? []), "Removal candidates must be an array");
    for (const candidate of module.removalCandidates ?? []) requireThat(text(candidate.path) && text(candidate.replacement) && text(candidate.reason) && strings(candidate.evidenceRefs) && candidate.evidenceRefs.length > 0, "Removal candidate needs a replacement, reason and evidence; it is not deletion authority");
    if (design.mode === "delivery") {
      for (const criterion of module.acceptanceCriterionIds) requireThat(module.taskIds.some(id => tasks.get(id).criterionIds.includes(criterion)), "Module acceptance must be covered by its actual tasks");
      for (const id of module.taskIds) {
        const task = tasks.get(id);
        requireThat(task.criterionIds.some(criterion => module.acceptanceCriterionIds.includes(criterion)), "Module task must contribute to its acceptance criteria");
        const actualInterfaces = new Set([...(task.interfaceRefs ?? []), ...(design.interfaces ?? [])
          .filter(contract => contract.producerTaskId === id || contract.consumerTaskIds.includes(id)).map(contract => contract.id)]);
        const actualStates = new Set([...(task.stateRefs ?? []), ...(design.sharedState ?? [])
          .filter(state => state.ownerTaskId === id || state.consumerTaskIds?.includes(id)).map(state => state.id)]);
        for (const ref of actualInterfaces) requireThat(module.interfaceRefs.includes(ref), "Module task consumes an interface outside its declared boundary");
        for (const ref of actualStates) requireThat(module.stateRefs.includes(ref), "Module task consumes shared state outside its declared boundary");
      }
    }
  }
  if (design.mode === "delivery") for (const task of design.taskSlices.filter(task => task.workKind !== "support")) requireThat(modules.some(module => module.taskIds.includes(task.id)), "Every implementation task must belong to a software module");
  return result;
}

export function softwareDesignForTask(softwareDesign, taskId) {
  if (!softwareDesign) return null;
  const modules = softwareDesign.modules.filter(module => module.taskIds.includes(taskId));
  return { schemaVersion: 1, architecture: structuredClone(softwareDesign.architecture), modules: structuredClone(modules),
    boundary: "Current single-PRD context. Removal candidates require source and usage verification before any deletion." };
}

/** Host-declared semantic changes are projected through existing module/task
 * relationships. Dependency closure remains the existing design authority. */
export function softwareAffectedTasks(softwareDesign, revision, taskSlices = []) {
  const architectureIds = revision.changedArchitectureIds ?? [];
  const moduleIds = revision.changedModuleIds ?? [];
  const decisionIds = revision.changedDecisionIds ?? [];
  for (const [label, values] of [["architecture", architectureIds], ["module", moduleIds], ["decision", decisionIds]]) requireThat(strings(values), `Changed ${label} IDs must be unique strings`);
  if (!softwareDesign) {
    requireThat(!architectureIds.length && !moduleIds.length && !decisionIds.length, "Software change references require the current software design");
    return [];
  }
  references(architectureIds, new Set([softwareDesign.architecture.id]), "Changed architecture");
  references(moduleIds, new Set(softwareDesign.modules.map(module => module.id)), "Changed modules");
  const knownDecisions = new Set([...softwareDesign.architecture.decisionRefs, ...softwareDesign.modules.flatMap(module => module.decisionRefs),
    ...taskSlices.flatMap(task => task.decisionRefs ?? [])]);
  references(decisionIds, knownDecisions, "Changed decisions");
  const architectureChanged = architectureIds.length > 0 || softwareDesign.architecture.decisionRefs.some(id => decisionIds.includes(id));
  return [...new Set([...softwareDesign.modules.filter(module => architectureChanged || moduleIds.includes(module.id) || module.decisionRefs.some(id => decisionIds.includes(id))).flatMap(module => module.taskIds),
    ...taskSlices.filter(task => task.decisionRefs?.some(id => decisionIds.includes(id))).map(task => task.id)])];
}
