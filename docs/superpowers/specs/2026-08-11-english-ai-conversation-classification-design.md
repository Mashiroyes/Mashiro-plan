# English AI Conversation Classification Design

## Goal

Refine the English four-skills classifier so plan titles describing written AI conversations count as writing, while titles describing AI chats count as speaking.

## Classification rules

- Treat supported general AI assistants (`ChatGPT`, `AI`, `Gemini`, `Grok`, `Claude`, `DeepSeek`, and `元宝`) followed by `对话` as writing.
- Treat the same AI assistant names followed by `聊天` as speaking.
- Allow natural prefixes such as `和`, `跟`, and `与` because matching starts at the AI product name.
- Ignore case and spaces inside the compound phrase, so `和 ChatGPT 对话` and `和chatgpt对话` behave identically.
- Keep the existing precedence order. Writing remains ahead of speaking, so the generic speaking keyword `对话` cannot steal a written-AI-conversation title.
- Do not change generic `对话` behavior: without one of the named AI terms, it remains speaking.

## Implementation

Add compact compound keywords to `english-skill-keywords.json`. Extend keyword matching to compare both normalized text and a whitespace-free form. This keeps the configuration data-driven and avoids enumerating every Chinese preposition and spacing variant.

## Verification

Unit tests cover every supported AI term, both verbs, spaced titles, case-insensitive titles, prefix variants, and the unchanged generic `英语对话` behavior. Run the focused English-skills suite and the full plan-plugin Python test suite.
