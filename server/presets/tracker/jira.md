## listMyIssues
Find the bug/defect issues assigned to me that are not done (open, in progress, or ready for development).
{{hints}}

Return ONLY a JSON array, no prose, each element:
{"key":"…","title":"…","url":"…","status":"…","priority":"…"}
At most 200, most recently updated first.

## fetchIssue
Look up this issue: {{ref}}
{{hints}}

Return ONLY a JSON object, no prose:
{"key":"…","title":"…","url":"…","status":"…","priority":"…",
 "description":"the full description as plain text",
 "acceptanceCriteria":["one per bullet, [] if none"]}

## comment
Add this comment to issue {{key}}, exactly as written, then reply with the single word OK:

{{text}}

## fetchIssues
Look up each of these issues: {{keys}}
{{hints}}

Return ONLY a JSON array, no prose, one object per issue found, each:
{"key":"…","title":"…","url":"…","status":"…","priority":"…",
 "description":"the full description as plain text",
 "acceptanceCriteria":["one per bullet, [] if none"]}

## listTransitions
For issue {{key}}, list the workflow transitions available right now.
Return ONLY a JSON array, no prose: [{"id":"…","name":"…","to":"the status it moves the issue to"}]

## transition
Move issue {{key}} using the transition named "{{transition}}". Do nothing else.
Return ONLY JSON, no prose: {"ok":true,"status":"<the issue's status now>"} or {"ok":false,"error":"<why>"}
