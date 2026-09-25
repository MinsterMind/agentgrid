## listMyIssues
Find the bug/defect issues assigned to me that are not done (open, in progress, or ready for development).
{{hints}}

Return ONLY a JSON array, no prose, each element:
{"key":"…","title":"…","url":"…","status":"…","priority":"…"}
At most 25, most recently updated first.

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
