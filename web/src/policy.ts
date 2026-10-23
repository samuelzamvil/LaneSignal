// The starter policy shown when creating an agent key: the same text as the template in
// docs/agent-instructions.md (a test keeps them in step). The skill covers how; this is when.
export const POLICY_TEMPLATE = `## LaneSignal

You oversee group \`<group-id>\` in LaneSignal. Use the \`lanesignal\` skill for how to publish, alert me and dismiss alerts.

Project: \`<project-id>\` (pass it as \`project\` on every LaneSignal call; delete this line if the key is bound to one project).

**Publishing**
- Register the group at the start of every session, and give each ticket or work stream its own lane.
- Publish when a lane's situation changes, not on a timer.
- Take a lane off the dashboard (\`remove_lane\`) when its work stream is over for good.

**Alert me** (I answer you here, in this session):
- destructive or irreversible changes (data deletion, migrations without a rollback, force pushes)
- product and scope questions that no active requirement answers
- credentials, access and spending
- conflicting instructions

Don't alert me for routine progress or choices you can reverse cheaply; alerts page my phone. Raise things I should know but that don't block you as FYI (\`blocking: false\`).

**When I answer:** dismiss the alert, with what I decided as the justification, and publish the lane's next status in the same call.

**Requirements** (optional: keep, change or drop this part):
- Before alerting me about a product question, search the requirements and follow any that answer it.
- When I decide something that sets product direction, record it as a short requirement, naming me as the decider and citing the alert.
- Never record your own design choices as requirements.
`;

const PROJECT_LINE = /^Project: .*\n\n/m;

const REQUIREMENTS_PART = /\n\*\*Requirements\*\*[\s\S]*$/;

/**
 * The template with the group filled in, the project line kept only when the key needs it, and the
 * Requirements part only when the server keeps requirements.
 */
export function policyFor(group: string, project: string | null, requirements = true) {
  let text = POLICY_TEMPLATE.replace('<group-id>', group || '<group-id>');
  text = project ? text.replace('<project-id>', project) : text.replace(PROJECT_LINE, '');
  return requirements ? text : text.replace(REQUIREMENTS_PART, '\n').replace(' that no active requirement answers', '');
}
