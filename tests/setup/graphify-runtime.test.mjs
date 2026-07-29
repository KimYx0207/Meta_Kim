import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  detectPython310,
  extractPipShowVersion,
  formatPythonLauncher,
  homebrewPythonCandidates,
  pythonCandidates,
  runPythonModule,
  meetsMinimumVersion,
  checkNetworkx,
  ensurePip,
  discoverWindowsPythonPathCommands,
  resolveGraphifyExecutable,
} from "../../scripts/graphify-runtime.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");

describe("project-post-copy-init graphify bootstrap", () => {
  test("uses the shared Python detector instead of a local launcher list", () => {
    const source = readFileSync(
      join(repoRoot, "scripts", "project-post-copy-init.mjs"),
      "utf8",
    );

    assert.match(source, /detectPython310/);
    assert.match(source, /bootstrapPip:\s*true/);
    assert.doesNotMatch(source, /function pythonCandidates/);
  });
});

describe("detectPython310()", () => {
  test("detects python when version is printed to stderr", () => {
    const python = detectPython310((command) => {
      if (command === "python3") {
        return {
          status: 0,
          stdout: "",
          stderr: "Python 3.11.7",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
        error: new Error("not found"),
      };
    }, "linux");

    assert.equal(python.command, "python3");
    assert.equal(python.version.major, 3);
    assert.equal(python.version.minor, 11);
  });

  test("prefers py -3 on Windows when available", () => {
    const calls = [];
    const python = detectPython310((command, args) => {
      calls.push([command, args]);
      if (command === "py") {
        return {
          status: 0,
          stdout: "Python 3.12.1",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
        error: new Error("not found"),
      };
    }, "win32");

    assert.equal(python.command, "py");
    assert.deepEqual(python.args, ["-3"]);
    assert.deepEqual(calls[0], ["py", ["-3", "--version"]]);
  });

  test("skips a version-compatible interpreter when pip is unavailable", () => {
    const python = detectPython310((command, args) => {
      const joined = args.join(" ");
      if (joined === "-m pip --version") {
        return {
          status: command === "python" ? 0 : 1,
          stdout: command === "python" ? "pip 24.0" : "",
          stderr: command === "python" ? "" : "No module named pip",
        };
      }
      if (joined === "--version") {
        return {
          status: 0,
          stdout: command === "python3" ? "Python 3.11.7" : "Python 3.12.1",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    }, "linux", { requirePip: true });

    assert.equal(python.command, "python");
    assert.equal(python.version.minor, 12);
  });

  test("can bootstrap missing pip with ensurepip before selecting Python", () => {
    let pipChecks = 0;
    const python = detectPython310((command, args) => {
      assert.equal(command, "python3");
      const joined = args.join(" ");
      if (joined === "--version") {
        return { status: 0, stdout: "Python 3.11.7", stderr: "" };
      }
      if (joined === "-m pip --version") {
        pipChecks += 1;
        return pipChecks === 1
          ? { status: 1, stdout: "", stderr: "No module named pip" }
          : { status: 0, stdout: "pip 24.0", stderr: "" };
      }
      if (joined === "-m ensurepip --upgrade") {
        return { status: 0, stdout: "Successfully installed pip", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    }, "linux", { requirePip: true, bootstrapPip: true });

    assert.equal(python.command, "python3");
    assert.equal(python.pipBootstrapped, true);
  });

  test("falls back to Homebrew Python when PATH launchers are unavailable", () => {
    const calls = [];
    const python = detectPython310((command, args) => {
      calls.push([command, args]);
      if (
        command === "/opt/homebrew/bin/python3" &&
        args.join(" ") === "--version"
      ) {
        return { status: 0, stdout: "Python 3.12.2", stderr: "" };
      }
      if (
        command === "/opt/homebrew/bin/python3" &&
        args.join(" ") === "-m pip --version"
      ) {
        return { status: 0, stdout: "pip 24.3", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "", error: new Error("missing") };
    }, "darwin", { requirePip: true, env: {} });

    assert.equal(python.command, "/opt/homebrew/bin/python3");
    assert.equal(python.version.minor, 12);
    assert.deepEqual(calls[0], ["python3", ["--version"]]);
    assert.deepEqual(calls[1], ["python", ["--version"]]);
  });
});

describe("pythonCandidates()", () => {
  test("macOS keeps PATH launchers first and includes Homebrew paths", () => {
    const candidates = pythonCandidates("darwin", {
      HOMEBREW_PREFIX: "/custom/homebrew",
    });

    assert.deepEqual(candidates.slice(0, 2), [
      { command: "python3", args: [] },
      { command: "python", args: [] },
    ]);
    assert(candidates.some((candidate) => candidate.command === "/custom/homebrew/bin/python3"));
    assert(candidates.some((candidate) => candidate.command === "/opt/homebrew/bin/python3"));
    assert(candidates.some((candidate) => candidate.command === "/usr/local/bin/python3"));
    assert(
      candidates.some(
        (candidate) =>
          candidate.command ===
          "/custom/homebrew/opt/python@3.12/bin/python3.12",
      ),
    );
  });

  test("Linux includes Linuxbrew paths after PATH launchers", () => {
    const candidates = pythonCandidates("linux", {});

    assert.deepEqual(candidates.slice(0, 2), [
      { command: "python3", args: [] },
      { command: "python", args: [] },
    ]);
    assert(
      candidates.some(
        (candidate) =>
          candidate.command === "/home/linuxbrew/.linuxbrew/bin/python3",
      ),
    );
  });
});

describe("homebrewPythonCandidates()", () => {
  test("deduplicates HOMEBREW_PREFIX when it matches a default prefix", () => {
    const candidates = homebrewPythonCandidates("darwin", {
      HOMEBREW_PREFIX: "/opt/homebrew",
    });
    const matches = candidates.filter(
      (candidate) => candidate.command === "/opt/homebrew/bin/python3",
    );

    assert.equal(matches.length, 1);
  });
});

describe("runPythonModule()", () => {
  test("reuses the same interpreter for pip installs", () => {
    const calls = [];
    runPythonModule(
      { command: "py", args: ["-3"] },
      ["-m", "pip", "install", "graphifyy"],
      (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    assert.deepEqual(calls[0], {
      command: "py",
      args: ["-3", "-m", "pip", "install", "graphifyy"],
      options: {
        encoding: "utf8",
        shell: false,
      },
    });
  });
});

describe("graphify helpers", () => {
  test("resolves the installed Graphify executable through the selected Python launcher", () => {
    const calls = [];
    const executable = resolveGraphifyExecutable(
      { command: "py", args: ["-3.11"] },
      (command, args, options) => {
        calls.push({ command, args, options });
        return {
          status: 0,
          stdout: "C:\\Users\\Kim\\AppData\\Roaming\\Python\\Python311\\Scripts\\graphify.EXE\n",
          stderr: "",
        };
      },
    );
    assert.equal(executable, String.raw`C:\Users\Kim\AppData\Roaming\Python\Python311\Scripts\graphify.EXE`);
    assert.equal(calls[0].command, "py");
    assert.deepEqual(calls[0].args.slice(0, 2), ["-3.11", "-c"]);
    assert.doesNotMatch(calls[0].args[2], /shutil\.which/);
    assert.match(calls[0].args[2], /sysconfig\.get_path/);
    assert.match(calls[0].args[2], /sysconfig\.get_preferred_scheme\("user"\)/);
    assert.match(calls[0].args[2], /site\.USER_BASE/);
    assert.deepEqual(calls[0].options, { encoding: "utf8", shell: false });
  });

  test("does not fall back to a stale PATH Graphify when selected-Python candidates are missing", () => {
    let resolverSource = "";
    const executable = resolveGraphifyExecutable(
      { command: "C:/Python313/python.exe", args: [] },
      (_command, args) => {
        resolverSource = args.at(-1);
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    assert.equal(executable, null);
    assert.doesNotMatch(resolverSource, /shutil\.which|\bPATH\b/u);
    assert.match(resolverSource, /sys\.executable/);
    assert.match(resolverSource, /sysconfig\.get_path\("scripts"\)/);
  });

  test("extractPipShowVersion reads version from pip show output", () => {
    assert.equal(
      extractPipShowVersion("Name: graphifyy\nVersion: 1.2.3\nSummary: test"),
      "1.2.3",
    );
  });

  test("formatPythonLauncher renders launcher arguments", () => {
    assert.equal(
      formatPythonLauncher({ command: "py", args: ["-3"] }),
      "py -3",
    );
  });
});

describe("discoverWindowsPythonPathCommands()", () => {
  test("reads all python.exe entries from PATH instead of only the first", () => {
    const commands = discoverWindowsPythonPathCommands((command, args) => {
      assert.equal(command, "where.exe");
      if (args[0] === "python") {
        return {
          status: 0,
          stdout:
            "C:\\repo\\.venv\\Scripts\\python.exe\r\nC:\\Python312\\python.exe\r\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    assert.deepEqual(commands, [
      { command: "C:\\repo\\.venv\\Scripts\\python.exe", args: [] },
      { command: "C:\\Python312\\python.exe", args: [] },
    ]);
  });
});

describe("ensurePip()", () => {
  test("uses ensurepip when pip is missing", () => {
    const calls = [];
    let pipChecks = 0;
    const result = ensurePip({ command: "python", args: [] }, (command, args) => {
      calls.push([command, args]);
      if (args.join(" ") === "-m pip --version") {
        pipChecks += 1;
        return pipChecks === 1
          ? { status: 1, stdout: "", stderr: "No module named pip" }
          : { status: 0, stdout: "pip 24.0", stderr: "" };
      }
      if (args.join(" ") === "-m ensurepip --upgrade") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    assert.equal(result.ok, true);
    assert.equal(result.bootstrapped, true);
    assert.deepEqual(calls.map((call) => call[1]), [
      ["-m", "pip", "--version"],
      ["-m", "ensurepip", "--upgrade"],
      ["-m", "pip", "--version"],
    ]);
  });
});

describe("meetsMinimumVersion()", () => {
  test("returns true when version meets minimum", () => {
    assert.equal(meetsMinimumVersion("3.6.1", 3, 4), true);
    assert.equal(meetsMinimumVersion("3.4.0", 3, 4), true);
    assert.equal(meetsMinimumVersion("4.0.0", 3, 4), true);
  });

  test("returns false when version is below minimum", () => {
    assert.equal(meetsMinimumVersion("3.1.0", 3, 4), false);
    assert.equal(meetsMinimumVersion("3.3.9", 3, 4), false);
    assert.equal(meetsMinimumVersion("2.9.1", 3, 4), false);
  });

  test("returns false for unparseable input", () => {
    assert.equal(meetsMinimumVersion("unknown", 3, 4), false);
    assert.equal(meetsMinimumVersion("", 3, 4), false);
  });
});

describe("checkNetworkx()", () => {
  const python = { command: "python", args: [] };

  test("detects compatible networkx", () => {
    const result = checkNetworkx(python, () => ({
      status: 0,
      stdout: "Name: networkx\nVersion: 3.6.1\nSummary: test",
      stderr: "",
    }));
    assert.equal(result.installed, true);
    assert.equal(result.version, "3.6.1");
    assert.equal(result.meets, true);
  });

  test("detects incompatible networkx", () => {
    const result = checkNetworkx(python, () => ({
      status: 0,
      stdout: "Name: networkx\nVersion: 3.1\nSummary: test",
      stderr: "",
    }));
    assert.equal(result.installed, true);
    assert.equal(result.version, "3.1");
    assert.equal(result.meets, false);
  });

  test("handles missing networkx", () => {
    const result = checkNetworkx(python, () => ({
      status: 1,
      stdout: "",
      stderr: "WARNING: Package(s) not found: networkx",
    }));
    assert.equal(result.installed, false);
    assert.equal(result.meets, false);
  });
});
