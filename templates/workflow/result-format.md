## Final message

Your final message must be one JSON object and nothing else, in this form. Copy `stepId` and `attempt` from the request.

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

- `status` is one of `completed`, `needs_changes`, `blocked`. A Coder uses only `completed` or `blocked`.
- `artifacts`, `findings` and `needsInput` may be empty arrays. Each item of `needsInput` is a string.
- Never put secrets, tokens or passwords in this message, even when quoting a file or a log.
