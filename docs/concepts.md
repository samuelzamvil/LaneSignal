# Lanes, groups, tickets, epics and escalations

## Groups: one overseer, many lanes

An overseer agent session runs several lanes for a body of tickets, an epic or a train, and the group is named after it. Overseer, epic/train and group are the same thing. The app calls it a **Group**; `LANESIGNAL_GROUP_LABEL` changes that (e.g. to `Train`).

A group has:

- a name
- its [epics](#epics), which carry the epic/train ticket (a group's own `ticket` from before epics is kept, read-only)
- links, most usefully the overseer's Remote Control session, so a decision is one tap from the conversation that owns it

The overseer registers its group with `update_group` before publishing lanes in it. Every lane is in a group: a lane published without one joins the project's **Ungrouped** group. The lane list is arranged by group by default, and groups that need you sort first. Each group has at least one [epic](#epics), whose card heads the group's lanes.

## Lanes

A lane is a slot work goes through, one ticket at a time, with a stable id the agent picks (`slot-1`, or a work stream such as `e2e-stabilize`). It carries:

- **status:**

  | Status | Meaning |
  |---|---|
  | `active` | working |
  | `pending_ci` | waiting on CI |
  | `awaiting_agent` | waiting on another agent or lane |
  | `blocked_human` | needs a human decision |
  | `idle` | nothing to do right now |
  | `completed` | done |

- **group:** which epic/train it belongs to
- **ticket:** the [ticket](#tickets) it holds, or none. **A lane holding no ticket shows `idle`**, whatever status its agent publishes (the agent gets a warning): work is shown on tickets, and an empty slot is common while work is blocked or can't run in parallel
- **activity:** one line, readable on a phone
- **links:** PRs, CI runs, sessions. URLs must be http(s)

LaneSignal tracks when each lane last published, how long it has been in its current status, and total **time blocked**. A lane that is `active`, `pending_ci` or `awaiting_agent` and goes quiet for `LANESIGNAL_STALE_MINUTES` is flagged *stale*.

Its history keeps every status change and escalation step. Routine activity text is capped at the last `LANESIGNAL_EVENT_RETENTION` entries.

Tapping a lane opens its page: its details, then **Escalations**, **Conversation** and **Recent activity**. Tap a heading to fold that part away. Folded or open is remembered on the device, for every lane. Escalations show the **Active** ones (open, or answered and not yet picked up by the agent) unless you pick **Historical** (acknowledged or dismissed) or **All**; that choice is remembered too. While Conversation is folded, the agent's new messages aren't marked as read.

**Removing** a lane or group from the dashboard archives it rather than deleting it, so its escalations and history stay available for [export](export.md). People remove lanes in the app; overseers remove theirs with `remove_lane` when they no longer need the slot. A removed lane's ticket is parked (or done, if the lane was completed), and keeps its questions. Questions raised while it held no ticket stay with the group's epic.

## Tickets

A ticket is what a lane works on. It owns its escalations and its status history, and moves between lanes, so a lane can set one aside for a while:

1. Lane A works ticket 500 and hits a blocker. 500's question, **500A**, is waiting on you.
2. The overseer parks 500 ("waiting on the vendor API key") and fills lane A with bug fix 501, in one call (`fill_lane`). 500A stays in your inbox, but no longer holds lane A blocked.
3. 501 is done. The overseer fills lane A with 500 again: it comes back with 500A and its history, blocked if 500A is still open, or waiting on the agent if you've answered it meanwhile.

The rules:

- **One record per ticket:** `967`, `#967`, `redmine:967` and the Redmine URL are the same ticket (refs are put into one form, using the default ticket system). A ticket is created the first time a lane is filled with it.
- **One lane at a time:** filling a lane with a ticket another lane holds is refused. A worker and a reviewer on one ticket share a lane. Any lane can take a parked ticket, and filling a lane with a done or dropped one reopens it.
- **Questions keep their lane:** an escalation stays recorded on the lane it was raised in (for history and export), and counts, blocks and is waited on where its ticket is now.
- **Letting go:** a lane lets its ticket go as **parked** (to pick up again, with a reason), **done**, or **dropped** (unfinished). Whatever happens to a ticket, its open questions stay open and in your inbox, answered as ever; they block only the lane holding it. A lane published as `completed` marks its ticket done and empties (`idle`), ready for the next.
- **Not a tracker:** a ticket's state here only says whether a lane holds it and how the last one let it go. Its real status lives in Redmine, GitHub or wherever it's tracked; LaneSignal never syncs it.
- **Blocked time** belongs to the ticket: a lane's blocked total is its current ticket's.
- **Waiting on another ticket:** a lane can say its ticket waits on another ("waiting on 945"); that clears itself once 945 is done.
- **PRs aren't tickets:** they go in the lane's links. Switching a lane from a Redmine ticket to a `gh:` ref gets a warning.
- **Who may close its questions:** the agent that raised them, a person, or the overseer of the group the ticket is in now (the key that last published it with `update_group`), so a ticket handed to another overseer goes with its questions.
- **Naming its epic:** `fill_lane` takes `epic`, the [epic](#epics) the ticket is for (one of the lane's group's open epics); the lane is then listed under that epic's card.

**In the app:**

- **Parked tickets:** under each group on the Lanes page, a **Parked** row (folded by default) lists the group's parked tickets with why, how many questions are open on each, and the lane each left.
- **A ticket's sheet** opens from a lane's ticket, a parked ticket, or the ticket on a question. It shows where the ticket is, its questions, its history across lanes, and the lanes it passed through.
- **A lane's sheet** marks each switch in its activity: "Parked 500: waiting on the vendor API key · filled with 501". Questions on it name their ticket, so one parked with an earlier ticket reads "500 · parked".

Agents that don't know about tickets still work: publishing a lane with a different ticket parks the old one ("switched (legacy call)"). Otherwise their publishes follow the same rules as `fill_lane`: a ticket another lane holds is refused, and a done one reopens.

### Escalation codes and lane letters

An escalation's code is its ticket's or epic's code and a letter: **967A**, **967B** … **967Z**, **967AA**.

- A ticket's code is its ref. Tickets from a system other than the default keep its name (**gh:632A**); a ticket whose ref can't make a code (a plain URL) uses its number instead (**T42A**).
- An epic's code is its ticket's ref (**680A**). A group standing in as its epic uses its id (**paymentsA**), or for a group from before epics, the ticket it had.
- A ref that's both an epic and a ticket (an epic worked directly, e.g. an audit) shares one letter sequence, so codes stay unique.
- A code doesn't change when its ticket moves to another lane, or when a group's questions move to its first real epic.
- Codes are per [project](projects.md); where projects mix, they carry the project key (**SH·967A**). Matching ignores case.
- Codes from before tickets (**A12**, the lane's letter and a number) keep working, in every tool and in search.

Each active lane also gets a letter, shown on its card: A, B, … Z, then AA, AB. It's only a label: codes no longer use it. A lane keeps its letter while it's active; once it's removed and nothing it raised is pending, the letter goes back to the pool, and the next new lane takes the smallest free one.

## Epics

An epic is a long-lived ticket a group steers its work by: the direction, scope and next tickets, rather than code worked in a lane. It has a card on the Lanes page, its own questions and a message board.

- **Every group has an epic.** Until it has one of its own, the group stands in as its epic (the *stand-in*): named after the group, and named by the group's id in agents' tools.
- **Real epics** are named by their ticket's ref (`680`, `redmine:680`, its URL: one epic). A group can have several. The overseer adds one with `update_epic` (a ref no epic has yet, plus the group). The first one retires the stand-in: its questions, board and status line move to the new epic, keeping their codes. Closing the group's last real epic brings the stand-in back.
- **Tickets name their epic** when a lane is filled with them (`fill_lane` with `epic`). It's optional.
- **On the Lanes page each lane is listed once:** under its ticket's epic's card, or, when its ticket names no epic or it holds none, under the group (the stand-in's card when the group has no epic of its own).
- **Status line:** one line the overseer sets on the card (`update_epic`), e.g. "3 of 5 lanes busy; next up #966". Use it instead of placeholder lanes.
- **Questions:** the overseer raises the durable ones on the epic: direction, scope, which tickets to file (`create_escalation` with `epic`). Questions from a lane holding no ticket go to the group's epic too. They're in your inbox like any other and can block, but block no lane: a blocking one shows **Waiting on you** on the card and counts in "Needs you".
- **Message board:** the conversation that steers the epic, with the same rules as a [lane's conversation](#lane-conversations): the overseer posts with `notify_epic` (at most 500 characters, files allowed, one post per epic per minute, a quiet push that opens the epic); you write back from the epic's sheet (2,000 characters), and your note reaches the group's overseer on its next wait on the group. The card shows 💬 while there's a post you haven't read.
- **Closing:** the overseer asks with `request_epic_close` and a reason; the card and sheet show **Close requested**, and a signed-in person approves or declines (a personal key can't). A close is refused while the epic has open questions, or answered ones its agent hasn't acknowledged, so a live decision is never withdrawn. A closed epic's board is read-only, and tickets that name it keep the link. A group's stand-in isn't closed: it steps aside when a real epic is added.
- **Requirements** stay separate from epics.

**In the app:**

- **Epic cards** head each group on the Lanes page, in place of the group header: the epic's name and ticket, the overseer's session, its status line, how many need you (its lanes' and its own blocking questions), **Waiting on you** when one of its own questions blocks, 💬 for a board post you haven't read, and **Close requested** with **Approve** and **Decline**. A card shows even with no lanes under it when it has something to say (a status line, questions, board posts or a close request), and always for a real epic. Lanes whose ticket names none of the group's epics are listed after the cards, under the group's name.
- **An epic's sheet** opens from its card, or from the epic on a question. It shows the epic's questions, its board with a box to write to the overseer, and its lanes with their combined feed: status changes, activity and ticket switches across them, latest first.

## Escalations

An escalation is a question for humans. Every escalation belongs to one ticket or one epic:

- raised on a lane holding a ticket: that ticket
- raised on a lane holding none: the group's epic (the agent says which when the group has several)
- raised on an epic directly: that epic

It stays recorded on the lane it was raised in, if any, for history and export. Only `question` is required. The rest follows a loose structure:

| Field | Meaning |
|---|---|
| `ref` | Set by the server: a [code](#escalation-codes-and-lane-letters) like **967A** (its ticket's or epic's code and a letter) that people and agents can use to refer to the escalation. Every tool and endpoint accepts it in place of the id |
| `context` | What you need to know to decide; the inbox card shows its first lines |
| `question` | The decision being asked for. It's also the headline |
| `recommendation` | What the agent would do and why |
| `cost` | What following the recommendation costs: dependencies, time, risk |
| `alternatives` | Other paths considered, one per entry, each with its tradeoff |
| `ticket` | What the question is about, such as the plan `gh:921`, when it differs from the lane's ticket |
| `acceptMeans` | One line: what the agent does if you answer **Accept** |
| `rejectMeans` | One line: what it does if you answer **Reject** |
| `allowReject` | `false` hides **Reject**, for questions where it makes no sense. Default `true` |
| `turn`, `messageCount`, `lastMessage` | Whose move it is in the conversation (`owner` or `agent`), and its size and latest message. Fetching one escalation adds `messages` |
| `attachments` | Files to read or look at: Markdown or text (rendered in the app) and PNG, JPEG, WebP or GIF images (thumbnails, and a full view you can zoom). See [Attachments](#attachments) |
| `options`, `recommendedOption` | Older escalations: short answers shown as buttons. New ones use Accept / Reject / Other |
| `positions` | Other agents' views on the recommendation: `{agent, stance: agree / disagree / neutral, note}`, one per agent |
| `links` | Anything else worth opening |

### Answering

With answering in the app on (the default), each open escalation has three buttons, on its inbox card and in its detail view:

- **Accept** and **Reject** (when the agent offers it), with what each means underneath.
- **Other**, for anything else.

A tap asks you to confirm, with a box for instructions to the agent: optional for Accept and Reject, required for Other.

- **Accept** or **Reject** decides the escalation. The agent gets the decision and your instructions as `decisionNote`.
- **Other opens a conversation** inside the escalation. Your instructions go to the agent, and it's the agent's turn: the lane shows it working (`awaiting_agent`) and the card moves to *Agent's turn* in the inbox. The agent either acts on them (acknowledging closes the escalation with decision `Other` and your message as the note) or replies. It can still act on your instructions after replying: acknowledging then takes your latest messages. A reply notifies your phone and hands the turn back to you; the button reads **Reply** from then on.
- The detail view shows the question, its attachments, then the messages, with the buttons under the latest one, so you can Accept or Reject at any point of the conversation.
- Agent messages are short by design: at most 500 characters (yours, 2,000). Anything longer comes as an attachment, which messages can carry too. While you decide, an agent may post a one-line update when something changes; every agent message notifies your phone.
- Conversations are kept with the escalation and exported in `messages.csv`.

### Lane conversations

Each lane has a conversation of its own, outside any escalation, in the lane's sheet:

- **The agent's milestones** ("Merged PR #311", "Starting gh:42") arrive with `notify_owner`, optionally with files (a screenshot, release notes). Each sends a quiet push that opens the lane, and the lane's card shows **💬 new message** (a 💬 in the list view) until you open it on that device with its Conversation showing (a device counts from the first time it opens the app, so older messages aren't marked).
- **You can write back** from the sheet (with answering in LaneSignal on). Nothing blocks and the lane's status doesn't change: the agent gets your note the next time it publishes the lane, writes on it or waits on it, and the note then reads *seen by the agent*. Each note goes to one agent, whichever reports in first: an overseer waiting on its whole group picks up notes on all its lanes.
- Use an escalation instead when the agent needs a decision from you.
- Agent messages are at most 500 characters (yours, 2,000), one per lane per minute. Conversations stay with the lane and are exported in `lane_messages.csv`.

### Attachments

Agents attach files they want you to read or see, such as a plan or a UI preview: Markdown and text files, and PNG, JPEG, WebP or GIF images. They upload each with the `upload_attachment` tool (or `POST /api/attachments`) and list the ids when raising the escalation, writing in its conversation, or sending a milestone on a lane (`notify_owner`).

- The app renders Markdown itself (headings, lists, tables, code); HTML in a file is shown as text, and links only open web and mail addresses. Images get a thumbnail, and a full view you can pinch, drag and double-tap to zoom.
- The server recognises the type from the content, so a script renamed `plan.png` is refused. SVG, HTML and other types are refused.
- Images bigger than 50 megapixels are refused, so phones can show them.
- Limits: 5 MB per file and 5 files per escalation or message (`LANESIGNAL_ATTACHMENT_MAX_MB`, `LANESIGNAL_ATTACHMENTS_PER_ITEM`). An upload nothing references within a day is deleted.
- Only people and agents who can see the escalation's (or the lane's) project can open its files. Exports list the files' names, types and sizes, not the files.

### Inbox and History

- **Needs you** lists open questions: blocking ones waiting on you first, then *Agent's turn* (you answered Other and the agent is replying), FYIs, and decisions the agent hasn't picked up yet. Each shows its code and the ticket or epic it belongs to: a card shows 🎫 967 (dimmed with "parked" or "done" when no lane holds the ticket) or ◆ and the epic's name, and tapping it opens the ticket or epic; a list row names it (967, "967 (parked)", or ◆ and the epic). History items name them the same way. **Cards** shows each with its answer buttons; **List** shows one line each (code, question, lane, status). The choice is remembered on the device. **Lanes** has the same Cards / List switch: the list shows each lane's letter, name, activity, status and last update on one line.
- **Active tickets only**, on Needs you and History, hides questions whose ticket no lane holds (parked, done or dropped). It's off by default and remembered on the device; the "Needs you" count still includes them.
- **Needs you follows the Lanes filters.** With a group or status picked on Lanes, Needs you lists only questions (and blocked lanes) from lanes that match; a question on an epic shows while no status is picked and a picked group (if any) is the epic's. A note says how many blocking questions and blocked lanes the filters hide, with **Show all** to clear them. When Lanes isn't beside Needs you (on a phone or tablet, or next to Settings or Requirements), the same group and status chips show at the top of Needs you. The count, badge and banner still include hidden questions.
- **History** lists closed escalations, latest first, with how each ended (Accept, Reject, Other with the instructions, or Dismissed with the reason). Search covers the question, context, answers and conversations, a code like `967A` or `A12`, and a ticket in any form (`967`, `#967`, `redmine:967`, its URL); filter by outcome and group. Opening one shows the whole escalation and its conversation. The same list is `GET /api/history`.
- On a wide screen (1024 px and up), the list stays on the left and the open escalation or lane fills the right, so you can work down the list without closing anything.

### Many questions per lane

A lane can have any number of open escalations. A plan with four questions raises four escalations:

- The inbox lists them together, in order, as "Question 1 of 4 from this lane".
- The detail view has **Previous** and **Next** for stepping through them.

### Lifecycle (default: answer in the app)

By default you answer on the dashboard or the phone app, and the agent waits for the answer:

```
open ──(human decides)──► decided ──(agent acknowledges)──► acknowledged
  └──────(dismissed: answered in the session / moot)──────► dismissed
```

1. The agent raises the escalation. Your phone is notified, and the lane shows as blocked.
2. You answer with one tap (or a note). Decided ones stay under *Decided · awaiting agent* until the agent acknowledges; one that waits longer than `LANESIGNAL_STALE_MINUTES` is flagged.
3. The agent acknowledges before acting, and the acknowledgement returns the final answer. It usually publishes its next status in the same call.

- If two humans answer at once, the second gets `409 Conflict`. **Change decision** replaces the answer until the agent acknowledges, e.g. after a mis-tap.
- Only the agent that raised an escalation (any key of the same account with the same key name) acknowledges or dismisses it, so an overseer can't close another's by reusing a code. A person can on its behalf, and so can the overseer of the group its ticket (or epic) is in now (the key that last published it with `update_group`), so a ticket handed over goes with its questions.
- You can still answer in the agent's own session (e.g. Remote Control), quoting the code ("A12: drop it"). The agent then dismisses the escalation with a justification ("Sam: drop it, in session"), which is the record on the dashboard and in exports. **Dismiss** on the dashboard closes a stale one whose session ended; the lane then shows as waiting on its agent (`awaiting_agent`) until the agent publishes again.
- When a lane's last open blocking escalation is decided, the lane moves to `awaiting_agent`, which stops the blocked timer while the agent picks up the answer.
- While an agent waits for answers on a lane, the lane shows **agent waiting**. Waiting lanes aren't flagged stale. The flag clears about 30 seconds after the agent stops waiting.
- Raising the same question again on the same ticket or epic while it's still open (ignoring spacing and case) returns the existing escalation, so agent retries don't create duplicates.
- A lane stays **blocked** while any of its ticket's blocking escalations is open, whatever status its agent publishes. A parked ticket's questions don't block the lane that parked it, and an epic's questions block no lane.

### Alerts only (optional)

With `LANESIGNAL_DECISIONS=false`, LaneSignal only **alerts**:

```
open ──(the agent dismisses it, saying what was decided)──► dismissed
```

You answer in the agent's own session, so the conversation and the decision stay in one place (the card links to the session when the overseer published it), and the agent dismisses the alert with a justification. The dashboard has no answer buttons, only **Dismiss** for a stale alert, and agents have no waiting or acknowledging tools. Dismissing the last blocking alert puts the lane back to `active`, unless the agent says otherwise.

### Blocking

- An escalation is **blocking** by default: creating it sets the lane holding its ticket to `blocked_human`. An epic's blocking question shows **Waiting on you** on the epic's card instead.
- `blocking: false` marks an FYI that never holds the lane blocked. FYIs are listed separately in the inbox, aren't counted in the "Needs you" badge, don't make a lane look urgent, and notify quietly.
- Nothing else changes a lane the agent set to `blocked_human` itself. The agent publishes what it does next.

## Ticket links

References become links through URL templates (`LANESIGNAL_TICKET_TEMPLATES`):

| Reference | Becomes |
|---|---|
| `redmine:1234` | That system's template with `{id}=1234` |
| `#1234` or `1234` | The default system's template |
| `https://…` | Used as-is |

Refs written in free text link too: messages, escalation questions and their fields (context, recommendation, cost, alternatives, what Accept/Reject means, positions), decision notes and resolutions, a lane's activity on its detail page, requirements and their justifications, and attached Markdown plans.

| Written | Links to |
|---|---|
| `#1234` | The default system's ticket 1234 |
| `redmine#1234` or `redmine:1234` | That system's ticket (the system name may be in any case; ids like `PROJ-12` work) |

Plain text, so ordinary writing doesn't turn into links:

- a system name that isn't configured (`foo#12`, `note:5`);
- a `#` stuck to a word or path (`PR#5`, `a/#5`);
- `#` with letters or a single digit (`#fff`, "our #1 priority"), a leading zero (`#000`) or a decimal (`#12.5`). Write `redmine#5` for a one-digit ticket.

With no templates configured, only web addresses link. Lane cards and rows show activity as plain text.

LaneSignal links to tickets but never syncs or edits them.

## Notifications

By default, push notifications go out when an escalation is **created**: urgent for blocking questions (regular, if an instance admin turned on [quiet alerts](android.md#quiet-alerts)), quiet for FYIs. The title carries its code (`Needs you A12 · …`). An FYI the agent raises again as blocking notifies like a new question. Overseers can also send a **notice** about a milestone ("Merged PR #311", "Starting gh:42") with `notify_owner`: quiet, at most one per lane per minute, kept in the [lane's conversation](#lane-conversations), and tapping it opens the lane. Agreements, decisions and routine lane updates never page anyone. Add `blocked` or `completed` to `LANESIGNAL_NOTIFY_ON` to also be told when a lane becomes blocked without an escalation, or when it completes. See [Android and push](android.md).
