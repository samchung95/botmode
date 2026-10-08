---
name: clarify
description: Ask the owner a few quick multiple-choice questions before you act on a request you cannot place, such as which machine, bot, session or folder it means, or what it relates to. Load it when a request could mean more than one thing and a wrong guess would cost a handoff or be hard to undo.
---

# Clarify before you act

The owner often asks with context only they have. "How do I create A?" may mean an A on this machine or another one, one a bot's session already worked on, or one tied to other work. A wrong guess wastes a handoff or changes the wrong thing, so ask a few short questions first.

## When to ask

Ask when a request has more than one reasonable reading and they lead to different actions, or when a wrong guess is hard to undo. Do not ask when one look settles it, or when a guess is cheap to undo: act, and state your assumption in one line.

## Look first

Find the candidates, so that every question is answered with a pick:
- `configure {}` lists the bots, the bot sessions on this machine and the Claude Code profiles.
- Your team list names the bots on other machines (`host/bot`) and the sessions at work right now.
- Search the likely folders for what the owner named.
- For another machine, ask its handler, `host/handler`.

Drop a question that the look answers.

## Ask

Call `ask_user_question` once, with everything you need to know:
- 1-4 questions, each with 2-4 options. Put the option you would pick first, with "(Recommended)" at the end of its label.
- `header`: a chip of up to 16 characters, such as "Machine" or "Session".
- `label`: 1-5 words, up to 60 characters. `description`: what happens if they pick it.
- No "Other" option: the dialog adds a row where the owner types an answer of their own.

Ask only what changes what you do. The usual questions:
- Which machine: this one, `mac` or `laptop`?
- Which session: continue `research.13`, a fresh copy, or a new bot?
- Is it related to Z, the earlier work, or is it new?
- Which folder or repository?

```json
{"questions": [
  {"question": "Which machine is A on?", "header": "Machine", "options": [
    {"label": "This PC (Recommended)", "description": "A is in C:\\code\\a here"},
    {"label": "mac", "description": "Ask mac/handler to find it there"}]},
  {"question": "Carry on in research.13, which built A's first version?", "header": "Session", "options": [
    {"label": "Continue research.13 (Recommended)", "description": "It remembers how A was built"},
    {"label": "Fresh copy", "description": "A new copy of research with no history"}]}
]}
```

## Without a window

`ask_user_question` is there only in the owner's window. When it is not among your tools, for example on a task from another machine's handler, put the same questions in your reply as a short numbered list, each with its options and your recommendation, and stop there.

## Bots' questions

Only you ask the owner. A bot that needs them messages you: answer it yourself when you can, or else ask the owner as above and answer the bot with `message`.

## After the answers

Say in one line what you will do, then do it. Do not ask again what the owner has answered.
