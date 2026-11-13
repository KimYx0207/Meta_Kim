import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** npm owns dependency refresh for an installed package (including npx).
 * Source checkouts retain setup's npm-install lifecycle. Hoisted dependencies
 * are valid; a package-local node_modules directory is not required by Node.
 */
export function hasNpmInstalledDependencies(packageRoot) {
  try {
    const root = path.resolve(packageRoot);
    const manifestPath = path.join(root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const segments = String(manifest.name ?? '').split('/');
    const installParent = segments.reduce(parent => path.dirname(parent), root);
    if (!manifest.name || path.basename(installParent) !== 'node_modules' ||
        path.join(installParent, ...segments) !== root) return false;
    const resolver = createRequire(manifestPath);
    return Object.keys(manifest.dependencies ?? {}).every(name =>
      (resolver.resolve.paths(name) ?? []).some(directory => {
        const dependencyManifest = path.join(directory, name, 'package.json');
        if (!existsSync(dependencyManifest)) return false;
        try { return JSON.parse(readFileSync(dependencyManifest, 'utf8')).name === name; }
        catch { return false; }
      }));
  } catch { return false; }
}
