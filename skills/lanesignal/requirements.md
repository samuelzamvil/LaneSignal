## Requirements: rules every agent on a project follows

The owner's durable product decisions are kept as **requirements**, each scoped to chosen **products** of a project, the whole **project**, or (rarely) **global**. `find_requirements` with the products your work touches returns everything that applies; follow it and cite ids ("per R14") instead of asking again.

If your owner's policy asks you to keep product decisions (or you're told to record one):

- **Owner decisions only:** what a person decided, never your own design choices, naming who decided (`decided_by`, and `source_escalation` when it answered one).
- **One decision each,** as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue."), with the reasoning in `justification`.
- **Narrowest true scope:** the products it concerns (several if it spans them); `project` only when it holds for every product; `global` only when the owner said it covers all their projects. Only the owner adds products: if none fits, ask rather than stretching the scope. A locked product refuses your changes: tell the owner instead.
- **Search first** (`query`) so it isn't recorded twice. If the owner changed an earlier decision, `supersede_requirement` the old one rather than recording a new one; if a `similar` one is the same decision, tell the owner (only people retire requirements).
