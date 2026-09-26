/**
 * Anel único de resiliência com 18 chaves para geração de TEXTO.
 *
 *   Groq (6 chaves)  ->  Mistral (6 chaves)  ->  Gemini (6 chaves)  ->  IA Lovable
 *
 * Regras:
 *  - Rotação: cada provedor tem um cursor próprio, então chamadas seguidas
 *    não caem sempre na mesma chave.
 *  - Failover: qualquer erro (cota, 429, 5xx, timeout) registra a falha,
 *    coloca a chave em descanso e passa para a próxima IMEDIATAMENTE.
 *  - Se as 18 chaves falharem numa rodada, faz uma pausa técnica e tenta tudo
 *    de novo (até MAX_ROUNDS rodadas).
 *  - Última retaguarda: IA nativa da Lovable, para a geração nunca travar.
 *
 * Server-only: nunca importe este módulo em código de browser.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type AiProvider = "groq" | "mistral" | "gemini";

export type AiTextOptions = {
  stage: string;
  ebookId?: string | null;
  /** Ordem de preferência dos provedores nesta etapa. */
  order?: AiProvider[];
  maxTokens?: number;
  temperature?: number;
};

export type AiTextResult = {
  text: string;
  provider: AiProvider | "lovable";
  keyIndex: number;
};

const KEY_COUNT = 6;
const REQUEST_TIMEOUT_MS = 25_000;
const COOLDOWN_MS = 45_000;
const TECHNICAL_PAUSE_MS = 6_000;
const MAX_ROUNDS = 3;
const DEFAULT_ORDER: AiProvider[] = ["groq", "mistral", "gemini"];

const ENV_PREFIX: Record<AiProvider, string> = {
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const GEMINI_TEXT_MODEL = "gemini-3.6-flash";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const MISTRAL_MODEL = "mistral-small-latest";

const cursor: Record<AiProvider, number> = { groq: 0, mistral: 0, gemini: 0 };
const cooldownUntil = new Map<string, number>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function poolOf(provider: AiProvider): { index: number; key: string }[] {
  const prefix = ENV_PREFIX[provider];
  const keys: { index: number; key: string }[] = [];
  for (let index = 1; index <= KEY_COUNT; index++) {
    const value = process.env[`${prefix}_${index}`]?.trim();
    if (value) keys.push({ index, key: value });
  }
  return keys;
}

/** Quantas chaves de texto estão configuradas, por provedor. */
export function textKeyInventory(): Record<AiProvider, number> {
  return {
    groq: poolOf("groq").length,
    mistral: poolOf("mistral").length,
    gemini: poolOf("gemini").length,
  };
}

async function logKeyEvent(
  provider: string,
  keyIndex: number,
  status: string,
  stage: string,
  message: string | null,
  ebookId: string | null,
) {
  try {
    await supabaseAdmin.from("api_key_events").insert({
      key_index: keyIndex,
      status: `${provider}_${status}`,
      stage,
      message: message ? message.slice(0, 500) : null,
      ebook_id: ebookId,
    });
  } catch {
    // Telemetria nunca pode interromper a geração.
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGroq(
  key: string,
  system: string,
  prompt: string,
  opts: Required<Pick<AiTextOptions, "maxTokens" | "temperature">>,
): Promise<string> {
  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq retornou resposta vazia.");
  return text;
}

async function callMistral(
  key: string,
  system: string,
  prompt: string,
  opts: Required<Pick<AiTextOptions, "maxTokens" | "temperature">>,
): Promise<string> {
  const res = await fetchWithTimeout("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Mistral ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Mistral retornou resposta vazia.");
  return text;
}

async function callGemini(
  key: string,
  system: string,
  prompt: string,
  opts: Required<Pick<AiTextOptions, "maxTokens" | "temperature">>,
): Promise<string> {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: opts.temperature,
          maxOutputTokens: opts.maxTokens,
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini retornou resposta vazia.");
  return text;
}

const CALLERS: Record<
  AiProvider,
  (
    key: string,
    system: string,
    prompt: string,
    opts: Required<Pick<AiTextOptions, "maxTokens" | "temperature">>,
  ) => Promise<string>
> = { groq: callGroq, mistral: callMistral, gemini: callGemini };

/** Última retaguarda: IA nativa da Lovable. */
async function callLovable(system: string, prompt: string): Promise<string> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("LOVABLE_API_KEY ausente");
  const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: "openai/gpt-6-astra",
      instructions: system,
      input: prompt,
      reasoning: { effort: "low" },
      store: false,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Lovable AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload) as { type?: string; delta?: string };
        if (event.type === "response.output_text.delta" && event.delta) text += event.delta;
      } catch {
        // frame parcial: ignora
      }
    }
  }
  if (!text.trim()) throw new Error("Lovable AI retornou resposta vazia.");
  return text.trim();
}

/**
 * Gera texto percorrendo o anel completo de 18 chaves com rotação e failover.
 * Nunca lança por causa de uma única chave: só desiste depois de esgotar
 * todas as chaves, todas as rodadas e também a IA de retaguarda.
 */
export async function generateAiText(
  system: string,
  prompt: string,
  options: AiTextOptions,
): Promise<AiTextResult> {
  const order = options.order ?? DEFAULT_ORDER;
  const opts = {
    maxTokens: options.maxTokens ?? 2500,
    temperature: options.temperature ?? 0.8,
  };
  const ebookId = options.ebookId ?? null;
  let lastError: unknown = null;
  let anyKey = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const provider of order) {
      const pool = poolOf(provider);
      if (pool.length === 0) continue;
      anyKey = true;

      const start = cursor[provider] % pool.length;
      cursor[provider] = (cursor[provider] + 1) % pool.length;

      for (let offset = 0; offset < pool.length; offset++) {
        const entry = pool[(start + offset) % pool.length]!;
        const cooldownKey = `${provider}:${entry.index}`;
        if ((cooldownUntil.get(cooldownKey) ?? 0) > Date.now()) continue;

        try {
          const text = await CALLERS[provider](entry.key, system, prompt, opts);
          cooldownUntil.delete(cooldownKey);
          await logKeyEvent(provider, entry.index, "success", options.stage, null, ebookId);
          return { text, provider, keyIndex: entry.index };
        } catch (error) {
          lastError = error;
          cooldownUntil.set(cooldownKey, Date.now() + COOLDOWN_MS);
          await logKeyEvent(
            provider,
            entry.index,
            "failover",
            options.stage,
            error instanceof Error ? error.message : String(error),
            ebookId,
          );
        }
      }
    }

    if (round < MAX_ROUNDS) {
      // As chaves disponíveis falharam nesta rodada: pausa técnica e recomeça.
      await sleep(TECHNICAL_PAUSE_MS);
      cooldownUntil.clear();
    }
  }

  // Retaguarda final para que a geração nunca trave.
  try {
    const text = await callLovable(system, prompt);
    await logKeyEvent("lovable", 0, "fallback", options.stage, null, ebookId);
    return { text, provider: "lovable", keyIndex: 0 };
  } catch (lovableError) {
    const base = anyKey
      ? `Todas as chaves configuradas falharam após ${MAX_ROUNDS} rodadas.`
      : "Nenhuma chave de texto configurada (Groq, Mistral ou Gemini).";
    throw new Error(
      `${base} Último erro: ${
        lastError instanceof Error ? lastError.message : String(lastError ?? "—")
      } | Retaguarda: ${
        lovableError instanceof Error ? lovableError.message : String(lovableError)
      }`,
    );
  }
}

/** Rótulo curto do provedor/chave usado, para mostrar no progresso. */
export function providerLabel(result: AiTextResult): string {
  if (result.provider === "lovable") return "IA de retaguarda";
  const name =
    result.provider === "groq" ? "Groq" : result.provider === "mistral" ? "Mistral" : "Gemini";
  return `${name} chave ${result.keyIndex}/6`;
}
