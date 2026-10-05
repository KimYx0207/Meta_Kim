import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildNativeCliAuthStatusArgs,
  buildNativeCliEnvironment,
  parseNativeCliAuthStatus,
} from "../../scripts/native-cli-auth.mjs";

// Exact non-private fields observed in the user's Claude Code 2.1.236 receipt.
// It did not return subscriptionType; authentication is not a billing claim.
const CLAUDE_OAUTH_STATUS = {
  loggedIn: true,
  authMethod: "oauth_token",
  apiProvider: "firstParty",
};

function commandResult(stdout, overrides = {}) {
  return {
    status: 0,
    stdout,
    stderr: "",
    error: null,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    ...overrides,
  };
}

function claudeResult(overrides = {}) {
  return commandResult(JSON.stringify({ ...CLAUDE_OAUTH_STATUS, ...overrides }));
}

function rejectsWithCode(run, code) {
  assert.throws(run, (error) => {
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private-fixture|sk-fixture|secret-value|untrusted\.invalid/u);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
}

test("builds a closed existing-login environment while preserving official home pointers", () => {
  const source = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/current-user",
    USERPROFILE: "C:\\Users\\current-user",
    CODEX_HOME: "/home/current-user/.codex",
    CLAUDE_CONFIG_DIR: "/home/current-user/.claude",
    HOMEbrew_TOKEN: "secret-value",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    HTTP_PROXY: "http://proxy.example.invalid:8080",
    HTTPS_PROXY: "http://proxy.example.invalid:8080",
    NO_PROXY: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: "/etc/certs/organization.pem",
    SSL_CERT_FILE: "/etc/certs/ca-bundle.crt",
    SSL_CERT_DIR: "/etc/certs",
    REQUESTS_CA_BUNDLE: "/etc/certs/python.pem",
    CURL_CA_BUNDLE: "/etc/certs/curl.pem",
  };
  const before = structuredClone(source);
  for (const runtime of ["claude_code", "codex"]) {
    const env = buildNativeCliEnvironment(runtime, source);
    const { HOMEbrew_TOKEN: omitted, ...expected } = source;
    assert.equal(omitted, "secret-value");
    assert.deepEqual(env, { ...expected, NO_COLOR: "1" });
    assert.equal(Object.isFrozen(env), true);
    assert.notEqual(env, source);
  }
  assert.deepEqual(source, before);
});

test("drops provider, API, token, alternative-model and executable-injection variables in any case", () => {
  const blockedKeys = [
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_API_KEY",
    "CODEX_API_BASE_URL", "CODEX_MODEL", "CODEX_AUTH_JSON", "CODEX_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "CLAUDE_CODE_SETTINGS_PATH", "CLAUDE_CODE_ACCOUNT_UUID",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
    "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_API_KEY", "CLOUD_ML_REGION", "AZURE_OPENAI_API_KEY", "MINIMAX_API_KEY",
    "GEMINI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "UNRELATED_SECRET", "FUTURE_PROVIDER_CREDENTIAL",
    "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "BASH_ENV", "ENV", "PYTHONPATH", "NPM_CONFIG_USERCONFIG", "XDG_CONFIG_HOME", "META_KIM_PROVIDER",
  ];
  const mixedCase = (key) => [...key].map((part, index) => index % 2 ? part.toLowerCase() : part).join("");
  const source = { PATH: "/bin", HOME: "/home/current-user" };
  for (const key of blockedKeys) {
    source[key] = "secret-value";
    source[key.toLowerCase()] = "secret-value";
    source[mixedCase(key)] = "secret-value";
  }
  for (const runtime of ["codex", "claude_code"]) {
    const env = buildNativeCliEnvironment(runtime, source);
    assert.deepEqual(env, { PATH: "/bin", HOME: "/home/current-user", NO_COLOR: "1" });
    assert.doesNotMatch(JSON.stringify(env), /secret-value/u);
  }
});

test("normalizes allowed case variants and collapses identical values", () => {
  assert.deepEqual(buildNativeCliEnvironment("codex", {
    Path: "C:\\Windows;C:\\Program Files\\nodejs",
    PATH: "C:\\Windows;C:\\Program Files\\nodejs",
    SystemRoot: "C:\\Windows",
    userprofile: "C:\\Users\\Current User",
    codex_home: "C:\\Users\\Current User\\.codex",
    claude_config_dir: "\\\\server\\profiles\\current-user\\.claude",
    https_proxy: "http://proxy.example.invalid:8080",
  }), {
    PATH: "C:\\Windows;C:\\Program Files\\nodejs",
    SYSTEMROOT: "C:\\Windows",
    USERPROFILE: "C:\\Users\\Current User",
    CODEX_HOME: "C:\\Users\\Current User\\.codex",
    CLAUDE_CONFIG_DIR: "\\\\server\\profiles\\current-user\\.claude",
    HTTPS_PROXY: "http://proxy.example.invalid:8080",
    NO_COLOR: "1",
  });
});

test("rejects conflicting case variants instead of selecting an ambiguous environment", () => {
  for (const key of ["PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "SSL_CERT_FILE"]) {
    rejectsWithCode(() => buildNativeCliEnvironment("claude_code", {
      [key]: "/trusted-current-value",
      [key.toLowerCase()]: "/secret-value",
    }), "NATIVE_CLI_AUTH_ENV_INVALID");
  }
});

test("rejects relative, empty, invalid or ambiguous official auth directory pointers", () => {
  for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    for (const value of ["", "relative", "~/.codex", "C:relative", "\\relative", " /secret-value", "/secret-value ", "/secret-value\n", "/secret-value\0", 1, null]) {
      rejectsWithCode(() => buildNativeCliEnvironment("codex", { [key]: value }), "NATIVE_CLI_AUTH_ENV_INVALID");
    }
  }
  rejectsWithCode(() => buildNativeCliEnvironment("claude_code", { NODE_EXTRA_CA_CERTS: "relative.pem" }), "NATIVE_CLI_AUTH_ENV_INVALID");
});

test("rejects invalid allowlisted values but ignores absent and non-allowlisted values", () => {
  assert.deepEqual(buildNativeCliEnvironment("codex", { PATH: undefined, NO_PROXY: "", SECRET: null }), {
    NO_PROXY: "",
    NO_COLOR: "1",
  });
  for (const value of [null, 123, "secret-value\0", "secret-value\r", "secret-value\n", "a".repeat(32_769)]) {
    rejectsWithCode(() => buildNativeCliEnvironment("codex", { PATH: value }), "NATIVE_CLI_AUTH_ENV_INVALID");
  }
  for (const value of [null, [], "secret-value"]) {
    rejectsWithCode(() => buildNativeCliEnvironment("codex", value), "NATIVE_CLI_AUTH_ENV_INVALID");
  }
});

test("constructs only the official status-only commands", () => {
  assert.deepEqual(buildNativeCliAuthStatusArgs("codex"), ["login", "status"]);
  assert.deepEqual(buildNativeCliAuthStatusArgs("claude_code"), ["auth", "status", "--json"]);
  const prefix = ["C:\\Program Files\\claude\\cli.js"];
  assert.deepEqual(buildNativeCliAuthStatusArgs("claude_code", prefix), [...prefix, "auth", "status", "--json"]);
  assert.deepEqual(prefix, ["C:\\Program Files\\claude\\cli.js"]);
  assert.deepEqual(buildNativeCliAuthStatusArgs("codex", ["/opt/codex/cli.mjs"]), ["/opt/codex/cli.mjs", "login", "status"]);
});

test("rejects auth-changing flags, profiles, relative shims and command injections in argv prefix", () => {
  for (const prefix of [
    null, "--api-key", ["--config"], ["login"], ["relative/cli.js"], ["/opt/cli.exe"],
    ["/opt/cli.js", "--profile=api"], ["/opt/cli.js\0"], ["/opt/cli.js\n"], [123],
  ]) {
    rejectsWithCode(() => buildNativeCliAuthStatusArgs("codex", prefix), "NATIVE_CLI_AUTH_ARGS_INVALID");
  }
});

test("accepts the exact Codex ChatGPT login status on either official output channel", () => {
  const expected = { kind: "official_existing_login", runtime: "codex", provider: "chatgpt" };
  for (const result of [
    commandResult("Logged in using ChatGPT\n"),
    commandResult("", { stderr: "Logged in using ChatGPT\r\n" }),
  ]) {
    const observed = parseNativeCliAuthStatus("codex", result);
    assert.deepEqual(observed, expected);
    assert.equal(Object.isFrozen(observed), true);
  }
});

test("Codex rejects API auth, substring matching, case variants and ambiguous output", () => {
  for (const text of [
    "", "Logged in using an API key - sk-fixture", "Not logged in",
    "logged in using ChatGPT", "Logged in using Chatgpt", "Logged in using ChatGPT (API)",
    "Logged in using ChatGPT\nLogged in using an API key - sk-fixture",
    "Warning: secret-value\nLogged in using ChatGPT", "\u001b[32mLogged in using ChatGPT\u001b[0m",
  ]) {
    rejectsWithCode(() => parseNativeCliAuthStatus("codex", commandResult(text)), "NATIVE_CLI_AUTH_NOT_OFFICIAL");
  }
  for (const stderr of ["secret-value", "Logged in using ChatGPT", "Logged in using an API key - sk-fixture"]) {
    rejectsWithCode(() => parseNativeCliAuthStatus("codex", commandResult("Logged in using ChatGPT", { stderr })), "NATIVE_CLI_AUTH_NOT_OFFICIAL");
  }
});

test("accepts exact Claude 2.1.236 first-party OAuth fixture without requiring subscription data", () => {
  const observed = parseNativeCliAuthStatus("claude_code", claudeResult());
  assert.deepEqual(observed, { kind: "official_existing_login", runtime: "claude_code", provider: "firstParty" });
  assert.equal(Object.isFrozen(observed), true);
  assert.doesNotMatch(JSON.stringify(observed), /private-fixture|@|orgId|orgName|email|subscription|oauth_token/u);
  for (const subscriptionType of [null, "pro", "max", "team", "enterprise", "unknown"]) {
    assert.deepEqual(parseNativeCliAuthStatus("claude_code", claudeResult({
      subscriptionType,
      email: "private-fixture@example.invalid",
      orgId: "private-fixture-org-id",
      orgName: "private-fixture-organization",
    })), observed);
  }
});

test("Claude rejects API-key, logged-out, alternative-provider and unknown OAuth modes", () => {
  for (const overrides of [
    { loggedIn: false }, { authMethod: "api_key" }, { authMethod: "apiKey" }, { authMethod: "oauthToken" },
    { authMethod: "oauth_token ", email: "private-fixture@example.invalid" },
    { apiProvider: "bedrock" }, { apiProvider: "vertex" }, { apiProvider: "firstparty" },
    { apiProvider: "https://untrusted.invalid" }, { authMethod: "unknown" },
  ]) {
    rejectsWithCode(() => parseNativeCliAuthStatus("claude_code", claudeResult(overrides)), "NATIVE_CLI_AUTH_NOT_OFFICIAL");
  }
});

test("Claude rejects missing required fields, case variants, unexpected keys and invalid field types", () => {
  for (const key of ["loggedIn", "authMethod", "apiProvider"]) {
    const missing = { ...CLAUDE_OAUTH_STATUS };
    delete missing[key];
    rejectsWithCode(() => parseNativeCliAuthStatus("claude_code", commandResult(JSON.stringify(missing))), "NATIVE_CLI_AUTH_STATUS_INVALID");
    for (const value of [null, [], {}, 1]) {
      rejectsWithCode(() => parseNativeCliAuthStatus("claude_code", claudeResult({ [key]: value })), "NATIVE_CLI_AUTH_STATUS_INVALID");
    }
    rejectsWithCode(() => parseNativeCliAuthStatus("claude_code", claudeResult({ [key.toUpperCase()]: CLAUDE_OAUTH_STATUS[key] })), "NATIVE_CLI_AUTH_STATUS_INVALID");
  }
  for (const overrides of [
    { provider: "firstParty" }, { apiKeySource: "environment" }, { accessToken: "secret-value" },
    { apiKey: "sk-fixture" }, { loggedIn: "true" }, { email: { token: "secret-value" } },
    { orgId: 123 }, { orgName: ["private-fixture"] }, { subscriptionType: false }, { subscriptionType: {} },
  ]) {
    rejectsWithCode(() => parseNativeCliAuthStatus("claude_code", claudeResult(overrides)), "NATIVE_CLI_AUTH_STATUS_INVALID");
  }
});

test("Claude allows optional plain identity values but retains none", () => {
  const result = claudeResult({ email: null, orgId: null, orgName: null, accountId: "private-fixture-account" });
  assert.deepEqual(parseNativeCliAuthStatus("claude_code", result), {
    kind: "official_existing_login", runtime: "claude_code", provider: "firstParty",
  });
});

test("Claude rejects duplicate JSON keys including escaped-key aliases", () => {
  const fixture = JSON.stringify({ ...CLAUDE_OAUTH_STATUS, email: "private-fixture@example.invalid" });
  for (const prefix of ['"loggedIn":false,', '"loggedIn":true,', '"logged\\u0049n":true,', '"authMethod":"api_key",', '"email":"private-fixture-duplicate",']) {
    rejectsWithCode(() => parseNativeCliAuthStatus("claude_code", commandResult(`{${prefix}${fixture.slice(1)}`)), "NATIVE_CLI_AUTH_STATUS_INVALID");
  }
});

test("quoted JSON-like text in identity strings does not count as duplicate fields", () => {
  const result = claudeResult({ orgName: 'private-fixture: "loggedIn":false, \\ backslash }' });
  assert.equal(parseNativeCliAuthStatus("claude_code", result).kind, "official_existing_login");
});

test("Claude rejects malformed, multi-document, nested and diagnostic output", () => {
  for (const text of ["", "null", "[]", "true", "42", '"secret-value"', "{", "{}", '{}\n{}', JSON.stringify([CLAUDE_OAUTH_STATUS]), `${JSON.stringify(CLAUDE_OAUTH_STATUS)}\nsecret-value`]) {
    rejectsWithCode(() => parseNativeCliAuthStatus("claude_code", commandResult(text)), "NATIVE_CLI_AUTH_STATUS_INVALID");
  }
  rejectsWithCode(() => parseNativeCliAuthStatus("claude_code", { ...claudeResult(), stderr: "secret-value warning" }), "NATIVE_CLI_AUTH_STATUS_INVALID");
  rejectsWithCode(() => parseNativeCliAuthStatus("claude_code", commandResult("", { stderr: JSON.stringify(CLAUDE_OAUTH_STATUS) })), "NATIVE_CLI_AUTH_STATUS_INVALID");
});

test("both runtimes fail closed when the status process did not complete successfully", () => {
  for (const runtime of ["codex", "claude_code"]) {
    const base = runtime === "codex" ? commandResult("Logged in using ChatGPT") : claudeResult();
    for (const overrides of [
      { status: 1 }, { status: null }, { status: undefined }, { status: "0" },
      { timedOut: true }, { timedOut: "false" }, { outputLimitExceeded: true },
      { error: new Error("secret-value") }, { signal: "SIGTERM" },
    ]) {
      rejectsWithCode(() => parseNativeCliAuthStatus(runtime, { ...base, ...overrides }), "NATIVE_CLI_AUTH_COMMAND_FAILED");
    }
  }
});

test("rejects invalid result containers, non-text and oversized output without echoing it", () => {
  for (const runtime of ["codex", "claude_code"]) {
    for (const result of [null, [], "secret-value", Object.create({ status: 0 })]) {
      rejectsWithCode(() => parseNativeCliAuthStatus(runtime, result), "NATIVE_CLI_AUTH_STATUS_INVALID");
    }
    for (const stdout of [42, {}, Buffer.from("secret-value"), "secret-value\0", "a".repeat(16 * 1024 + 1), "金".repeat(6 * 1024)]) {
      rejectsWithCode(() => parseNativeCliAuthStatus(runtime, commandResult(stdout)), "NATIVE_CLI_AUTH_STATUS_INVALID");
    }
  }
});

test("all helpers reject unknown or case-varied runtimes", () => {
  for (const runtime of [undefined, null, "Codex", "CLAUDE", "claude", "cursor", "untrusted.invalid", {}]) {
    rejectsWithCode(() => buildNativeCliEnvironment(runtime, {}), "NATIVE_CLI_AUTH_RUNTIME_INVALID");
    rejectsWithCode(() => buildNativeCliAuthStatusArgs(runtime), "NATIVE_CLI_AUTH_RUNTIME_INVALID");
    rejectsWithCode(() => parseNativeCliAuthStatus(runtime, commandResult("")), "NATIVE_CLI_AUTH_RUNTIME_INVALID");
  }
});

test("auth boundary is pure and cannot inspect credentials or execute any CLI", async () => {
  const source = await readFile(new URL("../../scripts/native-cli-auth.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:path", "node:process"]);
  assert.doesNotMatch(source, /\b(?:readFile|readFileSync|readdir|openSync|spawn|spawnSync|execFile|execSync|fetch)\s*\(/u);
});
