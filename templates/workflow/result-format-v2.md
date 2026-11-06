## Final message

Return exactly one final fenced json block. The role result body retains schemaVersion 1 even though the workflow policy and plan use version 2. Copy `stepId` and `attempt` from the request.

```json
{
  "schemaVersion": 1,
  "stepId": "from the request",
  "attempt": 1,
  "status": "completed",
  "summary": "what you did or found, in a few sentences",
  "artifacts": [{ "path": "relative/path", "purpose": "what this file is for" }],
  "findings": [{ "code": "SHORT-CODE", "severity": "high", "path": "relative/path", "evidence": "what shows the problem" }],
  "needsInput": []
}
```

- A coder uses `completed` or `blocked`. A reviewer or auditor may also use `needs_changes`.
- Arrays may be empty. Each `needsInput` entry must be a string.
- Do not return agent assignments, model claims or execution settings. The executor records these separately.
- Never include secrets, credentials or tokens in the result, even when quoting repository content.
