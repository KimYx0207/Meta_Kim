import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createReleaseNetworkClient,
  parseWindowsInternetSettingsOutput,
  parseWindowsSystemProxyOutput,
  readWindowsSystemProxy,
} from "../../scripts/release-network.mjs";

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.ended = false;
  }

  end() {
    this.ended = true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }

  unshift() {}

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

class FakeResponse extends EventEmitter {
  constructor(statusCode = 200, headers = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
    this.resumed = false;
    this.destroyed = false;
  }

  resume() {
    this.resumed = true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

function winInetOutput(valueName, value) {
  return [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    `    ${valueName}    REG_${valueName === "ProxyEnable" ? "DWORD" : "SZ"}    ${value}`,
  ].join("\n");
}

test("WinINET reads the trusted System32 reg.exe first and preserves bypass rules", () => {
  const calls = [];
  const resolverCalls = [];
  const output = new Map([
    ["ProxyEnable", winInetOutput("ProxyEnable", "0x1")],
    ["ProxyServer", winInetOutput("ProxyServer", "http=proxy.example:8080;https=secure-proxy.example:8443")],
    ["ProxyOverride", winInetOutput("ProxyOverride", "<local>;*.bypass.example")],
  ]);
  const proxy = readWindowsSystemProxy({
    platform: "win32",
    environment: {
      SystemRoot: "C:\\Attacker",
      WINDIR: "D:\\Attacker",
      Path: "C:\\Attacker\\System32",
      HTTP_PROXY: "http://user:secret@example.invalid:8080",
      GH_TOKEN: "secret-token",
    },
    resolveSystemTool: (segments) => {
      resolverCalls.push(segments);
      return `C:\\TrustedSystem32\\${segments.at(-1)}`;
    },
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: output.get(args.at(-1)) ?? "" };
    },
  });
  assert.deepEqual({ ...proxy }, { protocol: "http:", hostname: "secure-proxy.example", port: 8443 });
  assert.equal(proxy.source, "windows_wininet");
  assert.deepEqual(proxy.bypass, ["<local>", "*.bypass.example"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, "C:\\TrustedSystem32\\reg.exe");
  assert.deepEqual(resolverCalls, [["reg.exe"]]);
  assert.equal(calls.every((call) => call.options.shell === false), true);
  assert.equal(calls.every((call) => call.options.windowsHide === true), true);
  assert.equal(calls.every((call) => call.options.timeout === 5000), true);
  assert.equal(calls.every((call) => call.options.env.HTTP_PROXY === undefined), true);
  assert.equal(calls.every((call) => call.options.env.GH_TOKEN === undefined), true);
  assert.equal(calls.some((call) => call.command.endsWith("netsh.exe")), false);
});

test("WinINET disabled is direct and does not fall through to WinHTTP", () => {
  const calls = [];
  const proxy = readWindowsSystemProxy({
    platform: "win32",
    environment: { SystemRoot: "C:\\Attacker", WINDIR: "D:\\Attacker" },
    resolveSystemTool: (segments) => `C:\\TrustedSystem32\\${segments.at(-1)}`,
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: winInetOutput("ProxyEnable", "0x0") };
    },
  });
  assert.equal(proxy, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command.endsWith("reg.exe"), true);
});

test("malformed or credential-bearing WinINET proxies are rejected and safely fall back", () => {
  const calls = [];
  const proxy = readWindowsSystemProxy({
    platform: "win32",
    environment: { SystemRoot: "C:\\Attacker", WINDIR: "D:\\Attacker" },
    resolveSystemTool: (segments) => `C:\\TrustedSystem32\\${segments.at(-1)}`,
    runCommand: (command, args) => {
      calls.push({ command, args });
      if (command.endsWith("reg.exe") && args.at(-1) === "ProxyEnable") {
        return { status: 0, stdout: winInetOutput("ProxyEnable", "0x1") };
      }
      if (command.endsWith("reg.exe") && args.at(-1) === "ProxyServer") {
        return { status: 0, stdout: winInetOutput("ProxyServer", "http://user:secret@example.invalid:8080") };
      }
      if (command.endsWith("netsh.exe")) {
        return {
          status: 0,
          stdout: [
            "Current WinHTTP proxy settings:",
            "    Proxy Server(s) : fallback.example:8080",
            "    Bypass List     : <local>",
          ].join("\n"),
        };
      }
      return { status: 1, stdout: "" };
    },
  });
  assert.deepEqual({ ...proxy }, { protocol: "http:", hostname: "fallback.example", port: 8080 });
  assert.equal(proxy.source, "windows_winhttp");
  assert.deepEqual(proxy.bypass, ["<local>"]);
  assert.equal(calls[0].command.endsWith("reg.exe"), true);
  assert.equal(calls.at(-1).command.endsWith("netsh.exe"), true);
  assert.throws(
    () => parseWindowsSystemProxyOutput("Proxy Server(s) : https://user:secret@example.invalid:8443"),
    (error) => error.code === "release_proxy_invalid" && !error.message.includes("secret"),
  );
  assert.throws(
    () => parseWindowsSystemProxyOutput("Proxy Server(s) : file:///C:/malicious"),
    (error) => error.code === "release_proxy_invalid",
  );
});

test("unavailable trusted System32 resolver fails closed without consulting spoofed roots", () => {
  let commandCalls = 0;
  let resolverCalls = 0;
  const proxy = readWindowsSystemProxy({
    platform: "win32",
    environment: { SystemRoot: "C:\\Attacker", WINDIR: "D:\\Attacker" },
    resolveSystemTool: () => {
      resolverCalls += 1;
      return null;
    },
    runCommand: () => {
      commandCalls += 1;
      return { status: 0, stdout: "unexpected" };
    },
  });
  assert.equal(proxy, null);
  assert.equal(resolverCalls, 2);
  assert.equal(commandCalls, 0);
});

test("client uses direct fetch when the trusted System32 resolver is unavailable", async () => {
  const previousFetch = globalThis.fetch;
  let observedUrl;
  globalThis.fetch = async (url) => {
    observedUrl = url;
    return new Response("direct", { status: 200 });
  };
  try {
    const client = createReleaseNetworkClient({
      platform: "win32",
      environment: { SystemRoot: "C:\\Attacker", WINDIR: "D:\\Attacker" },
      systemProxyReader: readWindowsSystemProxy,
      resolveSystemTool: () => null,
    });
    const response = await client.request("https://target.example/direct", { timeoutMs: 50 });
    assert.equal(response.status, 200);
    assert.equal(observedUrl, "https://target.example/direct");
    assert.equal(client.proxyMode, "direct");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("combined WinINET output only accepts enabled, credential-free http(s) proxy values", () => {
  assert.deepEqual(
    parseWindowsInternetSettingsOutput([
      winInetOutput("ProxyEnable", "0x1"),
      winInetOutput("ProxyServer", "proxy.example:8080"),
      winInetOutput("ProxyOverride", "<local>;*.example.test"),
    ].join("\n")),
    {
      proxy: { protocol: "http:", hostname: "proxy.example", port: 8080 },
      bypass: ["<local>", "*.example.test"],
    },
  );
  assert.equal(parseWindowsInternetSettingsOutput(winInetOutput("ProxyEnable", "0x0")), null);
});

test("HTTPS CONNECT performs explicit TLS with the target hostname and cleans every resource on response timeout", async () => {
  const connectRequests = [];
  const targetRequests = [];
  const tlsCalls = [];
  const rawSockets = [];
  const tlsSockets = [];
  const client = createReleaseNetworkClient({
    platform: "win32",
    systemProxyReader: () => ({ protocol: "http:", hostname: "proxy.example", port: 3128 }),
    httpRequestImpl: () => {
      const request = new FakeRequest();
      connectRequests.push(request);
      return request;
    },
    httpsRequestImpl: (options, onResponse) => {
      const request = new FakeRequest();
      targetRequests.push({ request, options, onResponse });
      return request;
    },
    tlsConnectImpl: (options) => {
      tlsCalls.push(options);
      const socket = new FakeSocket();
      tlsSockets.push(socket);
      return socket;
    },
  });
  const pending = client.request("https://target.example/download.tgz", { timeoutMs: 30 });
  await new Promise((resolve) => setImmediate(resolve));
  const connectResponse = new FakeResponse(200);
  const rawSocket = new FakeSocket();
  rawSockets.push(rawSocket);
  connectRequests[0].emit("connect", connectResponse, rawSocket, Buffer.alloc(0));
  await new Promise((resolve) => setImmediate(resolve));
  tlsSockets[0].emit("secureConnect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tlsCalls[0].servername, "target.example");
  assert.equal(targetRequests[0].options.servername, "target.example");
  assert.equal(targetRequests[0].options.createConnection(), tlsSockets[0]);
  await assert.rejects(pending, (error) => error.code === "release_network_timeout");
  assert.equal(connectRequests[0].destroyed, true);
  assert.equal(targetRequests[0].request.destroyed, true);
  assert.equal(rawSockets[0].destroyed, true);
  assert.equal(tlsSockets[0].destroyed, true);
});

test("TLS timeout destroys the CONNECT request, raw tunnel, and TLS socket", async () => {
  let connectRequest;
  let rawSocket;
  let tlsSocket;
  const client = createReleaseNetworkClient({
    platform: "win32",
    systemProxyReader: () => ({ protocol: "http:", hostname: "proxy.example", port: 3128 }),
    httpRequestImpl: () => {
      connectRequest = new FakeRequest();
      return connectRequest;
    },
    httpsRequestImpl: () => new FakeRequest(),
    tlsConnectImpl: () => {
      tlsSocket = new FakeSocket();
      return tlsSocket;
    },
  });
  const pending = client.request("https://target.example/tls.bin", { timeoutMs: 25 });
  await new Promise((resolve) => setImmediate(resolve));
  rawSocket = new FakeSocket();
  connectRequest.emit("connect", new FakeResponse(200), rawSocket, Buffer.alloc(0));
  await assert.rejects(pending, (error) => error.code === "release_network_timeout");
  assert.equal(connectRequest.destroyed, true);
  assert.equal(rawSocket.destroyed, true);
  assert.equal(tlsSocket.destroyed, true);
});

test("CONNECT timeout destroys the pending proxy request", async () => {
  let connectRequest;
  const client = createReleaseNetworkClient({
    platform: "win32",
    systemProxyReader: () => ({ protocol: "http:", hostname: "proxy.example", port: 3128 }),
    httpRequestImpl: () => {
      connectRequest = new FakeRequest();
      return connectRequest;
    },
    httpsRequestImpl: () => new FakeRequest(),
    tlsConnectImpl: () => new FakeSocket(),
  });
  await assert.rejects(
    () => client.request("https://target.example/metadata.json", { timeoutMs: 20 }),
    (error) => error.code === "release_network_timeout",
  );
  assert.equal(connectRequest.destroyed, true);
});

test("synchronous CONNECT end failure cleans up before transport is returned", async () => {
  let connectRequest;
  const client = createReleaseNetworkClient({
    platform: "win32",
    systemProxyReader: () => ({ protocol: "http:", hostname: "proxy.example", port: 3128 }),
    httpRequestImpl: () => {
      connectRequest = new FakeRequest();
      connectRequest.end = () => {
        throw new Error("synchronous connect end failure");
      };
      return connectRequest;
    },
    httpsRequestImpl: () => new FakeRequest(),
    tlsConnectImpl: () => new FakeSocket(),
  });
  await assert.rejects(
    () => client.request("https://target.example/sync-failure", { timeoutMs: 100 }),
    /synchronous connect end failure/u,
  );
  assert.equal(connectRequest.destroyed, true);
});

test("ProxyOverride keeps local and matching hosts on direct HTTPS", async () => {
  const directRequests = [];
  const proxyRequests = [];
  const client = createReleaseNetworkClient({
    platform: "win32",
    systemProxyReader: () => ({
      protocol: "http:",
      hostname: "proxy.example",
      port: 3128,
      source: "windows_wininet",
      bypass: ["<local>", "*.bypass.example"],
    }),
    httpRequestImpl: () => {
      const request = new FakeRequest();
      proxyRequests.push(request);
      return request;
    },
    httpsRequestImpl: (options, onResponse) => {
      const request = new FakeRequest();
      directRequests.push({ request, options });
      setImmediate(() => {
        const response = new FakeResponse(200, {});
        onResponse(response);
        response.emit("end");
      });
      return request;
    },
  });
  const localResponse = await client.request("https://localhost/status", { timeoutMs: 50 });
  const intranetResponse = await client.request("https://api.bypass.example/status", { timeoutMs: 50 });
  assert.equal(localResponse.status, 200);
  assert.equal(intranetResponse.status, 200);
  assert.equal(proxyRequests.length, 0);
  assert.equal(directRequests.length, 2);
});

test("direct fallback does not invoke an invalid proxy and remains bounded by AbortSignal", async () => {
  const previousFetch = globalThis.fetch;
  let observed;
  globalThis.fetch = async (_url, options) => {
    observed = options;
    return new Response("direct", { status: 200 });
  };
  try {
    const client = createReleaseNetworkClient({
      platform: "win32",
      systemProxyReader: () => ({ protocol: "ftp:", hostname: "malicious.example", port: 21 }),
      httpRequestImpl: () => {
        throw new Error("invalid proxy must not be used");
      },
    });
    const response = await client.request("https://target.example/metadata.json", { timeoutMs: 25 });
    assert.equal(response.status, 200);
    assert.equal(client.proxyMode, "direct");
    assert.equal(observed.signal instanceof AbortSignal, true);
    assert.equal(observed.redirect, "manual");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("direct fetch follows redirects only up to the bounded limit", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: `${url}/next` },
    });
  };
  try {
    const client = createReleaseNetworkClient({ platform: "linux" });
    await assert.rejects(
      () => client.request("https://target.example/start", { timeoutMs: 100 }),
      (error) => error.code === "release_redirects_exceeded",
    );
    assert.equal(calls, 6);
  } finally {
    globalThis.fetch = previousFetch;
  }
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
  assert.equal(observed.redirect, "manual");
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
