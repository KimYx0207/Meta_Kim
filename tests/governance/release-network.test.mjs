import assert from "node:assert/strict";
import test from "node:test";
import {
  createReleaseNetworkClient,
  parseWindowsSystemProxyOutput,
  readWindowsSystemProxy,
} from "../../scripts/release-network.mjs";

test("Windows WinHTTP proxy parsing selects a credential-free endpoint", () => {
  assert.deepEqual(
    parseWindowsSystemProxyOutput([
      "Current WinHTTP proxy settings:",
      "    Proxy Server(s) : http=proxy.example:8080;https=secure-proxy.example:8443",
    ].join("\n")),
    { protocol: "http:", hostname: "secure-proxy.example", port: 8443 },
  );
  assert.equal(
    parseWindowsSystemProxyOutput("    Direct access (no proxy server)."),
    null,
  );
});

test("Windows proxy credentials are rejected without echoing sensitive source text", () => {
  const secret = "proxy-password-should-not-appear";
  assert.throws(
    () => parseWindowsSystemProxyOutput(`Proxy Server(s) : http://user:${secret}@proxy.example:8080`),
    (error) => error.code === "release_proxy_invalid" && !error.message.includes(secret),
  );
});

test("Windows proxy discovery uses a credential-free command environment", () => {
  let commandCall;
  const proxy = readWindowsSystemProxy({
    platform: "win32",
    environment: {
      SystemRoot: "C:\\Windows",
      Path: "C:\\Windows\\System32",
      HTTP_PROXY: "http://user:secret@example.invalid:8080",
      GH_TOKEN: "secret-token",
    },
    runCommand: (command, args, options) => {
      commandCall = { command, args, options };
      return { status: 0, stdout: "Direct access (no proxy server)." };
    },
  });
  assert.equal(proxy, null);
  assert.equal(commandCall.args.join(" "), "winhttp show proxy");
  assert.equal(commandCall.options.env.HTTP_PROXY, undefined);
  assert.equal(commandCall.options.env.GH_TOKEN, undefined);
});

test("custom release fetch receives a bounded request signal without inheriting proxy env", async () => {
  let observed;
  const client = createReleaseNetworkClient({
    fetchImpl: async (_url, options) => {
      observed = options;
      return new Response("ok", { status: 200 });
    },
    platform: "win32",
    environment: {
      HTTPS_PROXY: "http://user:secret@example.invalid:8080",
    },
    systemProxyReader: () => {
      throw new Error("custom fetch must not consult ambient proxy state");
    },
  });
  const response = await client.request("https://example.invalid", { timeoutMs: 25 });
  assert.equal(response.status, 200);
  assert.equal(observed.signal instanceof AbortSignal, true);
  assert.equal(client.proxyMode, "direct");
});

test("release network timeout aborts an uncooperative fetch implementation", async () => {
  const client = createReleaseNetworkClient({
    fetchImpl: async () => new Promise(() => {}),
  });
  await assert.rejects(
    () => client.request("https://example.invalid", { timeoutMs: 10 }),
    (error) => error.code === "release_network_timeout",
  );
});
