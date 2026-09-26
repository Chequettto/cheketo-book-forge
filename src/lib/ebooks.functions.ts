import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const CreateInput = z.object({
  title: z.string().min(2).max(160),
  subtitle: z.string().max(200).optional().default(""),
  author: z.string().min(2).max(120),
  niche: z.string().min(20).max(4000),
  coverPrompt: z.string().max(2000).optional().default(""),
  chaptersCount: z.number().int().min(1).max(20),
  pagesCount: z.number().int().min(5).max(300),
});

const EDITOR_SYSTEM =
  "Você é um escritor e editor profissional brasileiro de e-books de altíssimo padrão editorial. " +
  "Escreve em português do Brasil, com profundidade prática, exemplos concretos, dados aplicáveis e zero enrolação. " +
  "É terminantemente proibido usar frases de efeito vazias, repetições, autorreferências ('neste capítulo veremos...'), " +
  "clichês de IA e encheção de linguiça.";

const AUDITOR_SYSTEM =
  "Você é um revisor editorial implacável de livros brasileiros. Primeiro audita o texto com rigor, " +
  "apontando repetições cansativas, enrolação, falta de profundidade e desvios do tema. Em seguida reescreve " +
  "o texto eliminando esses defeitos, elevando o nível técnico e literário, sem inventar fatos e mantendo o tamanho aproximado. " +
  "Responde SEMPRE neste formato exato:\nCRITICA:\n<lista curta de defeitos>\nTEXTO:\n<texto final lapidado>";

/** Audita e lapida um bloco recém-escrito antes de salvá-lo. */
async function auditAndPolish(
  raw: string,
  context: string,
  ebookId: string,
): Promise<{ text: string; critique: string; source: string } | null> {
  try {
    const { generateAiText, providerLabel } = await import("./ai-text.server");
    const result = await generateAiText(
      AUDITOR_SYSTEM,
      `${context}\n\nTexto bruto a auditar e lapidar:\n"""\n${raw}\n"""`,
      { stage: "chapter_audit", ebookId, maxTokens: 3500, temperature: 0.4 },
    );
    const match = result.text.match(/CRITICA:\s*([\s\S]*?)\n\s*TEXTO:\s*([\s\S]+)/i);
    if (!match) return null;
    const critique = match[1].trim();
    const text = match[2].trim();
    if (text.split(/\s+/).length < 120) return null;
    return { text, critique, source: providerLabel(result) };
  } catch {
    // A auditoria nunca pode travar a produção: mantém o rascunho se falhar.
    return null;
  }
}

/** Cria o e-book e gera a estrutura (sumário) de capítulos. */
export const createEbook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: ebook, error } = await supabase
      .from("ebooks")
      .insert({
        user_id: userId,
        title: data.title,
        subtitle: data.subtitle || null,
        author: data.author,
        niche: data.niche,
        cover_prompt: data.coverPrompt || null,
        chapters_count: data.chaptersCount,
        pages_count: data.pagesCount,
        status: "outlining",
        progress: 2,
        progress_label: "Estruturando o sumário",
      })
      .select("id")
      .single();
    if (error || !ebook) throw new Error(error?.message ?? "Falha ao criar o e-book.");

    const { generateAiText, providerLabel } = await import("./ai-text.server");
    const result = await generateAiText(
      EDITOR_SYSTEM,
      `Crie o sumário de um e-book.
Título: ${data.title}
Subtítulo: ${data.subtitle}
Autor: ${data.author}
Tema/Nicho e objetivos: ${data.niche}
Meta de volume: ${data.pagesCount} páginas no total.

Retorne EXATAMENTE ${data.chaptersCount} títulos de capítulos, um por linha, numerados no formato "1. Título".
Cada título deve ser específico e progressivo (sem repetir ideias). Não escreva mais nada.`,
      { stage: "outline", ebookId: ebook.id, maxTokens: 2500 },
    );
    const raw = result.text;

    const titles = raw
      .split("\n")
      .map((line) =>
        line
          .replace(/^\s*\d+[.)-]\s*/, "")
          .replace(/[*#]/g, "")
          .trim(),
      )
      .filter(Boolean)
      .slice(0, data.chaptersCount);

    while (titles.length < data.chaptersCount) {
      titles.push(`Capítulo ${titles.length + 1}`);
    }

    const { error: chapterError } = await supabase.from("chapters").insert(
      titles.map((title, index) => ({
        ebook_id: ebook.id,
        user_id: userId,
        position: index + 1,
        title,
        content: "",
      })),
    );
    if (chapterError) throw new Error(chapterError.message);

    await supabase
      .from("ebooks")
      .update({
        status: "writing",
        progress: 5,
        progress_label: `Sumário pronto (${providerLabel(result)})`,
      })
      .eq("id", ebook.id);

    return {
      ebookId: ebook.id,
      titles,
      source: providerLabel(result),
      blocksPerChapter: blocksPerChapter(data.pagesCount, data.chaptersCount),
    };
  });

function limitWords(text: string, maxWords: number) {
  return text.trim().split(/\s+/).slice(0, maxWords).join(" ").trim();
}

/** Palavras-alvo de cada bloco: pequeno o bastante para nunca estourar tempo. */
const BLOCK_WORDS = 400;
const MAX_BLOCKS = 20;

/** Quantos blocos de ~400 palavras cada capítulo precisa para bater a meta. */
export function blocksPerChapter(pagesCount: number, chaptersCount: number): number {
  const wordsPerChapter = Math.max(1200, Math.round((pagesCount * 320) / Math.max(1, chaptersCount)));
  return Math.min(MAX_BLOCKS, Math.max(3, Math.ceil(wordsPerChapter / BLOCK_WORDS)));
}

export const generateChapter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        ebookId: z.string().uuid(),
        position: z.number().int().min(1),
        blockIndex: z.number().int().min(1).max(MAX_BLOCKS),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: ebook } = await supabase
      .from("ebooks")
      .select("*")
      .eq("id", data.ebookId)
      .single();
    if (!ebook) throw new Error("E-book não encontrado.");

    const { data: chapters } = await supabase
      .from("chapters")
      .select("position, title, content")
      .eq("ebook_id", data.ebookId)
      .order("position");
    const chapter = chapters?.find((item) => item.position === data.position);
    if (!chapter) throw new Error("Capítulo não encontrado.");

    const totalBlocks = blocksPerChapter(ebook.pages_count, ebook.chapters_count);
    const existingContent = chapter.content?.trim() ?? "";
    const currentWords = existingContent ? existingContent.split(/\s+/).length : 0;
    const maxWords = totalBlocks * BLOCK_WORDS;
    if (currentWords >= maxWords) {
      return {
        position: data.position,
        blockIndex: data.blockIndex,
        totalBlocks,
        words: currentWords,
        complete: true,
        source: "já concluído",
      };
    }

    const outline = (chapters ?? []).map((item) => `${item.position}. ${item.title}`).join("\n");
    const previousTail = existingContent.split(/\s+/).slice(-120).join(" ");
    const remainingWords = maxWords - currentWords;
    const isLastBlock = data.blockIndex >= totalBlocks || remainingWords <= BLOCK_WORDS;
    const { generateAiText, providerLabel } = await import("./ai-text.server");
    const result = await generateAiText(
      EDITOR_SYSTEM,
      `E-book: "${ebook.title}" — ${ebook.subtitle ?? ""}
Tema geral e objetivos: ${ebook.niche}

Sumário completo:
${outline}

Capítulo ${data.position}: "${chapter.title}"
Bloco atual: ${data.blockIndex} de ${totalBlocks}
Escreva SOMENTE este bloco, com aproximadamente ${BLOCK_WORDS} palavras (entre 350 e 450), desenvolvendo uma ideia nova e prática do capítulo.
Use subtítulos curtos, exemplos concretos e passos acionáveis. Não repita conteúdo anterior e não escreva uma conclusão genérica.
${previousTail ? `Últimas 120 palavras do bloco anterior, para manter a continuidade:\n${previousTail}` : "Este é o primeiro bloco; entre direto no tema."}

${isLastBlock ? `Este é o último bloco do capítulo: feche o raciocínio em no máximo ${Math.min(BLOCK_WORDS + 80, remainingWords)} palavras.\n` : ""}
Ao concluir logicamente o capítulo, acrescente exatamente [[CAPITULO_CONCLUIDO]] ao final da resposta.`,
      { stage: "chapter_block", ebookId: data.ebookId, maxTokens: 3000 },
    );

    const completedByMarker = /\[\[CAPITULO_CONCLUIDO\]\]/i.test(result.text);
    const draft = result.text.replace(/\[\[CAPITULO_CONCLUIDO\]\]/gi, "");

    // Auditoria crítica + lapidação do bloco antes de salvar (nunca bloqueia a produção).
    const polished = await auditAndPolish(
      draft,
      `E-book "${ebook.title}". Capítulo ${data.position}: "${chapter.title}". Tema: ${ebook.niche}`,
      data.ebookId,
    );
    const block = limitWords(
      polished?.text ?? draft,
      Math.min(BLOCK_WORDS + 120, remainingWords),
    );
    const combined = [existingContent, block].filter(Boolean).join("\n\n").trim();
    const totalWords = combined.split(/\s+/).filter(Boolean).length;
    const complete =
      completedByMarker || totalWords >= maxWords || data.blockIndex >= totalBlocks;
    const blockProgress =
      5 + ((data.position - 1 + data.blockIndex / totalBlocks) / ebook.chapters_count) * 80;
    const progress = Math.min(85, Math.round(blockProgress));
    const source = providerLabel(result);
    const previousAudit = chapter.audit_report?.trim() ?? "";
    const auditEntry = polished
      ? `Bloco ${data.blockIndex}/${totalBlocks} — auditado e lapidado (${polished.source}):\n${polished.critique}`
      : `Bloco ${data.blockIndex}/${totalBlocks} — auditoria indisponível, rascunho mantido.`;

    await supabase
      .from("chapters")
      .update({
        content: combined,
        audit_report: [previousAudit, auditEntry].filter(Boolean).join("\n\n"),
      })
      .eq("ebook_id", data.ebookId)
      .eq("position", data.position);
    await supabase
      .from("ebooks")
      .update({
        progress,
        progress_label: `Capítulo ${data.position} — bloco ${data.blockIndex}/${totalBlocks} (${source})`,
      })
      .eq("id", data.ebookId);

    return {
      position: data.position,
      blockIndex: data.blockIndex,
      totalBlocks,
      words: totalWords,
      progress,
      source,
      complete,
    };
  });


/** Gera a capa em alta resolução a partir da descrição visual do usuário. */
export const generateCover = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ ebookId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: ebook } = await supabase
      .from("ebooks")
      .select("*")
      .eq("id", data.ebookId)
      .single();
    if (!ebook) throw new Error("E-book não encontrado.");

    await supabase
      .from("ebooks")
      .update({ progress_label: "Renderizando a capa", progress: 88 })
      .eq("id", data.ebookId);

    const { generateCoverImage } = await import("./gemini.server");
    let cover: { bytes: Uint8Array; mimeType: string } | null = null;
    try {
      cover = await generateCoverImage(
        `Capa profissional de e-book em alta resolução, proporção vertical 2:3, qualidade editorial premium.
Título na capa: "${ebook.title}"${ebook.subtitle ? `\nSubtítulo: "${ebook.subtitle}"` : ""}
Autor: "${ebook.author}"
Direção visual pedida: ${ebook.cover_prompt || ebook.niche}
Tipografia legível e bem hierarquizada, composição limpa, sem marcas d'água.`,
        { stage: "cover", ebookId: data.ebookId },
      );
    } catch (error) {
      // A capa nunca derruba a geração: o e-book fica pronto mesmo sem imagem.
      await supabase
        .from("ebooks")
        .update({
          status: "ready",
          progress: 100,
          progress_label: "E-book pronto (capa indisponível)",
          error: error instanceof Error ? error.message.slice(0, 500) : "Falha na capa",
        })
        .eq("id", data.ebookId);
      return { path: null as string | null };
    }

    const path = `${userId}/${data.ebookId}.png`;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: uploadError } = await supabaseAdmin.storage
      .from("covers")
      .upload(path, cover.bytes, { contentType: cover.mimeType, upsert: true });
    if (uploadError) throw new Error(uploadError.message);

    await supabase
      .from("ebooks")
      .update({
        cover_url: path,
        status: "ready",
        progress: 100,
        progress_label: "E-book pronto",
      })
      .eq("id", data.ebookId);

    return { path: path as string | null };
  });

/** Usa uma imagem enviada pelo usuário como capa oficial do e-book. */
export const uploadCover = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        ebookId: z.string().uuid(),
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        base64: z.string().min(100),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: ebook } = await supabase
      .from("ebooks")
      .select("id")
      .eq("id", data.ebookId)
      .single();
    if (!ebook) throw new Error("E-book não encontrado.");

    const binary = Buffer.from(data.base64.replace(/^data:[^,]+,/, ""), "base64");
    if (binary.byteLength > 10 * 1024 * 1024) throw new Error("A imagem deve ter até 10 MB.");

    const ext =
      data.mimeType === "image/png" ? "png" : data.mimeType === "image/webp" ? "webp" : "jpg";
    const path = `${userId}/${data.ebookId}.${ext}`;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: uploadError } = await supabaseAdmin.storage
      .from("covers")
      .upload(path, binary, { contentType: data.mimeType, upsert: true });
    if (uploadError) throw new Error(uploadError.message);

    await supabase
      .from("ebooks")
      .update({
        cover_url: path,
        status: "ready",
        progress: 100,
        progress_label: "E-book pronto",
        error: null,
      })
      .eq("id", data.ebookId);

    return { path };
  });

/** Detalhes completos do e-book, com URL assinada da capa. */
export const getEbook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ ebookId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: ebook } = await supabase
      .from("ebooks")
      .select("*")
      .eq("id", data.ebookId)
      .single();
    if (!ebook) throw new Error("E-book não encontrado.");

    const { data: chapters } = await supabase
      .from("chapters")
      .select("position, title, content")
      .eq("ebook_id", data.ebookId)
      .order("position");

    let coverSignedUrl: string | null = null;
    if (ebook.cover_url) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: signed } = await supabaseAdmin.storage
        .from("covers")
        .createSignedUrl(ebook.cover_url, 60 * 60);
      coverSignedUrl = signed?.signedUrl ?? null;
    }

    return { ebook, chapters: chapters ?? [], coverSignedUrl };
  });

/** Lista os e-books do usuário. */
export const listEbooks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("ebooks")
      .select("id, title, subtitle, status, paid, progress, created_at")
      .order("created_at", { ascending: false });
    return data ?? [];
  });
