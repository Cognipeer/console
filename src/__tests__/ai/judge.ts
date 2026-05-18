/**
 * Model-agnostic LLM judge for behavioral tests.
 *
 * Why this exists
 * ────────────────
 * Some properties of the system can't be asserted with `expect().toEqual()`:
 *   - "Did the guardrail block this prompt for a good reason?"
 *   - "Did the agent pick the correct tool given this user query?"
 *   - "Is this prompt regression breaking the response quality?"
 *
 * Hard-coded expectations work, but they're brittle: rewording the model
 * response by a single word fails the test. An LLM judge scores a candidate
 * response against a rubric and returns a structured verdict. The verdict is
 * deterministic-enough at temperature=0 to use as a CI signal.
 *
 * Model independence
 * ──────────────────
 * The judge does NOT depend on a specific model SDK. Callers configure a
 * `JudgeBackend` adapter once (env-driven) and the tests don't know which
 * model is judging. Today we ship adapters for OpenAI-compatible HTTP, but
 * any backend that can return JSON given a prompt fits.
 *
 * Cost & stability rules of thumb
 * ───────────────────────────────
 *  - Temperature 0, max_tokens ≤ 200, single response (no sampling) — verdicts
 *    must be reproducible across CI runs.
 *  - Always require the model to return JSON with a fixed schema. If parsing
 *    fails, the test fails loud — never silently treat ambiguous output as
 *    "pass".
 *  - Cap per-test budget. A judge call should be cheap; if you need 50 judge
 *    calls in a single test, refactor or batch the rubric.
 *  - Skip the suite (not fail) when `JUDGE_DISABLED=1` or the backend env is
 *    missing — that lets contributors without API keys still run `npm test`.
 */

export type Verdict = {
  /** 0-1 normalized score the judge assigns. Use thresholds in assertions. */
  score: number;
  /** Optional categorical label, e.g. "pass" / "fail" / "warn". */
  label?: string;
  /** Short human-readable rationale — useful when debugging CI failures. */
  reason: string;
};

export type JudgeRequest = {
  /** What the model was asked to evaluate. */
  rubric: string;
  /** The candidate text the judge is scoring. */
  candidate: string;
  /** Optional reference / golden answer for comparison-style rubrics. */
  reference?: string;
  /** Extra context fed verbatim into the prompt. */
  context?: Record<string, unknown>;
  /** Identifier for traceability in logs. */
  testId: string;
};

export interface JudgeBackend {
  readonly id: string;
  /** Call the model and return ONLY parsed JSON. Implementations enforce the schema. */
  judge(req: JudgeRequest): Promise<Verdict>;
}

// ── Prompt template (single source of truth) ─────────────────────────────────

export function buildJudgePrompt(req: JudgeRequest): string {
  const parts = [
    'You are a strict evaluator. Score the candidate against the rubric.',
    'Return ONLY a single JSON object with this exact shape and no surrounding text:',
    '{"score": number between 0 and 1, "label": "pass" | "fail" | "warn", "reason": "1-sentence rationale"}',
    '',
    `### Rubric`,
    req.rubric,
    '',
    `### Candidate`,
    req.candidate,
  ];
  if (req.reference) {
    parts.push('', '### Reference (golden answer)', req.reference);
  }
  if (req.context && Object.keys(req.context).length > 0) {
    parts.push('', '### Context', JSON.stringify(req.context, null, 2));
  }
  parts.push('', '### Verdict (JSON only)');
  return parts.join('\n');
}

export function parseVerdict(raw: string, testId: string): Verdict {
  // The model sometimes wraps JSON in ```json ... ``` fences. Strip them.
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `[judge:${testId}] backend returned non-JSON output. Raw: ${cleaned.slice(0, 200)}`,
    );
  }

  const o = obj as { score?: unknown; label?: unknown; reason?: unknown };
  if (typeof o.score !== 'number' || o.score < 0 || o.score > 1) {
    throw new Error(`[judge:${testId}] verdict missing/invalid score: ${JSON.stringify(o)}`);
  }
  if (typeof o.reason !== 'string') {
    throw new Error(`[judge:${testId}] verdict missing reason: ${JSON.stringify(o)}`);
  }
  return {
    score: o.score,
    label: typeof o.label === 'string' ? o.label : undefined,
    reason: o.reason,
  };
}

// ── OpenAI-compatible HTTP backend (works with OpenAI, Together, Bedrock-via-LiteLLM, etc.) ──

type OpenAiCompatConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function makeOpenAiCompatibleBackend(cfg: OpenAiCompatConfig): JudgeBackend {
  return {
    id: `openai-compatible:${cfg.model}`,
    async judge(req) {
      const prompt = buildJudgePrompt(req);
      const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`[judge:${req.testId}] backend HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? '';
      return parseVerdict(content, req.testId);
    },
  };
}

// ── Anthropic Messages API backend ──────────────────────────────────────────

type AnthropicConfig = {
  baseUrl?: string;
  apiKey: string;
  model: string;
};

export function makeAnthropicBackend(cfg: AnthropicConfig): JudgeBackend {
  const baseUrl = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  return {
    id: `anthropic:${cfg.model}`,
    async judge(req) {
      const prompt = buildJudgePrompt(req);
      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`[judge:${req.testId}] anthropic HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const json = (await resp.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = (json.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      return parseVerdict(text, req.testId);
    },
  };
}

// ── Resolution: pick backend from env ───────────────────────────────────────

/**
 * Pick a judge backend from environment variables.
 * Returns `null` if no backend is configured — callers should `describe.skipIf`.
 *
 * Env precedence (first non-empty wins):
 *  1. JUDGE_BACKEND=openai|anthropic  + matching credentials
 *  2. OPENAI_API_KEY            → OpenAI gpt-4o-mini
 *  3. ANTHROPIC_API_KEY         → Anthropic claude-haiku-4-5
 *  4. JUDGE_BASE_URL + JUDGE_API_KEY + JUDGE_MODEL → custom OpenAI-compatible
 */
export function resolveJudgeBackend(): JudgeBackend | null {
  if (process.env.JUDGE_DISABLED === '1') return null;

  const explicit = process.env.JUDGE_BACKEND;
  if (explicit === 'openai' && process.env.OPENAI_API_KEY) {
    return makeOpenAiCompatibleBackend({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.JUDGE_MODEL ?? 'gpt-4o-mini',
    });
  }
  if (explicit === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    return makeAnthropicBackend({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.JUDGE_MODEL ?? 'claude-haiku-4-5',
    });
  }

  if (process.env.JUDGE_BASE_URL && process.env.JUDGE_API_KEY && process.env.JUDGE_MODEL) {
    return makeOpenAiCompatibleBackend({
      baseUrl: process.env.JUDGE_BASE_URL,
      apiKey: process.env.JUDGE_API_KEY,
      model: process.env.JUDGE_MODEL,
    });
  }

  if (process.env.OPENAI_API_KEY) {
    return makeOpenAiCompatibleBackend({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.JUDGE_MODEL ?? 'gpt-4o-mini',
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return makeAnthropicBackend({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.JUDGE_MODEL ?? 'claude-haiku-4-5',
    });
  }
  return null;
}
