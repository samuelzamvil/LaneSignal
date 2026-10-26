// The starter policy shown when creating an agent key: the same text as the template in
// docs/agent-instructions.md (a test keeps them in step). The skill covers how; this is when.
export const POLICY_TEMPLATE = `## LaneSignal

You oversee group \`<group-id>\` in LaneSignal. Use the \`lanesignal\` skill for how to publish, ask me and act on my answers.

Project: \`<project-id>\` (pass it as \`project\` on every LaneSignal call; delete this line if the key is bound to one project).

**Publishing**
- Register the group at the start of every session. Lanes are slots: move each between tickets with \`fill_lane\`, parking a blocked ticket (saying why) and pulling in the next.
- Keep the epic's status line current (\`update_epic\`) with what's queued or waiting, instead of placeholder lanes. Ask about direction, scope and which tickets to file on the epic, not on a lane.
- Publish when a lane's situation changes, not on a timer.
- Take a lane off the dashboard (\`remove_lane\`) when you no longer need the slot.
- Notify me (\`notify_owner\`) when a PR merges or you start a new ticket. Nothing else.
- When I write on a lane or an epic's board, act on it; answer with \`notify_owner\` (or \`notify_epic\`) if I asked something or you change course.

**Escalate to me** (I answer in LaneSignal, or here in this session):
- destructive or irreversible changes (data deletion, migrations without a rollback, force pushes)
- product and scope questions that no pending or active requirement answers
- credentials, access and spending
- conflicting instructions

Don't escalate routine progress or choices you can reverse cheaply; escalations page my phone. Raise things I should know but that don't block you as FYI (\`blocking: false\`).

**While you wait:** keep working on lanes that aren't blocked. When I answer in LaneSignal, acknowledge before acting (if I answer Other, act on it or reply in one or two short sentences); when I answer here, dismiss the escalation with what I decided. Either way, publish the lane's next status in the same call.

**Requirements** (optional: keep, change or drop this part):
- Before escalating a product question to me, search the requirements and follow any that answer it.
- When I decide something that sets product direction, record it as a short requirement scoped to the products it concerns, naming me as the decider and citing the escalation.
- Never record your own design choices as requirements.
`;

const PROJECT_LINE = /^Project: .*\n\n/m;

const REQUIREMENTS_PART = /\n\*\*Requirements\*\*[\s\S]*$/;

/** On an alerts-only server (LANESIGNAL_DECISIONS=false) the owner always answers in the session. */
export const ALERTS_ONLY: [string, string][] = [
  ['ask me and act on my answers.', 'alert me and dismiss alerts.'],
  ['(I answer in LaneSignal, or here in this session):', '(I answer you here, in this session):'],
  [
    "**While you wait:** keep working on lanes that aren't blocked. When I answer in LaneSignal, acknowledge before acting (if I answer Other, act on it or reply in one or two short sentences); when I answer here, dismiss the escalation with what I decided. Either way, publish the lane's next status in the same call.",
    "**When I answer:** dismiss the alert, with what I decided as the justification, and publish the lane's next status in the same call.",
  ],
];

/**
 * The template with the group filled in, the project line kept only when the key needs it, the
 * Requirements part only when the server keeps requirements, and alerts-only wording when people
 * don't answer in LaneSignal.
 */
export function policyFor(group: string, project: string | null, requirements = true, decisions = true) {
  let text = POLICY_TEMPLATE.replace('<group-id>', group || '<group-id>');
  if (!decisions) for (const [from, to] of ALERTS_ONLY) text = text.replace(from, to);
  text = project ? text.replace('<project-id>', project) : text.replace(PROJECT_LINE, '');
  return requirements ? text : text.replace(REQUIREMENTS_PART, '\n').replace(' that no pending or active requirement answers', '');
}
