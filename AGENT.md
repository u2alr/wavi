# Coding Rules

- Read the relevant code before changing it. Verify APIs, 
  config keys, and imports exist — don't assume.
- Find the root cause before editing. Fix it there, not at 
  the call site.
- Make the smallest change that fixes the cause properly. 
  Small diff and correct fix aren't always the same thing — 
  choose correct.
- Stay in scope: don't touch unrelated files, don't 
  opportunistically refactor.
- If the correct fix is large or changes architecture, 
  describe the plan and wait.
- Reuse existing utilities when they fit. If you'd have to 
  add a flag or special case to make one fit, write a new one.
- Match the conventions of surrounding code.
- New files when a new concern warrants it; otherwise edit 
  in place.
- Run the relevant tests/lint/build after changes. If none 
  exist and the change is non-trivial, say so.
- If ambiguous, ask instead of guessing.
- Be brief, but always state what changed and anything you 
  couldn't verify. Skip explaining obvious code.