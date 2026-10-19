# Contributing

fuse-deck is a CLI and an agent skill that build slide decks from Fuse components and export
them to PDF, PNG, web and PowerPoint. Before opening a PR, establish why the change belongs in
fuse-deck and complete the review and verification below.

These rules apply to every PR, including drafts. A PR into `main` needs no formal approval, but
only a code owner listed in [CODEOWNERS](.github/CODEOWNERS) may merge it. Meeting this guide
makes a PR eligible for merge. The code owner decides whether to merge it.

<a id="where-it-belongs"></a>

## Ask first: fuse-deck, Fuse or the deck?

Before adding a layout, command, flag or text rule, decide which of the three owns the change.

- Fuse owns components, tokens and themes. When a slide shows a component bug or lacks a theme
  role, fix it in [Fuse](https://github.com/elmeragroup/fuse) and pick up the release here. A
  workaround in fuse-deck leaves the bug in every other Fuse app.
- A deck owns its content: text, images and one-off component slides. Decks live in their own
  repositories.
- fuse-deck owns what every deck shares: the layouts, the stage, the text rules, the commands,
  the exports and the skill.

A new layout or text rule serves many decks. Build a one-off as a component slide in the deck
that needs it. When other decks need the same slide, propose it as a layout and cite those decks
as evidence.

<a id="public-content"></a>

## Keep the repository publishable

This repository is public. Sample decks, test fixtures, screenshots and recordings use content
that is safe to publish. Real decks live in private repositories.

<a id="one-problem"></a>

## Solve one problem per PR

Split a PR that solves several independent problems, even when each fix is useful on its own.
Count the underlying problems, not the linked issues.

Include the source, tests, help text and skill text the problem requires. Put unrelated cleanup
and other fixes in separate PRs.

<a id="agent-contract"></a>

## Treat the command line as a contract

Agents drive fuse-deck through its commands, so the command line is public behavior. Command and
flag names, JSON fields, error codes and exit codes form the contract that `--help` and the skill
teach.

A PR that changes the contract updates `--help`, the skill and the tests together, and names the
change in its description. Add a new field or error code in place of renaming or removing one,
unless the PR is a planned breaking change.

<a id="pr-title"></a>

## Title the PR in Title Case

Write the PR title as a plain-language sentence in Title Case: capitalize every word, and keep
code names and brand names in their own casing, such as "Read Office Colors From The Rendered
Page". Wrap an all-lowercase code or brand name in backticks, such as `` `fuse-deck` ``. Leave
out the conventional commit prefix. The PR title becomes the squash commit subject on `main` and
the PR body its description. Commit messages on the branch keep the conventional commit format.

<a id="review-before-submitting"></a>

## Review it before you open it

Complete a full review pass before opening a PR, or before marking a draft ready for review.

Use a reviewer other than the code's author: another person, or an agent with a fresh context.
When an agent wrote the change, the person who directed it can review it. The reviewer checks the
complete proposed diff and relevant surrounding code against the agreed scope and this guide.

<a id="verification"></a>

## Show that it works

Explain how you established the problem and checked the change. Record the focused test commands
or manual checks you ran, the results and anything you could not check.

- Behavior changes include tests.
- Visual changes include before and after PNGs of the affected slides at 1280×720. A new layout
  shows its result in light and dark. Add a short recording when motion or interaction is part
  of the change.
- PowerPoint export changes include a screenshot of the exported file open in PowerPoint. Name
  the app, its version and the platform.
- Upload screenshots and recordings to the PR and keep them out of the repository.

## Merging and closing

Before merging, a code owner checks the problem, the scope decision, any contract change and the
verification evidence.

A code owner may close a PR or request changes when it belongs in Fuse or in a deck, solves
several independent problems, lacks a completed review or lacks evidence. The closing comment
names the rule and explains what would change the outcome.

Address the reason and reopen the PR, or open focused replacement PRs and link them to the
original.
