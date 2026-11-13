const quote = value => JSON.stringify(String(value));

/** Host metadata is translated; the original method bytes stay in source/. */
export function renderDesktopSkill(host, metadata) {
  const { id, displayName, description, displayNameEn, descriptionEn, version, entrypoint, kind } = metadata;
  const fields = [`name: ${id}`, `description: ${quote(description)}`];
  if (host.renderer === 'workbuddy') fields.push(
    `display_name: ${quote(displayName)}`, `display_name_en: ${quote(displayNameEn ?? id)}`,
    `description_zh: ${quote(description)}`, `description_en: ${quote(descriptionEn ?? description)}`,
    `version: ${quote(version)}`, 'author: KimYx0207');
  else if (host.renderer === 'doubao') fields.push('metadata:', `  version: ${quote(version)}`, `  source: ${quote(kind === 'meta' ? 'KimYx0207/Meta_Kim' : 'KimYx0207/Kim_Service')}`);
  else throw new Error(`Unsupported desktop skill renderer: ${host.renderer}`);
  return `---\n${fields.join('\n')}\n---\n\n# ${displayName}\n\n` +
    `This is a portable method import for ${host.displayName}. Read \`source/${entrypoint}\` and \`package-provenance.json\` before acting. Resolve all original relative references from their original source/ directory, not from this wrapper. Read the complete selected method, capability/method contracts, relevant references, scripts and acceptance criteria; do not treat this loader as their substitute.\n\n` +
    `Native Agent names, tools, MCP servers, Hooks, shell access and runtime commands mentioned in the original method are requirements to check, not capabilities this ZIP grants. Agent components are loaded as methods inside a Skill; they are not registered native Agents or experts. This package does not install the Meta_Kim executable runtime. Use a separately verified installation for commands that require that runtime. If a required referenced capability or resource is unavailable, report the missing requirement before dependent work.\n\n` +
    `Bind only the current host's actual tools and permissions. Inherit the current host model and respect the user's explicit model constraints. If the required model is unavailable, report that gap before model-dependent work; do not silently substitute another model. No model call, background daemon, Hook, credential or user configuration is added by import generation.\n\n` +
    `Keep completed artifacts and a project-local checkpoint for unfinished work. Record input sources, artifact paths and hashes, tool errors and the next unfinished step. Resume only the same verified project/task and input revision. Return real outputs plus unresolved requirements; a saved file, imported Skill, queued task or successful script is not automatically model completion or professional/business acceptance.\n`;
}
