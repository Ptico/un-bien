# Changelog — Un Bien

Notable user-facing changes to the companion app. The app ships
independently of the npm/relay packages; daemon-side features (resume,
launch, terminate) additionally require a current launcher daemon /
extension on the machines.

## 1.2 (build 6)

- **Resume Session** — long-press a machine row and pick a stored pi
  session to relaunch: recency-ordered list, type-to-filter, sortable by
  name/message count. The resumed chat auto-opens when it comes live.
  Requires a launcher daemon advertising `session_resume` (0.1.9+ of the
  launcher / extension 0.20.5+); the menu item is hidden on older daemons.
- **New Conversation…** joins the machine long-press menu (previously
  only the ＋ chip).
- Launched and resumed conversations **auto-open** when their room comes
  live — deterministic, via the daemon's launch-correlation echo. A
  launch that never comes live expires quietly after 60s (the session
  still appears via normal discovery).
- Truthful error states in the resume picker: a machine refusal
  (unpaired / directory gate / lister failure) is shown as such instead
  of a fake "No stored sessions".
- Fixed: the model picker's open menu could snap back to the top while
  scrolling when the model roster refreshed (row identity churn); models
  are keyed by provider+id.

## 1.1 (build 5)

- Initial App Store release ("Un Bien").
- Relays, QR pairing (`unbien://` deep link), live session transcripts
  with streaming tool calls / text / thinking, steering and queued
  follow-ups, tool-call approval, fork / clone / branch, subagent and
  plan panels, remote rename and terminate, model & thinking pickers,
  themes, iOS + macOS.
