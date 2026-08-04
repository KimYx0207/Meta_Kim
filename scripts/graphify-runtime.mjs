import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";

export function readProcessText(result) {
  const stdout =
    typeof result?.stdout === "string"
      ? result.stdout
      : (result?.stdout?.toString?.("utf8") ?? "");
  const stderr =
    typeof result?.stderr === "string"
      ? result.stderr
      : (result?.stderr?.toString?.("utf8") ?? "");
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

export function parsePythonVersion(text) {
  const match = text.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
    raw: match[0],
  };
}

function pushUniqueCandidate(candidates, seen, command, args = []) {
  const key = `${command}\0${args.join("\0")}`;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({ command, args });
}

export function homebrewPythonCandidates(
  platform = process.platform,
  env = process.env,
) {
  if (platform !== "darwin" && platform !== "linux") {
    return [];
  }

  const prefixes = [];
  const addPrefix = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && !prefixes.includes(trimmed)) {
      prefixes.push(trimmed);
    }
  };

  addPrefix(env.HOMEBREW_PREFIX);
  if (platform === "darwin") {
    addPrefix("/opt/homebrew");
    addPrefix("/usr/local");
  } else {
    addPrefix("/home/linuxbrew/.linuxbrew");
  }

  const candidates = [];
  const seen = new Set();
  const supportedMinors = Array.from({ length: 11 }, (_, index) => 20 - index);

  for (const prefix of prefixes) {
    pushUniqueCandidate(candidates, seen, posix.join(prefix, "bin", "python3"));
    pushUniqueCandidate(candidates, seen, posix.join(prefix, "bin", "python"));

    for (const minor of supportedMinors) {
      const version = `3.${minor}`;
      pushUniqueCandidate(
        candidates,
        seen,
        posix.join(prefix, "bin", `python${version}`),
      );
      pushUniqueCandidate(
        candidates,
        seen,
        posix.join(
          prefix,
          "opt",
          `python@${version}`,
          "bin",
          `python${version}`,
        ),
      );
      pushUniqueCandidate(
        candidates,
        seen,
        posix.join(prefix, "opt", `python@${version}`, "bin", "python3"),
      );
      pushUniqueCandidate(
        candidates,
        seen,
        posix.join(
          prefix,
          "opt",
          `python@${version}`,
          "libexec",
          "bin",
          "python3",
        ),
      );
      pushUniqueCandidate(
        candidates,
        seen,
        posix.join(
          prefix,
          "opt",
          `python@${version}`,
          "libexec",
          "bin",
          "python",
        ),
      );
    }
  }

  return candidates;
}

export function pythonCandidates(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    // Windows discovery is handled below through `where.exe` and known install
    // roots so persisted/probed launchers are absolute python.exe paths. Avoid
    // `py -3` and bare App Execution Aliases: both can surface visible launcher
    // UI even when the actual interpreter is healthy.
    return [];
  }
  return [
    { command: "python3", args: [] },
    { command: "python", args: [] },
    ...homebrewPythonCandidates(platform, env),
  ];
}

// Scan common Windows install locations for a python.exe that PATH may miss.
// Covers: per-user (winget default), system-wide (Python.org installer),
// C:\PythonXY (legacy), and Program Files (both 64/32-bit trees).
// Returns [{ major, minor, path }] sorted by version descending.
export function discoverWindowsPythonPaths(env = process.env) {
  const roots = new Set();
  const addRoot = (value) => {
    if (value && typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) roots.add(trimmed);
    }
  };

  if (env.LOCALAPPDATA) addRoot(join(env.LOCALAPPDATA, "Programs", "Python"));
  if (env.ProgramFiles) addRoot(env.ProgramFiles);
  if (env["ProgramFiles(x86)"]) addRoot(env["ProgramFiles(x86)"]);
  addRoot("C:\\");

  const pythonDirRe = /^Python(\d)(\d+)(?:-32)?$/i;
  const found = [];

  for (const root of roots) {
    let entries;
    try {
      if (!existsSync(root)) continue;
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const match = pythonDirRe.exec(entry);
      if (!match) continue;
      const major = Number.parseInt(match[1], 10);
      const minor = Number.parseInt(match[2], 10);
      const exe = join(root, entry, "python.exe");
      try {
        if (!existsSync(exe) || !statSync(exe).isFile()) continue;
      } catch {
        continue;
      }
      found.push({ major, minor, path: exe });
    }
  }

  found.sort((a, b) =>
    a.major !== b.major ? b.major - a.major : b.minor - a.minor,
  );
  return found;
}

export function discoverWindowsPythonPathCommands(spawnFn = spawnSync) {
  const found = [];
  const seen = new Set();
  for (const commandName of ["python", "python3"]) {
    let result;
    try {
      result = spawnFn("where.exe", [commandName], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
    } catch {
      continue;
    }
    if (result?.error || result?.status !== 0) continue;
    for (const line of readProcessText(result).split(/\r?\n/u)) {
      const exePath = line.trim();
      if (!/python(?:3)?\.exe$/iu.test(exePath)) continue;
      if (!win32.isAbsolute(exePath)) continue;
      if (exePath.replaceAll("\\", "/").toLowerCase().includes("/windowsapps/")) {
        continue;
      }
      const key = exePath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ command: exePath, args: [] });
    }
  }
  return found;
}

export function formatPythonLauncher(python) {
  return [python.command, ...python.args].join(" ");
}

export function ensurePip(python, spawnFn = spawnSync) {
  const pipCheck = runPythonModule(
    python,
    ["-m", "pip", "--version"],
    spawnFn,
  );
  if (pipCheck.status === 0) {
    return { ok: true, bootstrapped: false, errorText: "" };
  }

  const bootstrap = runPythonModule(
    python,
    ["-m", "ensurepip", "--upgrade"],
    spawnFn,
  );
  if (bootstrap.status !== 0) {
    return {
      ok: false,
      bootstrapped: false,
      errorText: [readProcessText(pipCheck), readProcessText(bootstrap)]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const recheck = runPythonModule(
    python,
    ["-m", "pip", "--version"],
    spawnFn,
  );
  return {
    ok: recheck.status === 0,
    bootstrapped: recheck.status === 0,
    errorText:
      recheck.status === 0
        ? ""
        : [readProcessText(pipCheck), readProcessText(bootstrap), readProcessText(recheck)]
            .filter(Boolean)
            .join("\n"),
  };
}

export function detectPython310(
  spawnFn = spawnSync,
  platform = process.platform,
  options = {},
) {
  const tryCandidate = (candidate) => {
    let result;
    try {
      result = spawnFn(candidate.command, [...candidate.args, "--version"], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
    } catch {
      return null;
    }

    if (result?.error || result?.status !== 0) {
      return null;
    }

    const versionText = readProcessText(result);
    const parsed = parsePythonVersion(versionText);
    if (
      parsed &&
      (parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 10))
    ) {
      const python = {
        ...candidate,
        version: parsed,
        versionText,
      };
      if (options.requirePip) {
        const pip = options.bootstrapPip
          ? ensurePip(python, spawnFn)
          : {
              ok:
                runPythonModule(
                  python,
                  ["-m", "pip", "--version"],
                  spawnFn,
                ).status === 0,
              bootstrapped: false,
            };
        if (!pip.ok) return null;
        return {
          ...python,
          pipBootstrapped: Boolean(pip.bootstrapped),
        };
      }
      return python;
    }
    return null;
  };

  const env = options.env ?? process.env;
  for (const candidate of pythonCandidates(platform, env)) {
    const hit = tryCandidate(candidate);
    if (hit) return hit;
  }

  // Windows fallback: PATH may miss python.exe installed by winget or the
  // Python.org installer. Scan common install roots and try absolute paths.
  if (platform === "win32") {
    for (const candidate of discoverWindowsPythonPathCommands(spawnFn)) {
      const hit = tryCandidate(candidate);
      if (hit) return { ...hit, absolutePath: true };
    }

    const discovered = discoverWindowsPythonPaths(env);
    for (const { major, minor, path: exePath } of discovered) {
      if (major < 3 || (major === 3 && minor < 10)) continue;
      const hit = tryCandidate({ command: exePath, args: [] });
      if (hit) return { ...hit, absolutePath: true };
    }
  }

  return null;
}

export function runPythonModule(
  python,
  moduleArgs,
  spawnFn = spawnSync,
  options = {},
) {
  return spawnFn(python.command, [...python.args, ...moduleArgs], {
    encoding: "utf8",
    shell: false,
    ...options,
    windowsHide: true,
  });
}

const GRAPHIFY_EXECUTABLE_RESOLVER = String.raw`
import os, site, sys, sysconfig
names = ("graphify.exe", "graphify") if os.name == "nt" else ("graphify",)
candidates = []
exe_dir = os.path.dirname(os.path.abspath(sys.executable))
try:
    user_scheme = sysconfig.get_preferred_scheme("user")
    user_scripts = sysconfig.get_path("scripts", scheme=user_scheme)
except (AttributeError, KeyError, TypeError, ValueError):
    user_scripts = None
dirs = [
    exe_dir,
    os.path.join(exe_dir, "Scripts"),
    sysconfig.get_path("scripts"),
    user_scripts,
]
user_base = site.USER_BASE
if user_base:
    dirs.extend([os.path.join(user_base, "Scripts"), os.path.join(user_base, "bin")])
for directory in dirs:
    if directory:
        candidates.extend(os.path.join(directory, name) for name in names)
for candidate in candidates:
    if candidate and os.path.isfile(candidate):
        print(os.path.abspath(candidate))
        break
`;

/** Resolve the console script installed for the already-selected interpreter. */
export function resolveGraphifyExecutable(
  python,
  spawnFn = spawnSync,
) {
  if (!python?.command || !Array.isArray(python.args)) return null;
  let result;
  try {
    result = spawnFn(
      python.command,
      [...python.args, "-c", GRAPHIFY_EXECUTABLE_RESOLVER],
      { encoding: "utf8", shell: false, windowsHide: true },
    );
  } catch {
    return null;
  }
  if (result?.error || result?.status !== 0) return null;
  const candidate = String(result.stdout ?? "").split(/\r?\n/u)[0]?.trim();
  if (!candidate) return null;
  const base = candidate.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return (
    (win32.isAbsolute(candidate) || posix.isAbsolute(candidate)) &&
    (base === "graphify" || base === "graphify.exe")
  ) ? candidate : null;
}

export function extractPipShowVersion(text) {
  const match = text.match(/Version:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

// networkx < 3.4 lacks louvain_communities(max_level=...) which graphify needs
const NETWORKX_MIN_MAJOR = 3;
const NETWORKX_MIN_MINOR = 4;

export function meetsMinimumVersion(versionString, minMajor, minMinor) {
  const match = versionString.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

export function checkNetworkx(python, spawnFn = spawnSync) {
  const result = runPythonModule(
    python,
    ["-m", "pip", "show", "networkx"],
    spawnFn,
  );
  if (result.status !== 0) {
    return { installed: false, version: null, meets: false };
  }
  const version = extractPipShowVersion(readProcessText(result));
  const meets = version
    ? meetsMinimumVersion(version, NETWORKX_MIN_MAJOR, NETWORKX_MIN_MINOR)
    : false;
  return { installed: true, version, meets };
}
