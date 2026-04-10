You are reviewing a completed task session. Extract learnings into structured categories.

ORGANIZATION KNOWLEDGE — facts about the company, its products, processes, or conventions that would help ANY employee on ANY future task.

Examples of what to extract:
- Technical stack details: "Backend uses NestJS with PostgreSQL (Prisma ORM)"
- Process rules: "Blog posts require Sarah's approval before publishing"
- Product details: "Feature flags are managed via LaunchDarkly"
- Brand/partner information discovered through research

USER PREFERENCES — how a specific person prefers to work or communicate, that would help when working WITH THEM specifically.

Examples of what to extract:
- "Egor prefers concise Slack updates, not play-by-play"
- "Sarah wants bullet-point summaries for marketing reviews"
- "Hattie provides structured briefs with all challenge parameters upfront"

Rules:
- Only extract things useful in FUTURE tasks (not task-specific details like dates or step goals)
- If something contradicts existing knowledge, use "update" action to replace the old entry
- If nothing worth remembering, return empty arrays
- Be concise — one line per fact
- Default ambiguous items to USER level (not org)
- Identify users by their first name (lowercase) from the Slack mentions in the log

Current organizational knowledge:
<org_memory>
{{ORG_MEMORY}}
</org_memory>

Current user knowledge:
<user_memory>
{{USER_MEMORY}}
</user_memory>

Task metadata:
<task_metadata>
Task ID: {{TASK_ID}}
Participants: {{PARTICIPANTS}}
Task Owner: {{TASK_OWNER}}
Status: {{STATUS}}
Created: {{CREATED_AT}}
</task_metadata>

Task transcript (knowledge.log):
<transcript>
{{TRANSCRIPT}}
</transcript>

Respond with ONLY a JSON object in this exact format (no markdown fences, no explanation):

{
  "org_updates": [
    {"action": "add", "section": "SectionName", "content": "one-line fact"},
    {"action": "update", "old": "text of old line to replace", "content": "corrected one-line fact"}
  ],
  "user_updates": {
    "username": [
      {"action": "add", "section": "SectionName", "content": "one-line preference"}
    ]
  },
  "task_summary": "A 3-5 sentence summary of what happened in this task, key decisions made, and outcomes.",
  "activity_summary": "One-line description of the task for the activity index (under 80 chars)",
  "domain": "engineering|marketing|operations|product|other"
}
