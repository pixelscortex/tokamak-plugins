# Code

Code saves the Git worktree before and after each agent turn on the client that runs it.
Install it alongside Chat; AI is optional. A turn that starts outside a Git worktree
gets no snapshots, even if the agent runs `git init` during that turn.

- On the QuickJS Runner, Code saves both snapshots in its own process.
  The after hook looks up the before ref by thread and turn, using its
  original worktree even if the selected folder has become a nested
  repository. A new Code process can complete the pair. An unavailable
  provider or snapshot that cannot be saved leaves the usual warning.
- Each turn with Git gets commits at
  `refs/tokamak/threads/<thread key>/turns/<turn key>/before` and `…/after`.
  The keys are the parts of the thread and turn IDs after the colon.
- Code copies the Git index to reuse cached file metadata, then resets the copy
  to HEAD. It reads HEAD into an empty index if the copy can't be reused (such
  as during a merge), and starts empty when there is no HEAD.
- Code stages changes only within the thread's selected folder. An ignored
  folder contributes only tracked files (`git add -u`). Outside the selected
  folder, the tree keeps the versions from HEAD. Submodules appear as Git links;
  the enclosing snapshot doesn't include their working files.
- Git's ignore rules apply to untracked files. New files over 50 MB are skipped
  and named under the reply. Those names are read from the local snapshot commits.
- A failed before hook prevents the agent from starting. A failed after hook
  leaves the reply and turn outcome in place. The client shows a warning.
  An interrupted turn keeps its before ref so the warning and the original
  snapshot remain available until the thread is deleted.
- Deleting from the desktop thread menu removes the thread's refs in its
  repository. When Chat opens on the desktop again, Code also checks the
  repositories recorded for that signed-in device and removes snapshot refs
  for threads deleted elsewhere. A plain browser cannot change local refs.
  The cleanup attaches to Chat's `Composer` and prunes once per connection.

In a window connected to a Runner:

- A change card under the last reply of a turn that changed files: "4 files +86 −21 · open in
  review". The first turn after a turn that ran without Git says "Started tracking · 12 files".
- The branch as a chip after the thread title, read again every 3 seconds while the window is
  visible, and when it is shown or focused.
- A layout control before the thread menu that opens the review panel: "Turn 3 · 4 files +86 −21",
  the files with their counts, then plain diffs. The panel loads at most 3,000 hunk lines and
  marks the file it cut. The panel attaches to Chat's `Header` and renders
  in the shell's panel region for as long as that thread's header is mounted
  and review is open.
- On another computer (a second desktop of the same person, or a teammate's), the thread's
  folder path may not exist or may point at an unrelated repository with no snapshot refs, so
  nothing shows there. How code travels between computers is milestone 2.

These read Git through the caller actions `changes:forTurn`, `changes:diff` and `changes:branch`
(`src/server/changes.ts`, helpers in `src/local/changes.ts`). Nothing about code is stored on the server.

The caller action `notices:forTurn({ threadId, turnId })` reads omissions and the warning
from Git. `src/local/git.ts` has the matching `turnRefs(threadId, turnId)` helper.
The after hook also reads the before ref for that turn. It can recover the
pair even if the Code process restarted while the agent was running.

Run `bash .ci/check.sh rust` from the repository root to test snapshots and
change reads with a Runner, the real server, and a fake agent.
Run `proto run bun -- e2e/browser.ts code.spec.ts` for the desktop window path.
