# Honeybee workspaces and quests

We are currently packing a lot of machinery in the hive cli. The hive CLI is currently getting fairly fleshed out when it comes to agent-to-agent orchestration. 

However, its utility as an agent workspace for myself is starting to show itself. 

In Honeybee, bees are grouped into swarms and colonies. Colonies can be thought of as 'projects'. Swarms are smaller groups of bees working together to solve specific problems. For instance you can quickly instantiate a swarm template (called a 'frame') into a swarm for doing thorough multi-faceted code-review. Swarms can be targeted specifically with an @-marker, e.g. @mySwarmName. You can send messages to all bees in a swarm or all bees in a colony at once.

We have now started to move hive into the area of user UI. We will start creating tools that mesh together agent efficiency with operator efficiency. There are a few things we need to accomplish this. This document introduces two concepts to move the needle in the right direction: Workspaces and Features.
# Workspaces

A **workspace** is a persisted UI tmux workspace that hosts a number of windows and panes. These windows and panes can be bees (linked in) or regular panes. The workspaces are persisted, and when a computer restarts they can instantly be restored.

Every colony automatically gets a workspace created, although you may have non-colony workspaces also.

A workspace is associated with a **file root**, a location somewhere on the local computer. Colony workspaces are prompted to yield their file root the first time they are opened. 

A workspace differs from a regular tmux session by its persistence, as well as its deep integration into the honeybee ecosystem.

Workspaces provide an alternative to software like 'cmux'.

# Quests

'Quests' is our answer to a abstraction we feel is missing from a lot of modern development surfaces. 

A **quest** is a tracked task that has a beginning and a completion. A feature will have its own workspace available while it is active. A **quest** typically lives inside a colony. Very often one or more swarms are created inside a quest to solve the quest.

A quest is the answer to **we need somewhere to track and solve this task / issue we have**. Quests may be natively linked to a Linear task.

When the underlying task or issue is resolved, we may mark the quest as finished. This cleans up all the associated bees, workspace, and archives all the sessions.

## Integrations with swarms

Quests and swarms play nicely together. When a quest is created, you may immediately spawn a swarm and/or a flow to start working on the quest. There needs to be some smooth user-facing UX to quickly instruct the swarm or flow what to do. 

If created from a Linear task, you may by default instruct the flow or swarm to simply read the task.




























































































