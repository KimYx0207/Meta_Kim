import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../../canonical/runtime-assets/shared/hooks/spine-state-utils.mjs";

async function fixture(t, { platform = "win32", failures = 1, code = "EPERM", target = "file" } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "meta-kim-atomic-write-"));
  const path = join(root, "state.json");
  const previous = '{"revision":1}';
  if (target === "file") await fs.writeFile(path, previous);
  if (target === "directory") await fs.mkdir(path);
  const originalRename = fs.rename;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  let calls = 0;
  const error = Object.assign(new Error("controlled rename failure"), { code });
  fs.rename = async (from, to) => {
    calls += 1;
    assert.equal(to, path);
    if (target === "file") assert.equal(await fs.readFile(path, "utf8"), previous);
    assert.deepEqual(JSON.parse(await fs.readFile(from, "utf8")), { revision: 2 });
    if (calls <= failures) throw error;
    return originalRename(from, to);
  };
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
  syncBuiltinESMExports();
  t.after(async () => {
    fs.rename = originalRename;
    Object.defineProperty(process, "platform", originalPlatform);
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, path, previous, error, calls: () => calls };
}

for (const code of ["EPERM", "EBUSY"]) {
  test(`Windows ${code} replacement contention retains old bytes until atomic success`, async (t) => {
    const f = await fixture(t, { code, failures: 2 });
    await atomicWriteJson(f.path, { revision: 2 });
    assert.equal(f.calls(), 3);
    assert.deepEqual(JSON.parse(await fs.readFile(f.path, "utf8")), { revision: 2 });
    assert.deepEqual(await fs.readdir(f.root), ["state.json"]);
  });
}

test("persistent Windows denial is bounded, preserves old state and cleans only its temporary file", async (t) => {
  const f = await fixture(t, { failures: Infinity });
  await assert.rejects(atomicWriteJson(f.path, { revision: 2 }), (error) => error === f.error);
  assert.equal(f.calls(), 7);
  assert.equal(await fs.readFile(f.path, "utf8"), f.previous);
  assert.deepEqual(await fs.readdir(f.root), ["state.json"]);
});

for (const options of [
  { platform: "linux" }, { code: "EIO" }, { target: "missing" }, { target: "directory" },
]) {
  test(`unproven replacement contention fails immediately: ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(atomicWriteJson(f.path, { revision: 2 }), (error) => error === f.error);
    assert.equal(f.calls(), 1);
    assert.deepEqual(await fs.readdir(f.root), options.target === "missing" ? [] : ["state.json"]);
  });
}
