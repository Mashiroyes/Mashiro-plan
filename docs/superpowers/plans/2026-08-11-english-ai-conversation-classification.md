# English AI Conversation Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify AI `对话` plan titles as English writing and AI `聊天` plan titles as English speaking.

**Architecture:** Keep classification rules in the existing JSON keyword configuration. Make the existing matcher whitespace-tolerant while preserving its case folding and precedence semantics.

**Tech Stack:** Python 3, JSON, `unittest`

## Global Constraints

- `ChatGPT`, `AI`, `Gemini`, `Grok`, `Claude`, `DeepSeek`, and `元宝` plus `对话` classify as writing.
- The same AI assistant names plus `聊天` classify as speaking.
- Matching accepts natural prefixes and optional spaces.
- Generic `英语对话` remains speaking.

---

### Task 1: Add classification coverage and implementation

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/tests/test_english_skills.py`
- Modify: `plugin/mashirobot-plugin-plan/config/english-skill-keywords.json`
- Modify: `plugin/mashirobot-plugin-plan/planner/english_skills.py`

**Interfaces:**
- Consumes: `classify_title(title: str, config: dict | None = None) -> str | None`
- Produces: whitespace-tolerant keyword classification with unchanged return values

- [x] **Step 1: Write the failing test**

```python
def test_ai_conversation_and_chat_classification(self):
    for title in ("和chatgpt对话", "跟 AI 对话", "与Gemini对话", "和Grok对话", "与 Claude 对话", "跟deepseek对话", "和元宝对话"):
        self.assertEqual(classify_title(title), "writing")
    for title in ("和chatgpt聊天", "跟 AI 聊天", "与Gemini聊天", "和Grok聊天", "与 Claude 聊天", "跟deepseek聊天", "和元宝聊天"):
        self.assertEqual(classify_title(title), "speaking")
    self.assertEqual(classify_title("英语对话"), "speaking")
```

- [x] **Step 2: Run test to verify it fails**

Run: `python -m unittest plugin/mashirobot-plugin-plan/tests/test_english_skills.py -v`

Expected: FAIL because AI `对话` titles currently match the generic speaking keyword.

- [x] **Step 3: Write minimal implementation**

Add the supported AI assistant names combined with `对话` to writing and the corresponding `聊天` compounds to speaking. In `classify_title`, compare normalized source and keywords in both their ordinary and whitespace-free forms.

- [x] **Step 4: Run focused and full tests**

Run: `python -m unittest plugin/mashirobot-plugin-plan/tests/test_english_skills.py -v`

Expected: all focused tests pass.

Run: `python -m unittest discover -s plugin/mashirobot-plugin-plan/tests -p "test_*.py" -v`

Expected: all Python tests pass.

- [x] **Step 5: Review the exact changed files**

Confirm only the design, plan, configuration, classifier, and focused tests changed. This workspace has no usable Git metadata, so no commit step is possible.
