/**
 * Motor de chaves globais do Mistral com rotação e failover automático.
 * Usado como retaguarda quando Groq e Gemini estão indisponíveis.
 * Server-only: nunca importe este módulo em código de browser.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "https://api.mistral.ai/v1/chat/completions";
const MODEL = "mistral-small-latest";

export function getMistralKeys(): { index: number; key: string }[] {
  const keys: { index: number; key: string }[] = [];
  for (let i = 1; i <= 6; i++) {
    const key = process.env[`MISTRAL_API_KEY_${i}`];
    if (key && key.trim()) keys.push({ index: i, key: key.trim() });
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
      status: `mistral_${status}`,
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

class MistralApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MistralApiError";
    this.status = status;
  }
}

/**
 * Geração de texto pelo Mistral com rotação das 6 chaves globais.
 * Usada como segunda retaguarda: Groq -> Gemini -> Mistral -> Lovable AI.
 */
export async function generateMistralText(
  system: string,
  prompt: string,
  options: RotateOptions,
): Promise<{ text: string; keyIndex: number }> {
  const keys = getMistralKeys();
  if (keys.length === 0) {
    throw new Error("Nenhuma chave global do Mistral configurada (MISTRAL_API_KEY_1 ... MISTRAL_API_KEY_6).");
  }

  let lastError: unknown = null;
  for (const entry of keys) {
    try {
      const res = await fetch(BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${entry.key}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          temperature: 0.8,
          max_tokens: 4096,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new MistralApiError(res.status, `Mistral ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
      };
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("O Mistral retornou uma resposta vazia.");
      await logKeyEvent(entry.index, "success", options.stage, null, options.ebookId ?? null);
      return { text, keyIndex: entry.index };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      await logKeyEvent(entry.index, "failover", options.stage, message, options.ebookId ?? null);
      await sleep(300);
    }
  }

  throw new Error(
    `Todas as ${keys.length} chaves do Mistral falharam. Último erro: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
