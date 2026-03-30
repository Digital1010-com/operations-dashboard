/**
 * Agent LLM Integration Layer
 *
 * Provides callAgent() — the single function all agents use to invoke LLMs.
 * Handles: provider selection (Anthropic/OpenAI), BYOK resolution, token tracking,
 * rate limiting, and structured output parsing.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Agent System Definitions (loaded once at startup) ─────────────────────────
const AGENT_DEFINITIONS_DIR = process.env.AGENT_DEFINITIONS_DIR
  || '/Volumes/AI_Drive/03-D1010-OS/_MASTERS/agents';
const BUNDLED_AGENT_DIR = path.join(__dirname, 'agent-definitions');
const agentDefinitionCache = new Map();

function loadAgentDefinition(agentName) {
  const cached = agentDefinitionCache.get(agentName);
  if (cached && cached.loadedAt > Date.now() - 300_000) return cached.content; // 5min cache

  const filename = `${agentName}-system-definition.md`;
  // Try external dir first, then bundled fallback
  const dirs = [AGENT_DEFINITIONS_DIR, BUNDLED_AGENT_DIR];
  for (const dir of dirs) {
    const filePath = path.join(dir, filename);
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      agentDefinitionCache.set(agentName, { content, loadedAt: Date.now() });
      return content;
    } catch (_) {}
  }
  console.error(`[agent-llm] No definition found for agent: ${agentName}`);
  return null;
}

// ─── Token Usage Tracking ──────────────────────────────────────────────────────
const USAGE_LOG_DIR = path.join(__dirname, 'data', 'agent-usage');

function appendUsageRecord(record) {
  try {
    fs.mkdirSync(USAGE_LOG_DIR, { recursive: true });
    const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const logFile = path.join(USAGE_LOG_DIR, `usage-${dateKey}.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('[agent-llm] Failed to write usage record:', err.message);
  }
}

function getUsageSummary(agencyId, days = 30) {
  const summary = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, byAgent: {} };
  try {
    const files = fs.readdirSync(USAGE_LOG_DIR).filter(f => f.startsWith('usage-') && f.endsWith('.jsonl'));
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    for (const file of files) {
      const dateKey = file.replace('usage-', '').replace('.jsonl', '');
      if (dateKey < cutoff) continue;
      const lines = fs.readFileSync(path.join(USAGE_LOG_DIR, file), 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (agencyId && record.agencyId !== agencyId) continue;
          summary.totalCalls += 1;
          summary.totalInputTokens += record.inputTokens || 0;
          summary.totalOutputTokens += record.outputTokens || 0;
          summary.totalCostUsd += record.estimatedCostUsd || 0;
          const agent = record.agent || 'unknown';
          if (!summary.byAgent[agent]) summary.byAgent[agent] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
          summary.byAgent[agent].calls += 1;
          summary.byAgent[agent].inputTokens += record.inputTokens || 0;
          summary.byAgent[agent].outputTokens += record.outputTokens || 0;
          summary.byAgent[agent].costUsd += record.estimatedCostUsd || 0;
        } catch (_) {}
      }
    }
  } catch (_) {}
  summary.totalCostUsd = Math.round(summary.totalCostUsd * 10000) / 10000;
  return summary;
}

// ─── Cost Estimation ───────────────────────────────────────────────────────────
const MODEL_COSTS = {
  // Anthropic (per million tokens)
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  // OpenRouter model IDs (same pricing as direct)
  'anthropic/claude-sonnet-4-20250514': { input: 3, output: 15 },
  'anthropic/claude-haiku-4-5-20251001': { input: 0.80, output: 4 },
  'anthropic/claude-opus-4-20250514': { input: 15, output: 75 },
};

function estimateCost(model, inputTokens, outputTokens) {
  const costs = MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-20250514'];
  return ((inputTokens * costs.input) + (outputTokens * costs.output)) / 1_000_000;
}

// ─── Agent Model Config ────────────────────────────────────────────────────────
const AGENT_MODEL_MAP = {
  joan: 'claude-sonnet-4-20250514',
  peg: 'claude-sonnet-4-20250514',
  pulse: 'claude-haiku-4-5-20251001',
  verifier: 'claude-sonnet-4-20250514',
  documentation: 'claude-haiku-4-5-20251001',
};

// ─── LLM Call Functions ────────────────────────────────────────────────────────

async function callAnthropic(apiKey, model, systemPrompt, userMessage, options = {}) {
  const body = {
    model,
    max_tokens: options.maxTokens || 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    const errMsg = data?.error?.message || data?.error || JSON.stringify(data);
    throw new Error(`Anthropic API error (${response.status}): ${errMsg}`);
  }

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    text,
    model: data.model || model,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    stopReason: data.stop_reason || 'unknown',
  };
}

async function callOpenAICompatible(apiKey, model, systemPrompt, userMessage, options = {}) {
  const baseUrl = options.baseUrl || 'https://api.openai.com/v1';
  const providerLabel = options.providerLabel || 'OpenAI';
  const body = {
    model,
    max_tokens: options.maxTokens || 2048,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  // OpenRouter requires site identification headers
  if (providerLabel === 'OpenRouter') {
    headers['HTTP-Referer'] = 'https://app.digital1010.tech';
    headers['X-Title'] = 'D1010 Mission Control';
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    const errMsg = data?.error?.message || data?.error || JSON.stringify(data);
    throw new Error(`${providerLabel} API error (${response.status}): ${errMsg}`);
  }

  const choice = (data.choices || [])[0] || {};
  return {
    text: choice.message?.content || '',
    model: data.model || model,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    stopReason: choice.finish_reason || 'unknown',
  };
}

// Backwards-compatible wrapper
async function callOpenAI(apiKey, model, systemPrompt, userMessage, options = {}) {
  return callOpenAICompatible(apiKey, model, systemPrompt, userMessage, { ...options, baseUrl: 'https://api.openai.com/v1', providerLabel: 'OpenAI' });
}

async function callOpenRouter(apiKey, model, systemPrompt, userMessage, options = {}) {
  return callOpenAICompatible(apiKey, model, systemPrompt, userMessage, { ...options, baseUrl: 'https://openrouter.ai/api/v1', providerLabel: 'OpenRouter' });
}

// ─── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Call an agent with an LLM.
 *
 * @param {object} opts
 * @param {string} opts.agent - Agent name (e.g. 'joan', 'peg')
 * @param {string} opts.userMessage - The prompt/task for the agent
 * @param {string} [opts.agencyId] - Tenant ID for usage tracking
 * @param {string} [opts.systemPromptOverride] - Override the agent's definition file
 * @param {string} [opts.model] - Override the default model for this agent
 * @param {string} [opts.provider] - 'anthropic' or 'openai' (auto-detected from model if omitted)
 * @param {number} [opts.maxTokens] - Max output tokens (default 2048)
 * @param {number} [opts.temperature] - Sampling temperature
 * @param {function} [opts.getCredentials] - Function(provider, agencyId) => { apiKey }
 * @returns {Promise<{text: string, model: string, inputTokens: number, outputTokens: number, estimatedCostUsd: number}>}
 */
async function callAgent(opts) {
  const {
    agent,
    userMessage,
    agencyId = 'default',
    systemPromptOverride,
    model: modelOverride,
    provider: providerOverride,
    maxTokens,
    temperature,
    getCredentials,
  } = opts;

  if (!agent) throw new Error('agent name is required');
  if (!userMessage) throw new Error('userMessage is required');

  // Resolve system prompt
  const systemPrompt = systemPromptOverride || loadAgentDefinition(agent);
  if (!systemPrompt) {
    throw new Error(`No system definition found for agent: ${agent}`);
  }

  // Resolve model
  const model = modelOverride || AGENT_MODEL_MAP[agent] || 'claude-sonnet-4-20250514';

  // Detect provider from model name
  const isOpenAI = model.startsWith('gpt-') || model.startsWith('o1-') || model.startsWith('o3-');
  let provider = providerOverride || (isOpenAI ? 'openai' : 'anthropic');

  // Auto-fallback: if Anthropic key is missing but OpenRouter key is available, use OpenRouter
  if (provider === 'anthropic' && !String(process.env.ANTHROPIC_API_KEY || '').trim() && String(process.env.OPENROUTER_API_KEY || '').trim()) {
    provider = 'openrouter';
  }

  // Resolve API key for a given provider
  function resolveApiKey(prov) {
    let key = '';
    if (getCredentials) {
      const creds = getCredentials(prov, agencyId);
      key = creds?.apiKey || '';
    }
    if (!key) {
      if (prov === 'openai') key = String(process.env.OPENAI_API_KEY || '').trim();
      else if (prov === 'openrouter') key = String(process.env.OPENROUTER_API_KEY || '').trim();
      else key = String(process.env.ANTHROPIC_API_KEY || '').trim();
    }
    return key;
  }

  let apiKey = resolveApiKey(provider);
  if (!apiKey) {
    throw new Error(`No API key available for provider: ${provider}. Set the appropriate API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY) or configure BYOK.`);
  }

  // Model ID mapping per provider
  const openRouterModelMap = {
    'claude-sonnet-4-20250514': 'anthropic/claude-sonnet-4-20250514',
    'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4-5-20251001',
    'claude-opus-4-20250514': 'anthropic/claude-opus-4-20250514',
  };
  const openAIFallbackMap = {
    'claude-sonnet-4-20250514': 'gpt-4o',
    'claude-haiku-4-5-20251001': 'gpt-4o-mini',
    'claude-opus-4-20250514': 'gpt-4o',
  };

  // Provider fallback chain: Anthropic → OpenRouter → OpenAI
  const fallbackProviders = [];
  if (provider === 'anthropic') {
    if (resolveApiKey('openrouter')) fallbackProviders.push('openrouter');
    if (resolveApiKey('openai')) fallbackProviders.push('openai');
  }

  async function callWithProvider(prov, key) {
    let effectiveModel = model;
    if (prov === 'openrouter') effectiveModel = openRouterModelMap[model] || model;
    else if (prov === 'openai') effectiveModel = openAIFallbackMap[model] || model;
    if (prov === 'openrouter') return callOpenRouter(key, effectiveModel, systemPrompt, userMessage, { maxTokens, temperature });
    if (prov === 'openai') return callOpenAI(key, effectiveModel, systemPrompt, userMessage, { maxTokens, temperature });
    return callAnthropic(key, effectiveModel, systemPrompt, userMessage, { maxTokens, temperature });
  }

  // Call the LLM with automatic fallback on billing/auth errors
  const startMs = Date.now();
  let result;
  try {
    result = await callWithProvider(provider, apiKey);
  } catch (primaryErr) {
    const isBillingOrAuth = /credit balance|billing|quota|insufficient|rate limit/i.test(primaryErr.message);
    if (isBillingOrAuth && fallbackProviders.length > 0) {
      let lastErr = primaryErr;
      for (const fbProvider of fallbackProviders) {
        const fbKey = resolveApiKey(fbProvider);
        if (!fbKey) continue;
        try {
          console.log(`[agent-llm] ${provider} failed (${primaryErr.message}), falling back to ${fbProvider}`);
          provider = fbProvider; // Update for usage tracking
          result = await callWithProvider(fbProvider, fbKey);
          lastErr = null;
          break;
        } catch (fbErr) {
          lastErr = fbErr;
        }
      }
      if (lastErr) throw lastErr;
    } else {
      throw primaryErr;
    }
  }

  const durationMs = Date.now() - startMs;
  const estimatedCostUsd = estimateCost(model, result.inputTokens, result.outputTokens);

  // Track usage
  const usageRecord = {
    id: crypto.randomBytes(8).toString('hex'),
    timestamp: new Date().toISOString(),
    agencyId,
    agent,
    provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
    durationMs,
    stopReason: result.stopReason,
  };
  appendUsageRecord(usageRecord);

  return {
    text: result.text,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd,
    durationMs,
  };
}

// ─── Structured Output Parser ──────────────────────────────────────────────────

/**
 * Parse an EMAIL_TASK_PACKET from raw LLM output text.
 * Returns a structured object or null if parsing fails.
 */
function parseEmailTaskPacket(text) {
  if (!text) return null;

  // Try JSON first (if agent returns JSON)
  try {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*"message_id"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      return normalizeTaskPacket(parsed);
    }
  } catch (_) {}

  // Parse the YAML-like format from shared-formats.md
  const packet = {};
  const lines = text.split('\n');
  let currentKey = null;
  let summaryLines = [];
  let inSummary = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip headers and empty lines
    if (trimmed.startsWith('EMAIL_TASK_PACKET') || trimmed.startsWith('---') || !trimmed) {
      if (inSummary && summaryLines.length) {
        packet.summary = summaryLines;
        inSummary = false;
      }
      continue;
    }

    // Key-value pairs
    const kvMatch = trimmed.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      if (inSummary && summaryLines.length) {
        packet.summary = summaryLines;
        inSummary = false;
      }
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();
      if (key === 'summary') {
        inSummary = true;
        summaryLines = [];
        if (value) summaryLines.push(value);
      } else {
        packet[key] = value || '';
      }
      currentKey = key;
      continue;
    }

    // List items under summary
    if (inSummary && trimmed.startsWith('-')) {
      summaryLines.push(trimmed.replace(/^-\s*/, '').trim());
      continue;
    }
  }

  if (inSummary && summaryLines.length) {
    packet.summary = summaryLines;
  }

  if (!packet.category && !packet.message_id) return null;
  return normalizeTaskPacket(packet);
}

function normalizeTaskPacket(raw) {
  return {
    message_id: String(raw.message_id || '').trim(),
    from: String(raw.from || '').trim(),
    company: String(raw.company || '').trim(),
    subject: String(raw.subject || '').trim(),
    task_title: String(raw.task_title || '').trim(),
    timestamp: String(raw.timestamp || '').trim(),
    category: String(raw.category || 'Action Required').trim(),
    priority: String(raw.priority || 'Medium').trim(),
    summary: Array.isArray(raw.summary) ? raw.summary : [String(raw.summary || '').trim()].filter(Boolean),
    requested_outcome: String(raw.requested_outcome || '').trim(),
    deadline_signals: String(raw.deadline_signals || 'none').trim(),
    attachments: String(raw.attachments || 'none').trim(),
    recommended_owner: String(raw.recommended_owner || 'Peg').trim(),
    draft_response: String(raw.draft_response || '').trim(),
  };
}

module.exports = {
  callAgent,
  loadAgentDefinition,
  parseEmailTaskPacket,
  getUsageSummary,
  AGENT_MODEL_MAP,
};
