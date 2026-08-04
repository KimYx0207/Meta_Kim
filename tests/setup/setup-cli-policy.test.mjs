import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SETUP_BOOLEAN_ARGS,
  SETUP_VALUE_ARGS,
  SetupCliPolicyError,
  normalizeSetupCliArgs,
  validateSetupCliArgs,
} from "../../scripts/setup-cli-policy.mjs";

describe("setup CLI policy", () => {
  test("accepts supported boolean, separate-value, and equals-value arguments", () => {
    assert.equal(validateSetupCliArgs(["--check", "--silent", "--with-global-hooks"]), true);
    assert.equal(validateSetupCliArgs(["--lang", "zh-CN", "--targets=claude,codex"]), true);
    assert.equal(validateSetupCliArgs(["--silent", "--scope=project"]), true);
    assert.equal(validateSetupCliArgs(["--project-dir", "D:/work", "--dry-run"]), true);
    assert.ok(SETUP_BOOLEAN_ARGS.includes("--project-bootstrap"));
    assert.ok(SETUP_VALUE_ARGS.includes("--deploy-dir"));
  });

  test("normalizes every equals-value form to the same separate-value contract", () => {
    for (const option of SETUP_VALUE_ARGS) {
      const value = option === "--project-dir"
        ? "D:/work=space"
        : option === "--scope"
          ? "project"
          : "value=part";
      assert.deepEqual(
        normalizeSetupCliArgs([`${option}=${value}`]),
        [option, value],
        option,
      );
      assert.equal(validateSetupCliArgs([`${option}=${value}`]), true, option);
      assert.equal(validateSetupCliArgs([option, value]), true, option);
    }
  });

  test("missing values preserve the public error contract", () => {
    assert.throws(
      () => validateSetupCliArgs(["--lang"]),
      (error) => error instanceof SetupCliPolicyError &&
        error.message === "missing value for --lang" && error.showHelp === false,
    );
    for (const option of SETUP_VALUE_ARGS) {
      for (const argv of [[option], [option, ""], [option, "   "], [`${option}=`], [`${option}=   `]]) {
        assert.throws(
          () => validateSetupCliArgs(argv),
          (error) => error instanceof SetupCliPolicyError &&
            error.message === `missing value for ${option}`,
          `${option}: ${JSON.stringify(argv)}`,
        );
      }
    }
  });

  test("unknown options fail closed and request help", () => {
    assert.throws(
      () => validateSetupCliArgs(["--typo"]),
      (error) => error instanceof SetupCliPolicyError &&
        error.message === "unknown option '--typo'" && error.showHelp === true,
    );
  });

  test("scope accepts only the explicit global/project install contract", () => {
    assert.equal(validateSetupCliArgs(["--scope", "global"]), true);
    assert.equal(validateSetupCliArgs(["--scope=project"]), true);
    assert.throws(
      () => validateSetupCliArgs(["--scope", "both"]),
      /expected global or project/,
    );
  });

  test("rebind-runtime-launch is a standalone mode that never rides an install run", () => {
    assert.equal(validateSetupCliArgs(["--rebind-runtime-launch"]), true);
    assert.equal(
      validateSetupCliArgs(["--rebind-runtime-launch", "--targets", "codex"]),
      true,
    );
    for (const conflicting of ["--update", "--check", "--project-bootstrap", "--project-cleanup"]) {
      assert.throws(
        () => validateSetupCliArgs(["--rebind-runtime-launch", conflicting]),
        /conflicting setup modes/,
        conflicting,
      );
    }
  });

  test("mutually exclusive setup modes fail closed", () => {
    assert.throws(
      () => validateSetupCliArgs(["--update", "--check"]),
      /conflicting setup modes/,
    );
    assert.throws(
      () => validateSetupCliArgs(["--project-bootstrap", "--project-cleanup"]),
      /conflicting setup modes/,
    );
  });
});
