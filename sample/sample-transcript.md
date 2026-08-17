# Weekly Product Sync — 17 August 2026

**Attendees:** Dana Okonkwo (PM), Priya Raman (Eng), Marcus Bell (Design), Sam Whitfield (Support)

---

**Dana:** Morning everyone. Three things today — the Acme renewal, the onboarding redesign, and
whatever came out of the support queue last week. Sam, start us off?

**Sam:** Sure. Ticket volume was down about fifteen percent, but we got six separate reports of the
export button timing out on large accounts. All six were accounts over ten thousand records.

**Priya:** That's the synchronous export path. We knew it would fall over eventually. It needs to
move to a background job.

**Dana:** Is that a this-sprint thing or a next-quarter thing?

**Priya:** Realistically next sprint. It's maybe three days of work, but I'm mid-way through the
auth migration and I don't want to context switch. I'll write up the approach so we can size it
properly at planning.

**Dana:** Works for me. Can you get the write-up done before Friday? Planning is Monday morning and
I'd rather not read it cold.

**Priya:** Yeah, I'll have it in the doc by Friday.

**Dana:** Great. Marcus, onboarding.

**Marcus:** Second round of the flow is done. I cut the plan-selection step entirely — the data was
pretty clear that people were bailing there and it wasn't earning its place. New flow is four
screens instead of six.

**Sam:** Does that change what support sees? Because we've got help docs that walk through the plan
picker screen by screen.

**Marcus:** It does, yeah. Those will be stale the moment this ships.

**Dana:** Sam, can you take the doc updates? No rush on timing, just needs to happen before we ship.

**Sam:** I'll take a look at what's affected and get them updated.

**Dana:** Last thing — Acme. Their renewal is up at the end of the month and they've asked for
updated Q3 pricing before their board meeting. I said we'd get it over to them.

**Priya:** Are we giving them the volume discount we discussed?

**Dana:** That's what I want to confirm. We agreed last week to hold at the current tier rather than
discount further, and I think that's still right given where margins are. So — decision stands, no
additional discount, and I'll send them the sheet with that reflected.

**Marcus:** Do they know that's the answer? Because I think they were expecting movement.

**Dana:** They don't know yet. I'll email their procurement contact directly and lay it out, rather
than let them find it in a spreadsheet. Better they hear the reasoning from me.

**Priya:** Agreed.

**Dana:** Alright. Priya, write-up by Friday. Sam, help docs before ship. I'll handle Acme. See
everyone Monday.
