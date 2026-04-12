import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyGitInstallFailure,
  parseGitHubRepoUrl,
  shouldUseArchiveFallback,
} from "../../scripts/install-error-classifier.mjs";

describe("install error classifier", () => {
  test("classifies schannel/TLS clone failures", () => {
    const category = classifyGitInstallFailure(`
fatal: unable to access 'https://github.com/OthmanAdi/planning-with-files.git/':
schannel: failed to receive handshake, SSL/TLS connection failed
    `);
    assert.equal(category, "tls_transport");
    assert.equal(shouldUseArchiveFallback(category), true);
  });

  test("classifies missing repositories without archive fallback", () => {
    const category = classifyGitInstallFailure(`
fatal: repository 'https://github.com/example/missing-repo.git/' not found
    `);
    assert.equal(category, "repo_not_found");
    assert.equal(shouldUseArchiveFallback(category), false);
  });

  test("parses GitHub repo URLs from clone remotes", () => {
    assert.deepEqual(parseGitHubRepoUrl("https://github.com/owner/repo.git"), {
      owner: "owner",
      repo: "repo",
    });
    assert.deepEqual(parseGitHubRepoUrl("https://github.com/owner/repo"), {
      owner: "owner",
      repo: "repo",
    });
    assert.equal(parseGitHubRepoUrl("https://gitlab.com/owner/repo.git"), null);
  });
});
