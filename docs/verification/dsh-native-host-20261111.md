# DSH native loading verification

Client date: 2026-11-11, Asia/Shanghai. The exact observation timestamp, executable package hash and implementation hashes are in [the machine-readable record](dsh-native-host-20261111.json). This is native configuration, loading and local MCP evidence; it does not certify a complete model-driven product delivery or a published release.

## What was observed

The installed official `@deepseek-ai/dsh` version was `0.2.2-rc.1`, running with Node `v24.22.1`. The probe used a separate process, an isolated HOME, an allowlisted environment, a real packed Meta_Kim CLI and the official DSH modules. No LLM provider was mounted and no model calls were made.

| Check | Observed result |
| --- | --- |
| Global profile and project patch parsing | Both accepted by the official CLI |
| Global native Skill catalogue | 62 Skills discovered and loaded |
| Project native Skill catalogue | 62 Skills discovered and loaded; project versions selected over global versions |
| Complete primary methods | 144 parts read per scope and reconstructed byte for byte |
| Complete text and code resources | 1,636 resources, 3,432 parts, including 524 JSON resources and 234 executable-source resources |
| Native read and result-pruner checks | Largest rendered result 6,726 characters; zero bounded results pruned; unbounded JSON/code controls demonstrated pruning |
| Local native MCP integration | 11 tools and 5 resources discovered; role listing and canonical Skill resource read succeeded |
| Packed lifecycle | Install, unchanged update, integrity check, uninstall and reinstall passed |
| Independent scope ownership | Project removal preserved the full global installation |
| Nested Git-root handling | Installer refused a child directory before writing; official provider selected the Git root when queried from that child |

The 62 Skills consist of Meta_Kim's dispatcher and nine governance roles, plus 51 Kim_Service professional methods and their catalogue. These are native Skills, not custom native Agent presets.

## Defect and correction

The recovered iteration additionally completed the public source configuration closure: runtime/OS matrices, capability registries and the DSH host contract are available in Skill-only installations as well. Twelve referenced public files are selected explicitly, with original bytes and lossless bounded views. Machine-local configuration stays excluded. Kim Service also preserves the canonical public images referenced by its component documents.


Before the correction, installing into a child of a Git repository reported 10 installed Meta_Kim Skills, while the official filesystem provider returned a complete catalogue containing none of those project Skills. DSH's provider scans the nearest ancestor containing `.git`, including linked-worktree marker files. The installer now reports that root and rejects a mismatched install/update before writing. It does not silently move the requested scope. Integrity checks diagnose existing mismatches, and uninstall still permits their managed cleanup.

The new regression covers `.git` files and directories, zero writes on rejection, later repository-root changes, a read-only check, preserved ownership records and cleanup. The native probe also checks the corrected package from a nested working directory.

## Reproduction

Use an isolated local directory containing the reviewed official DSH package. Build a fresh Service package, then run:

```sh
node scripts/build-dsh-package.mjs --output /path/to/new-service-dsh-package
```

From Meta_Kim:

```sh
node --test tests/setup/dsh-profile-package.test.mjs tests/setup/deepseek-harness-candidate-runtime.test.mjs
node tests/setup/dsh-native-host-probe.mjs --dsh-root /path/to/official-dsh-environment --service-package /path/to/new-service-dsh-package --report /path/to/report.json
```

The focused Meta_Kim DSH suite passed 22 tests; the Service builder suite passed 9. The native probe records its own exact packed implementation and Service-manifest hashes. Future changes or another host version require new evidence.

## Evidence limits

Model-driven subagent completion, native Hook enforcement, a DSH stage-runner adapter, professional output improvement, and Windows/macOS native DSH behavior were not evaluated here. The report retains those distinctions explicitly. Tests of projection schemas and subprocess translations for other hosts are separate evidence and do not establish their native model acceptance.

Official references: [filesystem Skill discovery](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md), [discovery implementation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/src/index.ts), [subagent lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/README.md), and the reviewed-source links in [the DSH runtime contract](../../canonical/skills/meta-theory/references/runtime-dsh.md).
