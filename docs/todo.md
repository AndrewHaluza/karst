- create ticket flow; (we should follow general idea to have specific tools and scripts for repetitive non AI parts of our flow; no tokens burn for operational tasks)
   - when new ticket is added we should show user some page\modal to set ticket number, then it will be fetched info from ticket-board (will start with clickup, then will extend with other platforms - jira, trello, etc) 
    krast.yml or in app config(maybe better to use DB?)
    examples:
    **Use the ClickUp REST API directly via curl** 
    First, resolve credentials once and store them:

    ```bash
    TOKEN=$(python3 -c "import json; d=json.load(open('/home/user/.claude.json')); print(d['mcpServers']['clickup']['env']['CLICKUP_API_TOKEN'])")
    WORKSPACE=$(python3 -c "import json; d=json.load(open('/home/user/.claude.json')); print(d['mcpServers']['clickup']['env']['CLICKUP_WORKSPACE_ID'])")
    ```

    Fetch the task, its comments, and check for attachments **in parallel**:

    ```bash
    # Task details (includes attachments[] in response)
    curl -s "https://api.clickup.com/api/v2/task/$TICKET_ID?custom_task_ids=true&team_id=$WORKSPACE" \
    -H "Authorization: $TOKEN" | python3 -m json.tool

    # Comments
    curl -s "https://api.clickup.com/api/v2/task/$TICKET_ID/comment?custom_task_ids=true&team_id=$WORKSPACE" \
    -H "Authorization: $TOKEN" | python3 -m json.tool
    ```

    Extract from **task** response:
- **`name`** — 
- **`description` / `text_content`** — requirements, acceptance criteria
- **`tags[].name`** — 
- **`project.name`** — strong repo signal (e.g. "FE" → FE frontend)
- **`list.name`** — secondary repo signal
- **`attachments[]`** — list of files: note `title`, `url`, `mimetype` for each

Extract from **comments** response:
- **`comments[].comment_text`** — plain text content
- **`comments[].user.username`** — commenter (look for PM, QA, design roles)
- **`comments[].date`** — recency (most recent = highest signal)
- Focus on comments that add requirements, clarify behavior, or flag blockers

   - fetched data will be parsed in the agent session; gathered description, attachments, comments all related data to create and work on ticket - need to think is it worth to save fetched info and sumarized to local storage to quick access or not

## Step 3 — Build Context Brief

Before proceeding, synthesize what was gathered and present it to the user as a structured brief:

```
## Context Brief — <TICKET-ID>

**Title:** <task name>

**Goal:** <1–2 sentence summary of what needs to be built or fixed>

**Key requirements:**
- <bullet from description or acceptance criteria>
- ...

**Constraints / edge cases noted:**
- <from description or comments>
- ...

**Notable comments:**
- <username> (<date>): <key point>
- ...

**Attachments:** <list filenames/types, or "none">

**Open questions (if any):**
- <things that are unclear that may need clarification before starting>
```

If there are open questions, ask the user now via `AskUserQuestion` — don't defer them.


   - title prefilled with parsed data (from ticket title in remote), optional field

   - classifier should determinate scope of the ticket

        Infer Repos & Confirm

        Infer from ticket name + description + tags:
        based on services defined in karst.yml services section

        need to build signals for repo names, signals can be like this:
        | Signal words | Likely repo |
        |---|---|
        | UI, frontend, React, page, component, dashboard, modal, form | **FE** |
        | API, endpoint, backend, database, migration, service, model, query | **BE** |

        Present assumption via `AskUserQuestion` with **multiSelect: true** — let user pick one or more - maybe non AI makes assumption, then from UI user confirms or corrects suggested


        Clarification: selection of repos\services indicator of CHANGES in further WT, but to verify work it might need to run other services, in this case they should go from main worktree, with default port
        For example:
        change pure UI - need to change lables on some page, that means only FE repo will be selected, and created WT, but it has dependency to BE service to verify done work, so BE server will be used from main WT, started or reused if it's already run



   -  tiket  title optional (later will do AI ticket title generation, based on fetched ticket info)
   - after classifier we need to suggest development approach:
     - should be list of approaches, first is recommended with Recommended badge\lable, each approch short description
     - available approaches should be configured in karst.yml or in app config(maybe better to use DB?) (below list of predefined approaches, later will add ability to create custom approaches, so need to make extendible architecture from very beggining)

        | **rpi** — Research → Plan → Implement | `rpi:research` | Scope is unclear, API contract doesn't exist yet, needs discovery before coding |
        | **gsd** — Phased delivery | `gsd:plan-phase` | Complex multi-phase feature with clear milestones and phases |
        | **superpowers: write plan first** | `superpowers:writing-plans` | Scope is known, but changes are non-trivial and benefit from a written plan before execution |
        | **superpowers: TDD** | `superpowers:test-driven-development` | Bug fix or feature with clear acceptance criteria — tests first |
         | **Direct implementation with subagent** | *(start with specific subagent)* | Small, well-scoped change; requirements fully clear from ticket |
        | **Direct implementation** | *(no skill — just start)* | Small, well-scoped change; requirements fully clear from ticket |
    - should be ability to configure agents in karst.yml or in app config(maybe better to use DB?); with few default predefined, but also user will be able to create custom agents
        - list of predefined agents: 
          - research
          - plan
          - implement
            -fe
            -be
          - test
          - code review
        

- Move karst.yml into .karst dir
- we should have setting in karst.yml to switch mode of WT paths on the dashboard; currently shown absolute path, but often it's not needed We can make it relative to project root by default, and switch to absolute by config flag (later config will be configured via UI)
- servers :
    - bind open\reset\stop buttons

- agent :
    - terminal names are Ticket #1, but should use ticket-number instead of 1, add description of terminal with title of ticket 
    - improve UI\UX of "agent: running" section

- menu navigation:
    - Karst: Open Session should be replaced with terminal-ai icon, on hover add description
    - for folded ticket item user should be able to see current ticket stage

- worktrees
    - diff should open vscode source controll diffs for that worktree
    - open folder shold navigate user to that folder in vscode explorer

- theme of extentions should be inherit of vscode theme