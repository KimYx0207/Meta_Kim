---
name: commit-review
description: Review git commit messages for Meta_Kim format compliance. Trigger when user asks to review commits, shows commit history, or asks "is this commit format correct". This skill validates commit messages against Meta_Kim's convention from CLAUDE.md and flags violations before push.
version: 1.0.0
author: KimYx0207
user-invocable: true
trigger: "review commit|commit format|commit message|git commit|提交规范|commit lint"
tools:
  - shell
  - filesystem
---

# Commit Review Skill

Reviews git commit messages against Meta_Kim's convention.

## Meta_Kim Commit Format

From `CLAUDE.md` (`C:\Users\admin\Desktop\KimProject\Meta_Kim\CLAUDE.md`):

```
<type>: <description>

<body>

<optional footer>
```

### Allowed Types (whitelist only)

| Type | Use for |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code refactoring without behavior change |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `chore` | Maintenance, dependency updates |
| `perf` | Performance improvements |
| `ci` | CI/CD pipeline changes |

### Rules

1. **Format**: `<type>: <description>` — exactly one colon after type
2. **Type whitelist**: only 8 types above, case-insensitive
3. **No attribution**: never include author name/email in commit message
4. **Imperative mood**: description starts with verb in imperative mood ("add", "fix", "remove" — not "added", "fixed")
5. **Description length**: 10–72 characters
6. **Body/footer**: optional, blank line separates from subject

## When to Use

Use this skill when the user:
- Shows commit history (`git log`, `git log --oneline`)
- Asks "review this commit" or "check commit format"
- Pushes fail lint checks
- Asks "is this commit correct?"

## How to Review

### Step 1: Parse the commit subject line

Split on first `: ` to separate type and description.

### Step 2: Validate each rule

```javascript
function validateCommit(message) {
  const errors = [];
  const lines = message.trim().split('\n');
  const subject = lines[0];

  // Rule 1: Format <type>: <description> (supports CJK and Unicode)
  const match = subject.match(/^([^\s:]+):\s+(.+)/);
  if (!match) {
    errors.push("Must match '<type>: <description>'");
    return errors;
  }

  const [, type, description] = match;

  // Rule 2: Type whitelist
  const ALLOWED_TYPES = ['feat','fix','refactor','docs','test','chore','perf','ci'];
  if (!ALLOWED_TYPES.includes(type.toLowerCase())) {
    errors.push(`Invalid type '${type}'. Allowed: ${ALLOWED_TYPES.join(', ')}`);
  }

  // Rule 3: No attribution (no "by author" or email)
  if (/@[\w.-]+\.[a-z]{2,}/i.test(message) || /by\s+\w+/i.test(subject)) {
    errors.push("No attribution allowed in commit message (disabled globally in Meta_Kim)");
  }

  // Rule 4: Imperative mood
  const NON_IMPERATIVE = /^(added|fixed|removed|changed|updated|created|deleted|installed|improved|refactored|cleaned|moved|renamed|modified|optimized)/i;
  if (NON_IMPERATIVE.test(description)) {
    errors.push(`Use imperative mood: '${description}' → '${description.replace(/^(added|fixed|removed|changed|updated|created|deleted|installed|improved|refactored|cleaned|moved|renamed|modified|optimized)/i, m => m.replace(/ed$/,'')}'`);
  }

  // Rule 5: Length 10-72
  if (description.length < 10) {
    errors.push(`Description too short (${description.length}/10 min)`);
  }
  if (description.length > 72) {
    errors.push(`Description too long (${description.length}/72 max)`);
  }

  return errors;
}
```

### Step 3: Report findings

Format output as:

```
## Commit Review

**Commit**: `<type>: <description>`

| Rule | Status | Note |
|------|--------|------|
| Format `<type>: <description>` | ✅/❌ | |
| Type whitelist | ✅/❌ | |
| No attribution | ✅/❌ | |
| Imperative mood | ✅/⚠️ | |
| Length 10-72 | ✅/⚠️ | |

**Verdict**: PASS / WARN / FAIL

**Fixes** (if any):
1. ...
```

## Examples

### Good commit
```
feat: add commit-review skill for Meta_Kim
```
✅ All 5 rules pass.

### Bad commits

**Wrong type**:
```
update: add new feature
```
❌ `update` not in whitelist. Did you mean `feat`?

**Attribution**:
```
fix: resolve bug by john@example.com
```
❌ No attribution allowed.

**Past tense**:
```
added: validation for commit format
```
❌ Use imperative mood: `added` → `add`

**Too short**:
```
fix: bug
```
❌ Description too short (4/10 min).

## Output

Always return structured review with:
- Verdict: PASS / WARN / FAIL
- Per-rule status table
- Specific fix suggestions with corrected examples
