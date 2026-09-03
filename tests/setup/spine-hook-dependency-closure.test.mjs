import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SHARED_RUNTIME_HOOK_FILES } from "../../scripts/runtime-hook-mapping.mjs";

/**
 * The hook file lists that drive projection are hand-maintained and duplicated
 * across setup and the sync scripts. A list that ships a hook but omits what
 * that hook imports produces a runtime `ERR_MODULE_NOT_FOUND` in whichever
 * runtime read that list, and every other list stays green. So the expectation
 * here is derived from the real import graph instead of restating a filename.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPINE_ENTRYPOINT = "activate-meta-theory-spine.mjs";
const HOOK_SOURCE_DIRS = ["shared", "claude"].map((runtime) =>
  path.join(REPO_ROOT, "canonical", "runtime-assets", runtime, "hooks"),
);
const PROJECTION_SOURCES = [
  "setup.mjs",
  "scripts/sync-runtimes.mjs",
  "scripts/sync-global-meta-theory.mjs",
  "scripts/discover-global-capabilities.mjs",
];
// Fixtures spawn a hook out of a temp directory, so they need the same closure
// the projection lists need. They are a separate family of lists, and the checks
// above never looked at them: when the spine hook gained an import, all eight
// fixture lists broke at once while every projection list stayed correct.
const FIXTURE_ROOT = path.join(REPO_ROOT, "tests");
const FIXTURE_HELPER = "tests/helpers/hook-fixture.mjs";
const DERIVED_COPY_HELPER = "copyHookClosure";
const COPY_CALL = /\b(?:copyFileSync|cpSync|copyFile)\s*\(/u;
// Copying a directory cannot drift: the fixture gets whatever the canonical tree
// holds, including files added later.
const TREE_COPY = /\b(?:cpSync|cp)\s*\([^;]*\{\s*recursive:\s*true/su;

function hookSourcePaths() {
  const sources = new Map();
  for (const dir of HOOK_SOURCE_DIRS) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".mjs") && !sources.has(name)) sources.set(name, path.join(dir, name));
    }
  }
  return sources;
}

function localImports(filePath) {
  // Usage examples inside doc comments name the module they document, so a raw
  // text scan would read every helper as importing itself.
  const source = readFileSync(filePath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/[^\n]*$/gmu, "");
  const matches = source.matchAll(/from "\.\/([A-Za-z0-9._-]+\.mjs)"/gu);
  const self = path.basename(filePath);
  return [...new Set([...matches].map((match) => match[1]))].filter((name) => name !== self);
}

function dependencyClosure(entrypoint) {
  const sources = hookSourcePaths();
  const ordered = [];
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const filePath = sources.get(name);
    if (!filePath) return;
    for (const dependency of localImports(filePath)) walk(dependency);
    ordered.push(name);
  };
  walk(entrypoint);
  return ordered;
}

// A projected hook list is any array literal of bare string filenames, whether
// it is a plain array, a `new Set([...])`, or a `for (const x of [...])` loop.
function hookFileListLiterals(source) {
  const literals = [];
  for (const match of source.matchAll(/\[[^[\]{}()]*?\]/gsu)) {
    const body = match[0].slice(1, -1);
    if (!body.includes(".mjs")) continue;
    const names = [...body.matchAll(/"([A-Za-z0-9._-]+\.(?:mjs|py|sh|ps1))"/gu)].map((entry) => entry[1]);
    if (names.length === 0) continue;
    const residue = body
      .replace(/"[^"]*"/gu, "")
      .replace(/\/\/[^\n]*/gu, "")
      .replace(/[\s,]/gu, "");
    if (residue.length > 0) continue;
    literals.push({ names, index: match.index });
  }
  return literals;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

// The defect shape is a fixture that hand-names several of the shared hook files
// and copies them one by one. Path text is the wrong signal for it: one fixture
// builds its destination from variables, and another copies all of `canonical/`
// and then runs the real sync script. The names come from the canonical
// directory so a hook added later is covered without editing this list.
function handNamedSharedHooks(source) {
  const sharedHookNames = new Set(
    readdirSync(path.join(REPO_ROOT, "canonical", "runtime-assets", "shared", "hooks")).filter(
      (name) => name.endsWith(".mjs"),
    ),
  );
  const named = new Set();
  for (const match of source.matchAll(/["']([\w.-]+\.mjs)["']/gu)) {
    if (sharedHookNames.has(match[1])) named.add(match[1]);
  }
  return [...named];
}

test("the declared shared hook set covers the real dependency closure of the spine entrypoint", () => {
  const closure = dependencyClosure(SPINE_ENTRYPOINT);
  // A superset is correct: the shared set also carries roots that only other
  // runtime hooks import, such as the skip reminder used by the dispatch gate.
  assert.deepEqual(
    closure.filter((name) => !SHARED_RUNTIME_HOOK_FILES.includes(name)),
    [],
    "SHARED_RUNTIME_HOOK_FILES must cover what the spine hook transitively imports",
  );

  const position = new Map(SHARED_RUNTIME_HOOK_FILES.map((name, index) => [name, index]));
  const sources = hookSourcePaths();
  for (const name of closure) {
    for (const dependency of localImports(sources.get(name))) {
      assert.ok(
        position.get(dependency) < position.get(name),
        `${dependency} must be declared before ${name}, which imports it`,
      );
    }
  }
});

test("every projection list that ships the spine hook also ships what it imports", () => {
  const closure = dependencyClosure(SPINE_ENTRYPOINT);
  const gaps = [];

  for (const relativePath of PROJECTION_SOURCES) {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    for (const literal of hookFileListLiterals(source)) {
      if (!literal.names.includes(SPINE_ENTRYPOINT)) continue;
      const missing = closure.filter((name) => !literal.names.includes(name));
      if (missing.length > 0) {
        gaps.push(`${relativePath}:${lineOf(source, literal.index)} is missing ${missing.join(", ")}`);
      }
    }
  }

  assert.deepEqual(gaps, [], `incomplete spine hook projection lists:\n${gaps.join("\n")}`);
});

test("no test fixture hand-maintains the hook files it stages", () => {
  const offenders = [];
  let derivedStagingSites = 0;

  for (const entry of readdirSync(FIXTURE_ROOT, { recursive: true })) {
    if (!String(entry).endsWith(".mjs")) continue;
    const relativePath = ["tests", ...String(entry).split(path.sep)].join("/");
    if (relativePath === FIXTURE_HELPER) continue;

    const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    if (source.includes(DERIVED_COPY_HELPER)) {
      derivedStagingSites += 1;
      continue;
    }

    // Tests also carry hook name lists that are correct while incomplete — a
    // directory census, the set of Claude compatibility adapters, a sample of
    // projected files to spot-check. Those copy nothing, so only a copying
    // fixture is judged here.
    const copySite = source.search(COPY_CALL);
    if (copySite < 0 || TREE_COPY.test(source)) continue;

    const named = handNamedSharedHooks(source);
    if (named.length >= 2) {
      offenders.push(
        `${relativePath}:${lineOf(source, copySite)} copies ${named.length} hand-named hook files (${named.join(", ")}); use ${DERIVED_COPY_HELPER} from ${FIXTURE_HELPER}`,
      );
    }
  }

  assert.deepEqual(offenders, [], `hand-maintained hook staging in tests:\n${offenders.join("\n")}`);
  // Guards the walk itself: a wrong root or a stale extension filter would read
  // zero fixtures and report zero offenders for every possible defect.
  assert.ok(
    derivedStagingSites >= 2,
    `expected the fixture scan to reach the hook-staging tests, saw ${derivedStagingSites}`,
  );
});

test("at least one projection list per script is actually inspected", () => {
  // Guards the extractor itself: a regex that silently matches nothing would
  // make the gap check above pass for every possible defect.
  for (const relativePath of PROJECTION_SOURCES) {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    const shipping = hookFileListLiterals(source).filter((literal) =>
      literal.names.includes(SPINE_ENTRYPOINT),
    );
    assert.ok(
      shipping.length > 0,
      `${relativePath} must expose at least one recognizable spine hook list`,
    );
  }
});
