# New Computer Guide Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the full new-computer setup guide out of the root README into a focused document while preserving all deployment information.

**Architecture:** `docs/new-computer-setup.md` owns complete migration instructions. `README.md` exposes only a short entry point and the three highest-risk reminders.

**Tech Stack:** Markdown, Git

## Global Constraints

- Do not change scripts, dependency versions, commands, or deployment behavior.
- New computers do not migrate temperature monitoring.
- Do not add databases, credentials, or runtime state to Git.
- Preserve the existing unrelated QQ worker modification.

---

### Task 1: Split the deployment guide

**Files:**
- Create: `docs/new-computer-setup.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the current `README.md` section from `## 新电脑环境与依赖` through the paragraph before `## 架构`
- Produces: a standalone guide linked from the root README

- [ ] **Step 1: Move the complete setup content**

Copy the full setup section into `docs/new-computer-setup.md`, headed `# 新电脑部署指南`, without changing commands or requirements.

- [ ] **Step 2: Replace the root section with a short entry**

Keep a short `## 新电脑部署` section containing the document link and these reminders: SQLite is excluded from Git, temperature monitoring is not migrated, and credentials/runtime state must be restored separately.

- [ ] **Step 3: Verify structure and references**

Run checks confirming the README has no full install command block, the standalone document contains every environment and numbered deployment section, and each referenced repository script exists.

- [ ] **Step 4: Verify formatting**

Run `git diff --check` and inspect the Markdown diff for duplicated or missing sections.

- [ ] **Step 5: Commit and push**

Commit only the two documentation files and this plan, leaving the unrelated QQ worker modification unstaged, then push `main`.
