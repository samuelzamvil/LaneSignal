## Requirements

The owner's durable product decisions are kept as requirements, scoped to products, the whole project, or every project. Only people retire requirements.

<!-- usage -->
### Usage: requirements

- **Before escalating a product or scope question,** `find_requirements` with the products your work touches. If a requirement answers it, follow it and cite its id ("per R14") instead of asking again; a `pending` one too.

If your owner's policy asks you to record decisions (or you're told to):

- **Only what a person decided,** never your own design choices, naming who decided. One decision each, as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue.").
- **Search first** (`query`), so it isn't recorded twice. If the owner changed an earlier decision, `supersede_requirement` the old one; if a `similar` one is the same decision, tell the owner.
- **Narrowest true scope:** the products it concerns; `project` only when it holds for every product; `global` only when the owner said it covers all their projects. If no product fits, ask the owner rather than stretching the scope.
<!-- /usage -->
