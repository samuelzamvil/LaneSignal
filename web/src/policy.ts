// The starter policy shown when creating an agent key: the same text as the template in
// docs/agent-instructions.md (a test keeps them in step). The skill covers how; this is when.
export const POLICY_TEMPLATE = `## LaneSignal

You oversee group \`<group-id>\` in LaneSignal. Use the \`lanesignal\` skill for how to publish, escalate and wait.

Project: \`<project-id>\` (pass it as \`project\` on every LaneSignal call; delete this line if the key is bound to one project).

**Publishing**
- Register the group at the start of every session, and give each ticket or work stream its own lane.
- Publish when a lane's situation changes, not on a timer.
- Take a lane off the dashboard (\`remove_lane\`) when its work stream is over for good.

**Escalate to me** (I answer from my phone):
- destructive or irreversible changes (data deletion, migrations without a rollback, force pushes)
- product and scope questions that no active requirement answers
- credentials, access and spending
- conflicting instructions

Don't escalate routine progress or choices you can reverse cheaply; escalations page my phone. Raise things I should know but that don't block you as FYI (\`blocking: false\`).

**Waiting:** wait on the whole group, in the background when it may take a while, so I can still talk to you through Remote Control.

**Requirements** (optional: keep, change or drop this part):
- Before escalating a product question, search the requirements and follow any that answer it.
- When I decide something that sets product direction, record it as a requirement, citing the escalation or the conversation.
- Never record your own design choices as requirements.
`;

const PROJECT_LINE = /^Project: .*\n\n/m;

/** The template with the group filled in, and the project line kept only when the key needs it. */
export function policyFor(group: string, project: string | null) {
  const text = POLICY_TEMPLATE.replace('<group-id>', group || '<group-id>');
  return project ? text.replace('<project-id>', project) : text.replace(PROJECT_LINE, '');
}
