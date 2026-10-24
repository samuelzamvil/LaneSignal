# TRMNL screen

A [TRMNL](https://trmnl.com) e-ink display can act as a notifications channel for a project. Each project gets its own screen:

- **Left, the card:** the latest notification. For an escalation that's the same as its inbox card: code, lane, question, the first lines of context, the agent's latest message, the recommendation, and what **Accept** and **Reject** would do. There are no buttons on e-ink, so you answer in the app.
- **Right, the list:** the project's other pending escalations, condensed to code, question, lane and age, in inbox order. A new notification never pushes the others off the screen.
- **Bottom:** the project's name and when LaneSignal last sent data, as a day and time in your TRMNL account's time zone. LaneSignal sends at least once an hour, so a time more than an hour old means it has stopped. Ages on the screen ("25m ago") are as of that time: TRMNL only redraws when new data arrives.

Once the card's escalation is answered, the card moves to the newest escalation still open, or says **All clear** when there are none. A lane update (when they're on, see below) keeps the card for up to a day, until something newer arrives.

## How it works

LaneSignal **pushes** to TRMNL; TRMNL never connects to LaneSignal. That keeps a private-network-only server private. The server only needs outbound HTTPS to `trmnl.com`.

- Each project's screen is a TRMNL **private plugin** with the *Webhook* strategy. LaneSignal sends the screen's data to the plugin's webhook URL, and TRMNL draws it with the plugin's layout.
- LaneSignal pushes when something on the screen changes. A burst of changes becomes one push, and nothing is sent when the data hasn't changed. With nothing changing, it pushes once an hour so the "updated" time stays current.
- TRMNL accepts 12 pushes per plugin per hour (30 with TRMNL+), so LaneSignal pushes at most once every 5 minutes per project.
- TRMNL redraws as soon as a push arrives if the plugin hasn't redrawn in the last 15 minutes; otherwise on its next scheduled refresh. Expect a new card within about 15 minutes, or 5 minutes with TRMNL+. Your phone stays the urgent channel.
- A push is at most 5 KB (TRMNL's limit). When there are too many questions to fit, the list shows "+N more in LaneSignal".

## What you need

- A TRMNL with **Developer Edition**, or a **BYOD license** (it includes Developer Edition). Private plugins and webhooks need one of them.
- A LaneSignal account that is an **admin of the project** (Settings → Projects shows *admin* next to it).
- Outbound HTTPS from the LaneSignal server to `trmnl.com`.

The layout is designed for the TRMNL OG (800×480, black and white). TRMNL's framework adapts it to other screens.

## Set it up

Do this once per project.

1. **Download the plugin.** In LaneSignal's web app, open **Settings → Projects**, open the project's **Members and settings**, and find **TRMNL screen**. Click the `lanesignal-trmnl-<project>.zip` button. The plugin is named after the project, e.g. *LaneSignal · Shop app*. (The Android app can't download files: use the web app for this step.)
2. **Import it into TRMNL.** In TRMNL, open **Plugins → Private Plugin → Import new** and choose the zip. TRMNL creates the plugin, set to the Webhook strategy, and adds it to your playlist.
3. **Copy the webhook URL.** Open the new plugin's settings in TRMNL and copy its **Webhook URL** (`https://trmnl.com/api/custom_plugins/<id>`).
4. **Paste it into LaneSignal.** Back in **TRMNL screen**, paste the URL, leave **Push to TRMNL** ticked and click **Save**.
5. **Check it.** Click **Send now**. LaneSignal pushes the current state and shows TRMNL's answer. In TRMNL, **Force Refresh** on the plugin's page draws it straight away; otherwise it shows up on the device's next refresh.

To show several projects, set each one up and keep all their plugins in your TRMNL playlist.

## Settings

| Setting | What it does |
|---|---|
| **Webhook URL** | Where pushes go. Treat it like a password: anyone who has it can write to your screen. After saving it's shown with the plugin id hidden; paste a new one to replace it |
| **Push to TRMNL** | Untick to pause pushes without losing the URL |
| **Lane updates on the card too** | Off (the default): only escalations take the card (new questions, and agent replies in a conversation). On: lane milestones from overseers, completed lanes, and lanes blocked without an escalation take it too |

Below the settings, LaneSignal shows when it last pushed and the last problem, if any. **Remove** deletes the setup; delete the plugin in TRMNL too.

## What leaves your server

Each push sends the project's name, and for each pending escalation its code, question, lane name and age. The card adds the lane's group, the escalation's context, latest message, recommendation, and Accept and Reject lines, or a lane update's text. Everything is cut down to fit the screen. TRMNL keeps the latest push for each plugin, not a history ([TRMNL's architecture](https://docs.trmnl.com/go/how-it-works)).

## Self-hosted TRMNL servers

LaneSignal only pushes to `trmnl.com` (and `usetrmnl.com`) over HTTPS unless told otherwise, so a project admin can't point it at another machine. If you run your own TRMNL server ([BYOS](https://docs.trmnl.com/go/diy/byos), e.g. Terminus) that accepts private-plugin webhooks, add its host name to `LANESIGNAL_TRMNL_HOSTS` (comma-separated, without a port; an IPv6 address in brackets, e.g. `[fd00::1]`). Plain `http://` and any port work for those hosts. For TRMNL's own servers, the URL must be a plugin's webhook URL (`https://trmnl.com/api/custom_plugins/<id>`). LaneSignal doesn't follow redirects.

## Troubleshooting

| What you see | What to do |
|---|---|
| A refused push (403, 404, 422) | LaneSignal doesn't resend the same data until it changes or you fix the setup. **Send now** tries again at once |
| *TRMNL answered 403* | The account needs Developer Edition or a BYOD license, or the plugin isn't set to the Webhook strategy |
| *TRMNL answered 404* | The plugin was deleted or the URL is wrong. Copy the Webhook URL again |
| *TRMNL answered 422* | TRMNL refused the data. The message says why; [open an issue](https://github.com/samuelzamvil/LaneSignal/issues) with it |
| *TRMNL says too many pushes (429)* | Usually after a few **Send now** clicks. LaneSignal tries again by itself |
| *Couldn't reach TRMNL* | The server has no outbound HTTPS to `trmnl.com`. Check its firewall or proxy; LaneSignal keeps retrying |
| *Updated* on the screen is more than an hour old | LaneSignal stopped pushing: check the server is running, and the last problem in the settings |
| *That isn't a plugin's webhook URL* | Copy the **Webhook URL** from the plugin's settings in TRMNL, not the address of the page you're on |
| The screen is blank in TRMNL's preview | Click **Send now** in LaneSignal, then **Force Refresh** in TRMNL |

## Changing the layout

The plugin's files are in [`integrations/trmnl/`](../integrations/trmnl/) in the repository: `settings.yml`, `shared.liquid` (the styles, and a helper for "12m ago") and `full.liquid` (the screen), in TRMNL's Liquid. The styles are the app's inbox card and list rows (`web/src/styles.css`), redrawn in black and white for e-ink. You can also edit the markup in TRMNL's plugin editor; the data LaneSignal sends is visible there under *Your Variables*, and from the API at `GET /api/projects/<id>/trmnl/preview`.
