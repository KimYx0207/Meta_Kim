import { DEPENDENCY_BASELINE } from "./dependency-baseline.mjs";
import { extractPipShowVersion, readProcessText, runPythonModule } from "./graphify-runtime.mjs";

export const GRAPHIFY_VERSION = DEPENDENCY_BASELINE.graphify.version;
export const GRAPHIFY_PACKAGE = `${DEPENDENCY_BASELINE.graphify.package}==${GRAPHIFY_VERSION}`;

/** Both ordinary and managed installs use the same producer-compatible version. */
export function reconcileGraphifyPackage(python, { inUpdateMode = false,
  runPython = runPythonModule, onAction = () => {} } = {}) {
  const show = () => runPython(python, ["-m", "pip", "show", "graphifyy"]);
  const before = show();
  const installed = before.status === 0;
  const oldVersion = installed ? extractPipShowVersion(readProcessText(before)) : null;
  if (oldVersion === GRAPHIFY_VERSION && !inUpdateMode) {
    return { ok: true, action: "reuse", changed: false, version: oldVersion };
  }
  const action = installed ? "update" : "install";
  onAction(action);
  const result = runPython(python, ["-m", "pip", "install", ...(installed || inUpdateMode ? ["--upgrade"] : []), GRAPHIFY_PACKAGE],
    undefined, { stdio: "pipe" });
  if (result.status !== 0) return { ok: false, action, code: "graphify_package_install_failed", processResult: result };
  const after = show();
  const version = after.status === 0 ? extractPipShowVersion(readProcessText(after)) : null;
  if (version !== GRAPHIFY_VERSION) return { ok: false, action, code: "graphify_package_version_mismatch", processResult: after, version };
  return { ok: true, action, changed: true, version };
}
