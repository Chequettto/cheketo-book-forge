/**
 * Motor de chaves globais do Gemini com rotação e failover automático.
 * Server-only: nunca importe este módulo em código de browser.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const TEXT_MODEL = "gemini-3.6-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function getGlobalKeys(): { index: number; key: string }[] {
  const keys: { index: number; key: string }[] = [];
  for (let i = 1; i <= 6; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (key && key.trim()) keys.push({ index: i, key: key.trim() });
  }
  return keys;
}

// Ponteiro de início da fila, distribui a carga entre as chaves.
let cursor = 0;

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
      status,
      stage,
      message: message ? message.slice(0, 500) : null,
      ebook_id: ebookId,
    });
  } catch {
    // Log nunca pode derrubar a geração.
  }
}

type RotateOptions = { stage: string; ebookId?: string | null };

/**
 * Executa `run` iniciando na chave atual da fila e avançando (1 -> 6)
 * a cada erro de requisição, cota ou rate limit.
 */
async function withKeyRotation<T>(
  options: RotateOptions,
  run: (key: string) => Promise<T>,
): Promise<T> {
  const keys = getGlobalKeys();
  if (keys.length === 0) {
    throw new Error(
      "Nenhuma chave global do Gemini configurada (GEMINI_API_KEY_1 ... GEMINI_API_KEY_6).",
    );
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const entry = keys[(cursor + attempt) % keys.length]!;
    try {
      const result = await run(entry.key);
      if (attempt > 0) cursor = (cursor + attempt) % keys.length;
      await logKeyEvent(entry.index, "success", options.stage, null, options.ebookId ?? null);
      return result;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      await logKeyEvent(entry.index, "failover", options.stage, message, options.ebookId ?? null);
      // Próxima chave da sequência assume de forma transparente.
    }
  }
  throw new Error(
    `Todas as ${keys.length} chaves globais falharam. Último erro: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function callTextModel(key: string, system: string, prompt: string): Promise<string> {
  const res = await fetch(`${BASE}/${TEXT_MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.85, maxOutputTokens: 8192 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Resposta vazia do modelo.");
  return text;
}

export function generateText(
  system: string,
  prompt: string,
  options: RotateOptions,
): Promise<string> {
  return withKeyRotation(options, (key) => callTextModel(key, system, prompt));
}

/** Gera a imagem da capa. Retorna bytes PNG/JPEG. */
function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Gera a capa. Tenta as 6 chaves globais do Gemini e, se todas falharem
 * (cota de imagem indisponível na conta), usa a IA nativa da Lovable.
 */
export async function generateCoverImage(
  prompt: string,
  options: RotateOptions,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  try {
    return await generateCoverImageWithGemini(prompt, options);
  } catch (geminiError) {
    const fallbackKey = process.env["LOVABLE_API_KEY"];
    if (!fallbackKey) throw geminiError;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fallbackKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-image-2.5-sunburst",
        prompt,
        size: "1024x1536",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Capa indisponível. Gemini: ${
          geminiError instanceof Error ? geminiError.message : String(geminiError)
        } | Lovable AI ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { data?: { b64_json?: string }[] };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("A IA de imagem não retornou a capa.");
    return { bytes: base64ToBytes(b64), mimeType: "image/png" };
  }
}

function generateCoverImageWithGemini(
  prompt: string,
  options: RotateOptions,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  return withKeyRotation(options, async (key) => {
    const res = await fetch(
      `${BASE}/${IMAGE_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini Image ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      candidates?: {
        content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
      }[];
    };
    const part = (json.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    const data = part?.inlineData?.data;
    if (!data) throw new Error("O modelo não retornou imagem.");

    return { bytes: base64ToBytes(data), mimeType: part?.inlineData?.mimeType ?? "image/png" };
  });
}
