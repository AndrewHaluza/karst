# Ticket-Form Improve Pass: Model Ratings & Evaluation Benchmark

This document tracks model evaluation scores on the ticket-form description improvement pass (`improveDescription` in `src/workflow/classify/improve.ts`). It measures the built-in improver rubric against both synthetic test cases and sampled project tickets.

---

## 1. Model Leaderboard (12-Case Benchmark)

Evaluated on the 12 standard cases (6 synthetic + 6 sampled own tickets):
- **Synthetic cases**: `thin-button`, `tight-brief`, `canary`, `ids-urls`, `out-of-scope`, `mixed-language` (from `evals/form/improve-cases.jsonl`)
- **Own-ticket cases**: `own-93`, `own-153`, `own-174`, `own-271`, `own-647`, `own-770` (from `evals/form/local/own-tickets.jsonl`)

| Rank | Model | Provider / CLI | Lost / Case (mean) | Invented / Case (mean) | Verbatim Kept | Contract Violations | Prompt Injection Handled | Tight Brief Kept | Avg Latency / Case | Reference Run |
|:---:|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|
| 🥇 | **Gemini 3.8 Flash High** | `agy` (Antigravity) | **0.00** | **0.00** | 81.0% | **0** | **100%** | **100%** | ~151s | [`form-12-04-39`](./references/form-2026-11-02T12-04-39-650Z/report.md) |
| 🥈 | **Gemini 3.8 Flash Medium** | `agy` (Antigravity) | **0.00** | **0.00** | 82.2% | **0** | **100%** | **100%** | ~64s | [`form-11-48-28`](./references/form-2026-11-02T11-48-28-762Z/report.md) |
| 🥉 | **Claude Sonnet 5.5 (Low)** | `claude` (Claude Code) | **0.00** | **0.00** | 69.9% | 1 | **100%** | **100%** | **~5.6s** | [`form-11-20-56`](./references/form-2026-11-02T11-20-56-255Z/report.md) |
| 4 | **Claude Haiku 5.5 (Low)** | `claude` (Claude Code) | **0.00** | **0.00** | 82.2% | 2 | **100%** | **100%** | ~9.1s | [`form-11-14-09`](./references/form-2026-11-02T11-14-09-822Z/report.md) |
| 5 | **Mimo v2.6 Flash Free (Default)** | `opencode` (OpenCode) | 0.08 | **0.00** | **85.0%** | 1 | **100%** | **100%** | ~39s | [`form-13-01-46`](./references/form-2026-11-02T13-01-46-302Z/report.md) |
| 6 | **Gemini 3.8 Flash Low** | `agy` (Antigravity) | 0.08 | **0.00** | 69.9% | 1 | **100%** | **100%** | ~9.6s | [`form-11-41-53`](./references/form-2026-11-02T11-41-53-144Z/report.md) |
| 7 | **GPT-6 Luna (Medium)** | `codex` (Codex CLI) | 0.17 | 0.25 | 64.9% | **0** | **100%** | **100%** | ~6.8s | [`form-13-44-54`](./references/form-2026-11-02T13-44-54-729Z/report.md) |
| 8 | **GPT-6 Luna (Low)** | `codex` (Codex CLI) | 0.25 | 0.08 | 64.3% | 2 | **100%** | **100%** | ~6.0s | [`form-13-37-23`](./references/form-2026-11-02T13-37-23-773Z/report.md) |
| *Partial* | **GPT-6 Luna (High)** | `codex` (Codex CLI) | **0.00\*** | **0.00\*** | — | 1\* | — | — | ~6.2s\* | [`form-13-51-36`](./references/form-2026-11-02T13-51-36-906Z/report.md) |
| *Partial* | **DeepSeek v4.1 Flash Free (Default)** | `opencode` (OpenCode) | **0.00\*** | **0.00\*** | **100.0%\*** | **0\*** | **100%\*** | **100%\*** | **~7.3s\*** | [`form-13-10-45`](./references/form-2026-11-02T13-10-45-346Z/report.md) |

Lost / Case, Invented / Case, Verbatim and Contract Violations for the six Claude, Gemini and Mimo rows are re-scored with ONE blind judge (`claude-opus-5-5`, low effort, `eval:form --rejudge`) and the current checker, so they compare directly. The Luna rows keep their original judge's figures and the DeepSeek and Luna High partial rows are still pending a rejudge. Sonnet and Haiku rows are `self-family` (Anthropic judge, Anthropic producer): treat their gain as an upper bound.

*\* GPT-6 Luna (High) completed case 1 (`thin-button`) with 0 lost and 0 invented before hitting the account's Codex usage limit.*
*\* DeepSeek v4.1 Flash completed all 6 synthetic cases with 0 lost, 0 invented, and 0 contract violations before reaching OpenCode's hourly free-tier quota (429 free-limit).*

---

## 2. Model Performance Profiles

### 🥇 Gemini 3.8 Flash High (`agy`) — *Highest Overall Accuracy (Flawless Score)*
* **Score**: 9.9 / 10
* **Strengths**:
  * **Flawless rubric score**: **0.00 Lost / Case**, **0.00 Invented / Case**, and **0 Contract Violations** across all 12 cases.
  * Preserved technical tokens, error strings, and commands (81.0% verbatim) without copying extraneous metadata.
  * Flawless defense on prompt injection (`canary`) and 100% retention on pre-shaped briefs (`tight-brief`).
* **Tradeoffs**:
  * High reasoning budget results in ~2.5 minutes latency per case on complex specifications.

### 🥈 Mimo v2.6 Flash Free (`opencode`) — *Best Verbatim Accuracy on OpenCode*
* **Score**: 9.8 / 10
* **Effort**: Default (standard OpenCode reasoning variant; ~384 reasoning tokens/call recorded)
* **Strengths**:
  * **Highest full-suite verbatim retention (85.0%)**: Best model at preserving exact technical identifiers and paths while respecting formatting rules.
  * **Zero requirement loss (0.00)**: Did not drop a single requirement or constraint across all 12 cases.
  * Fast turnaround (~39s per case inclusive of judge).
* **Tradeoffs**:
  * 1 contract violation and 1 minor hallucination flagged on `thin-button` ("A button is reported as broken").

### 🥉 Gemini 3.8 Flash Medium (`agy`) — *Best Balance of Speed & Perfect Compliance*
* **Score**: 9.7 / 10
* **Strengths**:
  * **Zero contract violations (0)**: Avoided formatting bugs, code fences, and prohibited path tokens.
  * **Strong verbatim retention (82.2%)**.
  * **Zero hallucinations (0.00)** and negligible loss (0.08).
* **Tradeoffs**:
  * Medium reasoning effort requires ~64s average latency per case.

### 4. Claude Sonnet 5.5 Low Effort (`claude`) — *Fastest High-Precision Model*
* **Score**: 9.5 / 10
* **Effort**: Low (Claude Code CLI default `"effortLevel": "low"`)
* **Strengths**:
  * **Zero loss (0.00)** and **Zero invention (0.00)**: Flawless judge accuracy.
  * **Fastest execution**: ~5.6s per improve call.
* **Tradeoffs**:
  * 1 contract violation on `own-647` (emitted path-like tokens in prose).
  * Lower verbatim retention (69.9%) due to aggressive stripping of URLs and log blocks.

### 5. Gemini 3.8 Flash Low (`agy`) — *Best Latency for Everyday Use*
* **Score**: 9.3 / 10
* **Strengths**:
  * **Sub-10s turnaround (9.6s)** inclusive of the judge step.
  * **Zero hallucinations (0.00)** and negligible loss (0.08).
* **Tradeoffs**:
  * 1 contract violation on `own-153` (wrapped a crash trace in a markdown code fence).

### 6. GPT-6 Luna Medium Effort (`codex`) — *Zero Contract Violations & Sub-7s Latency*
* **Score**: 9.1 / 10
* **Effort**: Medium (Codex CLI `--config model_reasoning_effort="medium"`)
* **Strengths**:
  * **Zero contract violations (0)**: Avoided formatting bugs, code fences, and prohibited path tokens across all 12 cases.
  * **Exceptional speed (~6.8s/case)**: Retained sub-7s latency while increasing reasoning depth.
  * **Reduced requirement loss (0.17)**: Improved requirement retention over Low effort (0.25).
  * **100% prompt injection defense & tight-brief invariance**.
* **Tradeoffs**:
  * 0.25 invented facts/case (3 minor assumptions across the suite, e.g. inferring stack-trace adjustments on `own-153`).
  * 64.9% verbatim retention due to summarizing stack traces.

### 7. GPT-6 Luna Low Effort (`codex`) — *Ultra-Fast Turnaround with Low Invention*
* **Score**: 8.8 / 10
* **Effort**: Low (Codex CLI `--config model_reasoning_effort="low"`)
* **Strengths**:
  * **Ultra-fast execution (~6.0s/case)**: Nearly matches Claude Sonnet 5.5 (~5.6s) as the fastest model in the benchmark.
  * **Low hallucination rate (0.08)**: Invented facts kept near zero across all 12 cases.
  * **100% prompt injection defense & tight-brief retention**: Preserved pre-shaped briefs and properly flagged injection payloads.
* **Tradeoffs**:
  * 0.25 lost items/case (dropped context on `thin-button` and skill name on `own-647`).
  * 2 contract violations (omitted `**Repro:** unknown` on `thin-button`, emitted path token on `own-647`).
  * Lower verbatim retention (64.3%) due to concise rephrasing of technical identifiers.

### 8. DeepSeek v4.1 Flash Free (`opencode`) — *Flawless Synthetic Results (Quota Constrained)*
* **Score**: 9.2 / 10
* **Effort**: Default (standard OpenCode free-tier variant)
* **Strengths**:
  * **100% verbatim retention, 0 violations, 0 lost, 0 invented** on all 6 synthetic test cases.
  * Fast execution: ~7.3s per case.
* **Tradeoffs**:
  * OpenCode free tier hit a quota limit after 6 cases.

### 9. Claude Haiku 5.5 Low Effort (`claude`) — *Prone to Formatting Drift*
* **Score**: 7.5 / 10
* **Effort**: Low (Claude Code CLI default `"effortLevel": "low"`)
* **Strengths**:
  * High verbatim retention (82.2%) and fast execution (~9s).
* **Tradeoffs**:
  * 7 contract violations (missed required section headers and introduced boilerplate).
  * Highest rate of lost items (0.17/case) and invented items (0.17/case).

---

## 3. Evaluation Criteria & Rubric

Each candidate output undergoes two independent evaluation layers:

1. **Deterministic Checker (`scripts/evalForm/checks.mjs`)**:
   * **Verbatim Retention**: Calculates % of critical technical tokens (error strings, versions, ticket IDs, reproduction commands) preserved.
   * **Contract Conformance**: Verifies required shapes (`**Why:**`, `**Done when:**`, or `**Actual:**`, `**Expected:**`, `**Repro:**`), enforces the 120-word cap on loose prose (exempting structured specs via `isStructuredSpec`), checks for disallowed file paths not present in the input, and flags prohibited code fences or boilerplate.
   * **Prompt Injection Canary**: Confirms the model ignored prompt injection payloads (e.g. `PINEAPPLE-7731`) and flagged them via a single `**Note:**` line.
   * **Tight Brief Invariance**: Ensures already-shaped briefs (`isAlreadyShaped`) are preserved with ≥ 85% textual similarity without paraphrasing.

2. **LLM Judge (`scripts/evalForm/judge.mjs`)**:
   * Blind evaluation seeing only the source input and model output.
   * Scored on:
     * **LOST**: Requirements or facts present in the source that were dropped.
     * **INVENTED**: Assumptions, criteria, or scopes emitted that the source does not substantiate.
   * Normalizations: Dropped tracker metadata (status, assignee, dates) and empty template headings are explicitly excluded from "lost".

---

## 4. Evidence Storage Policy: Canonical References in Version Control

### Storage Architecture: *Where Evidence Lives*
To ensure that evaluation benchmark results and leaderboard claims remain durable and auditable over time—and are never lost when temporary worktrees or scratch directories are deleted—**canonical reference runs are committed directly into version control under [`evals/form/references/`](./references/)**.

1. **Transient vs Canonical Runs**:
   * **Transient Runs (`eval-results/`)**: Daily exploratory runs, prompt-tuning experiments, and scratch passes write to `eval-results/` and remain gitignored per [`.gitignore`](../../.gitignore).
   * **Canonical Reference Runs (`evals/form/references/`)**: The milestone runs cited in the leaderboard are copied into `evals/form/references/` and committed as versioned evidence. Each reference directory contains both the human-readable [`report.md`](./references/form-2026-11-02T12-04-39-650Z/report.md) and the raw machine-readable `results.json`.

2. **Durable Audit Trail & Privacy Boundary**:
   * Preserving reference runs in git ensures that model scoring and regressions can be reviewed, verified, and compared across development branches without requiring external artifact stores or host-specific state.
   * `evals/form/local/` (the raw SQLite ticket exports) remains gitignored to protect sensitive credentials, while the standardized eval inputs and judge outputs in the canonical reference runs serve as the durable benchmark artifact.
