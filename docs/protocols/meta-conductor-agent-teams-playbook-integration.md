# Meta_Kim + agent-teams-playbook Integration Protocol

**Version**: 1.0
**Target**: agent-teams-playbook v4.5
**Integration Mode**: Pipeline Mode (playbook decides, Conductor executes)
**Document Classification**: Protocol Addition to meta-conductor.md

---

## 1. Overview

This protocol defines the integration between Meta_Kim's `meta-conductor` and the `agent-teams-playbook` skill in Pipeline Mode. In this mode, the playbook provides orchestration decisions (scenario selection, team blueprint, dispatch board), while meta-conductor executes the decisions by generating Standard Task Boards and managing the card deck.

**Design Principles**:
- No changes to external skills (agent-teams-playbook remains unmodified)
- Conductor parses natural language output from playbook
- Strict mode: parsing failure throws error (no silent defaults without logging)
- teamBlueprint converts to workerTaskPackets for Conductor's dispatch board

---

## 2. Integration Architecture

```
[Planning Gate]
       ↓
[Stage 4: Execution]
       ↓
Skill("agent-teams-playbook", args="<task-description>")
       ↓
[Natural Language Output]
       ↓
[Conductor Parsing Layer]
       ↓
[Strict Mode Validation]
   ┌───┴───┐
Success    Failure → Error Recovery Chain
   ↓
[workerTaskPackets]
       ↓
[dispatchEnvelopePacket Generation]
       ↓
[Card Deck Execution]
```

---

## 3. How meta-conductor Calls agent-teams-playbook

### 3.1 Invocation Trigger

Conductor invokes agent-teams-playbook at Stage 4 (Execution) start when:
1. The run has passed the Planning Gate (all Standard Task Board fields present)
2. Parallel execution is required (workflow complexity >= 3)
3. Team orchestration decisions are needed (Scenario 3-5 from playbook)

### 3.2 Invocation Format

```
Skill(skill="agent-teams-playbook", args="<context>")
```

**Context Parameters** (passed as natural language):
- `Current Round Department`: [department name]
- `Sole Primary Deliverable`: [specific deliverable]
- `Target Audience`: [audience description]
- `Parallel Lane Specifications`: [abstract lanes from specifyStageExecutionLanes()]
- `Owner Resolution`: [existing-owner / create-owner-first / temporary-fallback-owner]

### 3.3 Invocation Example

```
Skill(skill="agent-teams-playbook", args="Task: Implement user authentication system for the AI Department.
Department: AI Department
Deliverable: Authentication service with OAuth2 + JWT
Audience: Internal developers
Parallel Lanes: API (execution), Security (parallel review), Database (parallel setup)
Owner Resolution: existing-owner
Stage: Need team blueprint for parallel execution")
```

---

## 4. Expected Natural Language Output Format

The playbook returns structured natural language output with three key sections.

### 4.1 Section 1: Scenario Decision

**Chinese Output**:
```
选定场景: 场景3（计划+评审）
```

**English Output**:
```
Selected Scenario: Scenario 3 (Plan + Review)
```

**Parsable Patterns**:
| Pattern | Expected Value | Example |
|---------|---------------|---------|
| `/选定场景[：:]\s*(场景?\s*\d+)/i` | Chinese scenario | `场景3` |
| `/(Scenario\s*\d+)/i` | English scenario | `Scenario 3` |

### 4.2 Section 2: Team Blueprint (Table)

**Chinese Output**:
```
| 编号 | 角色 | 职责 | 模型 | subagent_type | Skill/Type |
|------|------|------|------|---------------|------------|
| 1 | API开发者 | 实现OAuth2端点和JWT生成 | sonnet | general-purpose | Type: general-purpose |
| 2 | 安全审查员 | 安全审计和漏洞检测 | opus | general-purpose | Type: general-purpose |
| 3 | 数据库架构师 | 设计用户表和索引 | sonnet | general-purpose | Skill: supabase-admin-rls-auth-mismatch |
```

**English Output**:
```
| # | Role | Responsibility | Model | subagent_type | Skill/Type |
|---|---|---|---|---|---|
| 1 | API Developer | Implement OAuth2 endpoints and JWT | sonnet | general-purpose | Type: general-purpose |
| 2 | Security Reviewer | Security audit and vulnerability detection | opus | general-purpose | Type: general-purpose |
```

**Parsable Patterns**:
| Column | Pattern | Expected Values |
|--------|---------|-----------------|
| 编号 | `/^\|\s*(\d+)\s*\|/` | `1`, `2`, `3` |
| 角色 | `\|([^|]+)\|` (2nd field) | Role name string |
| 职责 | `\|([^|]+)\|` (3rd field) | Responsibility description |
| 模型 | `/((?:opus\|sonnet\|haiku))/i` | `opus`, `sonnet`, `haiku` |
| subagent_type | `/(general-purpose|skill-based)/i` | `general-purpose`, `skill-based` |
| Skill/Type | `/\[Skill:\s*([^\]]+)\]/` or `/\[Type:\s*([^\]]+)\]/` | Skill name or `general-purpose` |

### 4.3 Section 3: Dispatch Board

**Chinese Output**:
```
协作模式: Subagent
预计Agent数: 3个
选定场景: 场景3（计划+评审）
```

**English Output**:
```
Collaboration Mode: Subagent
Estimated Agents: 3
Selected Scenario: Scenario 3 (Plan + Review)
```

**Parsable Patterns**:
| Pattern | Expected Value | Example |
|---------|---------------|---------|
| `/协作模式[：:]\s*(Subagent\|Agent Team)/i` | Collaboration mode | `Subagent` |
| `/(Collaboration Mode)[:\s]*(Subagent\|Agent Team)/i` | English variant | `Agent Team` |
| `/预计Agent数[：:]\s*(\d+)/` | Agent count | `3` |

---

## 5. Parsing Strategy

### 5.1 Scenario Parsing

```javascript
function parseScenario(nlOutput) {
  // Chinese pattern
  let match = nlOutput.match(/选定场景[：:]\s*(场景?\s*\d+)/i);
  
  // English fallback
  if (!match) {
    match = nlOutput.match(/(Scenario\s*\d+)/i);
  }
  
  if (!match) {
    throw new ParseError('SCENARIO_MISSING', {
      detail: 'Cannot determine playbook scenario from output',
      output: nlOutput.substring(0, 200)
    });
  }
  
  // Normalize to scenario number
  const scenarioNum = match[1].match(/\d+/)[0];
  return parseInt(scenarioNum);
}
```

### 5.2 Team Blueprint Parsing

```javascript
function parseTeamBlueprint(tableSection) {
  const rows = tableSection
    .split('\n')
    .filter(line => line.match(/^\|\s*\d+\s*\|/));
  
  if (rows.length === 0) {
    throw new ParseError('BLUEPRINT_EMPTY', {
      detail: 'No team blueprint rows found in table'
    });
  }
  
  const agents = rows.map((row, index) => {
    const cols = row.split('|').slice(1, -1).map(c => c.trim());
    
    // Strict: must have exactly 6 columns
    if (cols.length !== 6) {
      throw new ParseError('BLUEPRINT_COLUMN_MISMATCH', {
        detail: `Row ${index + 1}: expected 6 columns, got ${cols.length}`,
        row: row
      });
    }
    
    return {
      id: parseInt(cols[0]),
      role: cols[1],
      responsibility: cols[2],
      model: normalizeModel(cols[3]),
      subagentType: normalizeSubagentType(cols[4]),
      skillOrType: parseSkillOrType(cols[5])
    };
  });
  
  return agents;
}

function normalizeModel(input) {
  const m = input.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  throw new ParseError('MODEL_INVALID', { detail: `Unknown model: ${input}` });
}

function parseSkillOrType(input) {
  const skillMatch = input.match(/\[Skill:\s*([^\]]+)\]/);
  if (skillMatch) return { type: 'skill', name: skillMatch[1] };
  
  const typeMatch = input.match(/\[Type:\s*([^\]]+)\]/);
  if (typeMatch) return { type: 'general-purpose', name: typeMatch[1] };
  
  throw new ParseError('SKILL_TYPE_MISSING', { detail: `Cannot parse skill/type: ${input}` });
}
```

### 5.3 Dispatch Board Parsing

```javascript
function parseDispatchBoard(nlOutput) {
  // Chinese pattern
  let match = nlOutput.match(/协作模式[：:]\s*(Subagent|Agent Team)/i);
  
  // English fallback
  if (!match) {
    match = nlOutput.match(/(Collaboration Mode)[:\s]*(Subagent|Agent Team)/i);
  }
  
  if (!match) {
    throw new ParseError('DISPATCH_BOARD_MISSING', {
      detail: 'Cannot determine collaboration mode',
      output: nlOutput.substring(0, 200)
    });
  }
  
  // Extract agent count if present
  const countMatch = nlOutput.match(/预计Agent数[：:]\s*(\d+)/)
    || nlOutput.match(/Estimated Agents[:\s]*(\d+)/i);
  
  return {
    mode: match[1].toLowerCase() === 'agent team' ? 'agent_team' : 'subagent',
    estimatedAgents: countMatch ? parseInt(countMatch[1]) : null
  };
}
```

---

## 6. Error Handling

### 6.1 Strict Mode Behavior

In strict mode, parsing failures throw errors immediately. This ensures:
- No silent corruption of playbook decisions
- Complete audit trail of parsing attempts
- Clear escalation path to Warden

### 6.2 Error Codes and Recovery

| Error Code | Trigger | Recovery Action |
|------------|---------|-----------------|
| `SCENARIO_MISSING` | No scenario match found | Re-invoke playbook with explicit "请输出选定场景" |
| `BLUEPRINT_EMPTY` | No table rows found | Request table format explicitly |
| `BLUEPRINT_COLUMN_MISMATCH` | Row has != 6 columns | Request reformatted table |
| `MODEL_INVALID` | Model value not recognized | Default to `sonnet` with warning |
| `SKILL_TYPE_MISSING` | Cannot parse Skill/Type column | Default to `Type: general-purpose` |
| `DISPATCH_BOARD_MISSING` | No collaboration mode found | Default to `subagent` if task is parallelizable |
| `PARSE_COMPLETE_FAILURE` | All parsing attempts failed | Escalate to Warden |

### 6.3 Error Recovery Chain

```
[ParseError Thrown]
       ↓
[Attempt Tolerant Regex]
   ┌───┴───┐
Success    Failure
   ↓           ↓
[Continue]  [Apply Defaults]
                 ↓
         [Emit Warning to Run Artifact]
                 ↓
         [Continue or Escalate]
```

**Default Values**:
- Scenario: `3` (Plan + Review)
- Collaboration Mode: `subagent`
- Model: `sonnet`
- Skill/Type: `Type: general-purpose`

---

## 7. teamBlueprint to workerTaskPackets Conversion

### 7.1 Field Mapping

| Playbook Field | Task Board Field | Mapping Logic |
|---------------|-----------------|---------------|
| `cols[1]` (角色) | `Owner` | Direct copy |
| `cols[2]` (职责) | `Today's Task` | Convert to task type description |
| `cols[3]` (模型) | `[embedded]` | Model preference in task constraints |
| `cols[4]` (subagent_type) | `Owner Mode` | `general-purpose` → `existing-owner` |
| `cols[5]` (Skill/Type) | `Reference Direction` | Link to capability catalog |
| `scenario` | `Parallel Group` | Scenario 3-5 agents share parallel group |
| `mode` | `dispatchEnvelopePacket.route` | `subagent` → `project_only` |

### 7.2 Conversion Example

**Playbook Output**:
```
| 1 | API开发者 | 实现OAuth2端点 | sonnet | general-purpose | Type: general-purpose |
```

**Generated workerTaskPacket**:
```yaml
### API-Developer
- Owner: API开发者
- Owner Mode: existing-owner
- Today's Task: API endpoint implementation (OAuth2)
- Deliverable: Endpoint contract and implementation
- Relationship to Primary Deliverable: Core authentication feature
- Quality Standard: [Missing]  # Must be filled by Conductor
- Reference Direction: capability://general-purpose/execution
- Handoff Target: [Next stage in delivery chain]
- Length Expectation: Medium
- Visual/Material Strategy: No visual delivery needed this round
- Depends On: []
- Parallel Group: auth-team-execution
- Merge Owner: meta-conductor
- Task Packet ID: packet-001
```

---

## 8. Protocol Constraints

1. **No External Skill Changes**: This protocol requires no modifications to agent-teams-playbook v4.5
2. **Pipeline Mode Only**: Conductor operates in execute mode, not decision mode
3. **Natural Language Parsing**: All parsing must handle natural language output (no structured JSON)
4. **Strict Mode Default**: Error throwing is the default; lenient defaults require explicit configuration
5. **Backward Compatibility**: This protocol adds to existing Stage 4 responsibilities without replacing them

---

## 9. Verification

Verification of this protocol integration:

```bash
npm run meta:validate
```

Expected validation targets:
- `canonical/agents/meta-conductor.md` — Stage 4 section present
- `canonical/agents/meta-conductor.md` — Review owner assigned to `meta-prism`
- No changes to `~/.claude/skills/agent-teams-playbook/SKILL.md`

---

## 10. Reference Files

- **Integration Target**: `canonical/agents/meta-conductor.md` (Stage 4 section)
- **Playbook Source**: `~/.claude/skills/agent-teams-playbook/SKILL.md` (v4.5)
- **Validation Command**: `npm run meta:validate`
