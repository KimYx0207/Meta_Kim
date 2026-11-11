#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { assert, readJson, repoPath } from "./governance-lib.mjs";

const README_LOCALES = new Map([
  ["README.md", "en"],
  ["README.zh-CN.md", "zh-CN"],
  ["README.ja-JP.md", "ja-JP"],
  ["README.ko-KR.md", "ko-KR"],
]);
const REQUIRED_PUBLIC_IMAGES = [
  "docs/images/contact-qr.png",
  "docs/images/wechat-pay.jpg",
  "docs/images/alipay.jpg",
];

const pkg = await readJson("package.json");
const gitignore = await fs.readFile(repoPath(".gitignore"), "utf8");

assert(/^docs\/\*\*$/m.test(gitignore), ".gitignore must keep docs private by default");
assert(/^!docs\/$/m.test(gitignore), ".gitignore must allow the docs directory for public image exceptions");
assert(/^!docs\/images\/$/m.test(gitignore), ".gitignore must allow docs/images/");
assert(/^!docs\/images\/\*\*$/m.test(gitignore), ".gitignore must allow docs/images/**");
assert(
  (pkg.files ?? []).includes("docs/images/"),
  "package.json files must include docs/images/ because README references those assets",
);

function gitTracked(relativePath) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", relativePath], {
    cwd: repoPath("."),
    encoding: "utf8",
  });
  return result.status === 0;
}

function extractDocsImages(markdown) {
  const refs = new Set();
  for (const match of markdown.matchAll(/!\[[^\]]*\]\((docs\/images\/[^)\s]+)\)/g)) {
    refs.add(match[1]);
  }
  for (const match of markdown.matchAll(/<img\b[^>]*\bsrc=["'](docs\/images\/[^"']+)["'][^>]*>/gi)) {
    refs.add(match[1]);
  }
  return [...refs].sort();
}

const referenced = new Set();
for (const [file, locale] of README_LOCALES) {
  const markdown = await fs.readFile(repoPath(file), "utf8");
  const refs = extractDocsImages(markdown);
  assert(refs.length > 0, `${file} must keep README image references explicit`);
  for (const ref of refs) {
    referenced.add(ref);
    await fs.access(repoPath(ref));
    assert(gitTracked(ref), `${ref} referenced by ${file} must be tracked`);
    if (ref.endsWith(".svg")) {
      const svg = await fs.readFile(repoPath(ref), "utf8");
      const language = svg.match(/<svg\b[^>]*\slang="([^"]+)"/)?.[1];
      assert(language === locale, `${file} illustration ${ref} must use ${locale}, found ${language ?? "no language"}`);
      assert(/<title\b[^>]*>[^<]+<\/title>/.test(svg), `${ref} needs an accessible title`);
      assert(/<desc\b[^>]*>[^<]+<\/desc>/.test(svg), `${ref} needs a localized description`);
    }
  }
}

for (const image of REQUIRED_PUBLIC_IMAGES) {
  assert(referenced.has(image), `${image} must remain referenced by README files`);
  await fs.access(repoPath(image));
  assert(gitTracked(image), `${image} must be tracked as a public README asset`);
}

console.log(
  `public docs image assets valid: ${referenced.size} README image assets checked`,
);
