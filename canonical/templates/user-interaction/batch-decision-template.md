# Batch Decision Template

Use this template when multiple independent questions can be decided together.

Every visible question must change an execution branch and offer at least two materially different options. Do not add filler questions or filler options to satisfy a count. Each option must state what changes, what problem it solves, the expected result, advantages, and disadvantages in product language a non-technical user can understand.

## Dependency Detection

```python
# Pseudocode: dependency detection
def detect_dependency(questions):
    """
    Returns: linear_groups (list of lists, each inner list is a linear dependency chain)
    """
    dependency_graph = build_dependency_graph(questions)
    linear_groups = topological_sort(dependency_graph)
    return linear_groups

# Example
questions = [
    {"id": "tech_stack", "depends_on": []},
    {"id": "framework", "depends_on": ["tech_stack"]},  # Linear: depends on tech_stack
    {"id": "ui_style", "depends_on": []},               # Independent
    {"id": "deploy_method", "depends_on": []},          # Independent
]
# Result: [[tech_stack, framework], [ui_style], [deploy_method]]
#       → First group: sequential questions, last two: can be batched
```

## Linear vs Parallel Detection

| Type | Characteristic | Question Format | Example |
|------|----------------|-----------------|---------|
| **Linear** | Later options depend on earlier choice | Sequential questions | Tech stack → Framework → Tool |
| **Parallel** | Independent decisions | Batch list, one-time selection | UI style, Deploy method, Test strategy |

## Batch Format (Markdown)

```markdown
## 📋 Batch Decision List

The following questions are independent. Please select one option for each:

---

### Question 1: {Question Title}

{Context: Why this decision is needed}

| Option | What Changes | Problem Solved | Expected Result | Advantages | Disadvantages |
|--------|--------------|----------------|-----------------|------------|---------------|
| **A** | {description} | {description} | {description} | {description} | {description} |
| **B** | {description} | {description} | {description} | {description} | {description} |
| **C** | {description} | {description} | {description} | {description} | {description} |

**Your choice:** [ ] A [ ] B [ ] C

---

### Question 2: {Question Title}

{Context: Why this decision is needed}

| Option | What Changes | Problem Solved | Expected Result | Advantages | Disadvantages |
|--------|--------------|----------------|-----------------|------------|---------------|
| **A** | {description} | {description} | {description} | {description} | {description} |
| **B** | {description} | {description} | {description} | {description} | {description} |
| **C** | {description} | {description} | {description} | {description} | {description} |

**Your choice:** [ ] A [ ] B [ ] C

---

Please respond with your choices, e.g., "1A, 2B" or "Question 1: A, Question 2: B"
```

## Runtime Adapter Payload (Batch)

For platforms that support multi-question native choice surfaces, the runtime adapter may render the independent questions as one interaction. The canonical batch remains a semantic decision list, not a renderer-specific schema.

The adapter must preserve each question id, dependency group, recommended default, runtime-native maximum option policy, trade-offs, and selection result. If the host cannot render all independent questions in one native surface, it must use a localized chat decision card rather than inventing a fake popup.

For primary native runtimes, batch rendering must still preserve structured panel semantics: AI understanding, AI additions, Capability route, Candidate paths, expected result, advantages, disadvantages or risk, and verification impact. Runtime adapters must use the active host's maximum meaningful option count and obey native payload limits rather than sending an oversized native payload.

## When to Use

- Multiple independent decisions need to be made
- Questions do not have dependency relationships
- User attention budget is limited (prefer one interaction over N)

## When Not to Use

- A question would not change the deliverable, scope, risk, cost, permission, or acceptance
- A safe default is clear from Critical, Fetch, and Thinking evidence
- The batch exists only to make the interaction look comprehensive

## Prompt Acceptance

This template binds `user-interaction-and-i18n`, `governance-orchestration`, `runtime-native-surfaces`, and `verification-eval-and-release`. It defines semantic batching only; runtime adapters decide how to render the choices.

## Pass

- Every batched question is independent or grouped by an explicit dependency chain.
- Each question has at least two materially different options and one recommended default when evidence supports it.
- Each option preserves what changes, problem solved, expected result, advantages, and disadvantages.
- Host fallback keeps the same question id, dependency group, trade-offs, selection result, and locale.

## Fail

- The batch includes filler questions, filler options, or choices that do not change the user-visible result, scope, risk, cost, permission, or acceptance.
- It hides linear dependencies inside a single parallel batch.
- It invents renderer-specific schemas in the canonical template.

## Block

Block batching when choices are dependent, missing trade-offs, missing option ids, missing locale, or when a safe default is already clear enough to proceed without asking.

## Return to stage

Return to Critical for unclear user intent. Return to Fetch when evidence is insufficient to define trade-offs. Return to Thinking when option branches or owner/loadout effects are missing.

## Verification

Validate runtime-native maximum option policy, dependency grouping, recommended default, trade-off completeness, fallback reason, and locale preservation. Run `npm run meta:prompt:validate` after editing this template.

## Preserve

Preserve native choice surfaces, chat decision card fallback, localization, user control, and the rule that users answer only route-changing questions.
