---
description: Commit changes with logical grouping
---

You are preparing git commits for this repository.

## Instructions:

1. **Analyze changes** - Run `git status` and `git diff` (staged + unstaged) to understand ALL changes
2. **Read the diffs carefully** - Don't guess what changed. Read the actual diff output to understand:
   - What functionality was added/changed/removed
   - Why these changes were made (infer from context)
   - How changes relate to each other
3. **Group logically** - Identify logical change groups. Examples:
   - "Add coin tap haptic feedback" (might touch multiple files: scene, view, etc.)
   - "Fix missed rewards using range.upperBound" (might be a single file change)
   - "Refactor TopBlockView to isolate re-renders" (could span several files)

   **Do NOT:**
   - Create one commit per file (too granular)
   - Commit everything in one commit (too broad)
   - Guess at changes without reading the diff

4. **Verify build** - Run the build command before committing
5. **Create commits** - For each logical group:
   - Stage only the relevant files for that group
   - Write a concise commit message (1-2 sentences) focusing on "why" not "what"
   - Match the repo's commit message style (check recent commits with `git log --oneline -10`)
6. **Show summary** - After committing, show what was committed
7. **Wait for push approval** - Do NOT push automatically. Wait for user to explicitly request push.

## Commit Message Format:

Use this style (check recent commits for reference):
```
Short summary of the change

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Important:

- NEVER push without explicit user approval
- NEVER skip the build verification
- NEVER guess at changes - always read the actual diff
- If changes are unrelated, split into separate commits
- If changes are tightly coupled, keep in one commit

$ARGUMENTS
