## Requirements

The owner's durable product decisions are kept as requirements, scoped to products, the whole project, or every project. Only people retire requirements.

<!-- usage -->
### Usage: requirements

- **Read them once:** `find_requirements` with the narrowest products your work touches (`project_only` if none), at session start and after a compaction or restart. When work reaches a product you haven't read, read only that one with `only_named`, naming its parent too if you haven't read that. Otherwise read again only when you're told a requirement changed, or to search before recording one.
- **Workers read requirements only:** a subagent may call `find_requirements` for its work, and nothing else in LaneSignal.
- **Before escalating a product or scope question,** check what you've read. If a requirement answers it, follow it and cite its id ("per R14") instead of asking again; a `pending` one too.

If your owner's policy asks you to record decisions (or you're told to):

- **Only what a person decided,** never your own design choices, naming who decided. One decision each, as one normative statement ("Payout jobs retry at most 5 times, then go to the dead-letter queue.").
- **Search first** (`query`), so it isn't recorded twice. If the owner changed an earlier decision, `supersede_requirement` the old one; if a `similar` one is the same decision, tell the owner.
- **Narrowest true scope:** the products it concerns (a rule for all of a product's subprojects goes on the product); `project` only when it holds for every product; `global` only when the owner said it covers all their projects. If no product fits, ask the owner rather than stretching the scope.
<!-- /usage -->
