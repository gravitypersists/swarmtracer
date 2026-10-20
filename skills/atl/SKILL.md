---
name: atl
description: Annotate this run's live timeline in SwarmTracer with decisions, handoff notes, deliverables, and blockers, one `atl` shell call each. Use when you choose between real alternatives, hand work to or back from a subagent, produce a file others will use, or are blocked, whenever the `atl` command is on PATH.
allowed-tools: Bash(atl:*)
---

# Annotating the timeline with `atl`

SwarmTracer already records when you generate, run tools, and spawn or wait on subagents. It can't see *why*. `atl` adds that, at the moment it happens, on your own lane.

## When

| Moment | Command |
| --- | --- |
| You chose between real alternatives | `atl decision "use the meta file for linking" --why "it links children at start, the tool result only at the end"` |
| You hand off to or back from a subagent and the reason isn't obvious from the prompt | `atl note "splitting review by directory so the two agents never read the same file"` |
| You produced a file someone else will use | `atl artifact ./report.md "final review report"` |
| You can't continue without something | `atl blocked "need the staging API key from the user"` |

## When not

- Don't narrate progress ("reading files now", "running tests"). The timeline already shows that.
- Don't restate a tool call or its result.
- Most tasks need 0–3 annotations. One sentence each.

## How

- Run `atl` as its own Bash command: not chained with `&&` or `;`, and without a `command -v` check first. A `Bash(atl:*)` permission rule then covers it, so it never stops for approval.
- Write the text literally in the command, not through a shell variable. SwarmTracer matches the command to tell which agent you are.
- If `atl` reports that SwarmTracer isn't reachable, carry on. Don't retry, and don't mention it.
