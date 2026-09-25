import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const KEY_COUNT = 6;
const FAILURE_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 6;

export type GroqCallOptions = {
  stage: string;
  ebookId?: string | null;
};

export type GroqTextResult = {
  text: string;
  keyIndex: number;
};

class GroqApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GroqApiError";
    this.status = status;
  }
}

let cursor = 0;
const unavailableUntil = new Map<number, number>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGroqKeys(): { index: number; key: string }[] {
  const keys: { index: number; key: string }[] = [];
  for (let index = 1; index <= KEY_COUNT; index++) {
    const key = process.env[`GROQ_API_KEY_${index}`]?.trim();
    if (key) keys.push({ index, key });
  }
  return keys;
}

async function logKeyEvent(
  keyIndex: number,
  status: string,
  stage: string,
  message: string | null,
  ebookId: string | null,
) {
  try {
    await supabaseAdmin.from("api_key_events").insert({
      key_index: keyIndex,
      status: `groq_${status}`,
      stage,
      message: message ? message.slice(0, 500) : null,
      ebook_id: ebookId,
    });
  } catch {
    // O registro de telemetria nunca pode interromper a geração.
  }
}

function nextAvailableKey(keys: { index: number; key: string }[]) {
  const now = Date.now();
  for (let offset = 0; offset < keys.length; offset++) {
    const position = (cursor + offset) % keys.length;
    const entry = keys[position]!;
    if ((unavailableUntil.get(entry.index) ?? 0) <= now) return { entry, position };
  }
  return null;
}

async function callGroq(key: string, system: string, prompt: string): Promise<string> {
  const response = await fetch(BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 0.78,
      max_tokens: 1800,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new GroqApiError(response.status, `Groq ${response.status}: ${body.slice(0, 300)}`);
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("A Groq retornou uma resposta vazia.");
  return text;
}

/** Retaguarda: usa as 6 chaves do Gemini quando a Groq não está disponível. */
async function fallbackToGemini(
  system: string,
  prompt: string,
  options: GroqCallOptions,
  reason: string,
): Promise<GroqTextResult> {
  const { generateGeminiText } = await import("./gemini.server");
  try {
    const result = await generateGeminiText(system, prompt, {
      stage: `${options.stage}_fallback_gemini`,
      ebookId: options.ebookId ?? null,
    });
    return { text: result.text, keyIndex: result.keyIndex };
  } catch (geminiError) {
    // Última retaguarda: IA da Lovable, para a geração nunca travar.
    try {
      const text = await generateLovableText(system, prompt);
      await logKeyEvent(0, "lovable_fallback", options.stage, null, options.ebookId ?? null);
      return { text, keyIndex: 0 };
    } catch (lovableError) {
      throw new Error(
        `${reason} | Gemini: ${
          geminiError instanceof Error ? geminiError.message.slice(0, 200) : String(geminiError)
        } | Lovable AI: ${lovableError instanceof Error ? lovableError.message : String(lovableError)}`,
      );
    }
  }
}

async function generateLovableText(system: string, prompt: string): Promise<string> {
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
    throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  if (!text.trim()) throw new Error("resposta vazia");
  return text.trim();
}

export async function generateGroqText(
  system: string,
  prompt: string,
  options: GroqCallOptions,
): Promise<GroqTextResult> {
  const keys = getGroqKeys();
  if (keys.length === 0) {
    return fallbackToGemini(system, prompt, options, "Nenhuma chave Groq configurada");
  }

  let lastError: unknown = null;
  for (let retryRound = 0; retryRound < 2; retryRound++) {
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      const selected = nextAvailableKey(keys);
      if (!selected) break;

      const { entry, position } = selected;
      attempts++;
      try {
        const text = await callGroq(entry.key, system, prompt);
        cursor = (position + 1) % keys.length;
        unavailableUntil.delete(entry.index);
        await logKeyEvent(entry.index, "success", options.stage, null, options.ebookId ?? null);
        return { text, keyIndex: entry.index };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        unavailableUntil.set(entry.index, Date.now() + FAILURE_COOLDOWN_MS);
        await logKeyEvent(entry.index, "failover", options.stage, message, options.ebookId ?? null);
        cursor = (position + 1) % keys.length;
      }
    }

    if (retryRound === 0) {
      await sleep(2_000);
      unavailableUntil.clear();
    }
  }

  return fallbackToGemini(
    system,
    prompt,
    options,
    `As ${keys.length} chaves Groq falharam. Último erro: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
