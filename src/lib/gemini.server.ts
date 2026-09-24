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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Erro HTTP do Gemini com o status code preservado (em vez de só texto). */
class GeminiApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
  }
}

// Conforme a doc oficial do Gemini (ai.google.dev/gemini-api/docs/troubleshooting):
// só vale a pena tentar de novo em erros transitórios — 429 (cota/rate limit),
// 408 (timeout) e 5xx (instabilidade do servidor). Um 400 (parâmetro ou modelo
// inválido) é um erro na própria requisição: falha igual em qualquer chave,
// então testar as 6 só demora mais pra dar o mesmo erro.
const RETRYABLE_STATUS = new Set([429, 408, 500, 502, 503, 504]);
// 401/403/402 indicam problema COM AQUELA CHAVE (revogada, sem permissão, sem
// crédito) — não adianta esperar, mas vale tentar a próxima chave, que pode
// ser válida.
const KEY_SPECIFIC_STATUS = new Set([401, 402, 403]);

/**
 * Executa `run` iniciando na chave atual da fila e avançando (1 -> 6) a cada
 * erro. Erros de cota/instabilidade (429/408/5xx) esperam com backoff
 * exponencial antes da próxima tentativa — igual ao SDK oficial do Gemini
 * (delay inicial ~1s, dobra a cada tentativa, teto de ~20s). Erro de chave
 * (401/403) troca de chave sem espera. Erro de requisição malformada (400,
 * 404) não faz sentido repetir em outra chave — falha na hora, com uma
 * mensagem clara, em vez de fingir que é "problema das 6 chaves".
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
      const status = error instanceof GeminiApiError ? error.status : undefined;
      const message = error instanceof Error ? error.message : String(error);
      await logKeyEvent(entry.index, "failover", options.stage, message, options.ebookId ?? null);

      if (status !== undefined && !RETRYABLE_STATUS.has(status) && !KEY_SPECIFIC_STATUS.has(status)) {
        throw new Error(
          `O Gemini recusou a requisição (erro ${status}) — não é problema de cota nem de chave, ` +
            `é a requisição em si (modelo, parâmetros ou formato). Testar outra chave não resolveria: ${message}`,
        );
      }

      if (attempt < keys.length - 1) {
        if (status === 429 || status === 408 || (status !== undefined && status >= 500)) {
          await sleep(Math.min(1000 * 2 ** attempt, 20000));
        } else {
          await sleep(300);
        }
      }
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
    throw new GeminiApiError(res.status, `Gemini ${res.status}: ${body.slice(0, 300)}`);
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
      throw new GeminiApiError(res.status, `Gemini Image ${res.status}: ${body.slice(0, 300)}`);
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
