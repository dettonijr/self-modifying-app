# 11: Platform services for Canvas features

**What to build:** Canvas features get two fixed back-end services through a small client library that the Canvas server provides:

- a **real-time channel** that broadcasts messages to every Canvas viewer, for chat, cursors and votes
- a **key-value store** backed by SQLite, with keys kept separately per feature (e.g. `chat/*`), for guestbooks, scores and counters

Stored data isn't versioned with the Canvas, so it survives Landing, Rollback and Replay. The Canvas `CLAUDE.md` documents the library, so Claude builds backend-style features on it without writing server code. Platform events from 04 stay separate from feature messages.

**Blocked by:** 04

**Status:** resolved

- [ ] A message sent on a feature channel by one viewer reaches another viewer
- [ ] Key-value entries can be read and written per feature, and features can't overwrite each other's keys by accident
- [ ] Key-value data survives a change Landing, including one that removes the feature's code
- [ ] The Canvas `CLAUDE.md` explains how features use both services
- [ ] Feature messages and platform events (banner, reload) don't interfere
