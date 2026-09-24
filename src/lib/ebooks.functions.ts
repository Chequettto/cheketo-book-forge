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

    const { generateGroqText } = await import("./groq.server");
    const result = await generateGroqText(
      EDITOR_SYSTEM,
      `Crie o sumário de um e-book.
Título: ${data.title}
Subtítulo: ${data.subtitle}
Autor: ${data.author}
Tema/Nicho e objetivos: ${data.niche}
Meta de volume: ${data.pagesCount} páginas no total.

Retorne EXATAMENTE ${data.chaptersCount} títulos de capítulos, um por linha, numerados no formato "1. Título".
Cada título deve ser específico e progressivo (sem repetir ideias). Não escreva mais nada.`,
      { stage: "outline", ebookId: ebook.id },
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
        progress_label: `Gerando Sumário do E-book (Groq Chave ${result.keyIndex}/6)...`,
      })
      .eq("id", ebook.id);

    return { ebookId: ebook.id, titles, keyIndex: result.keyIndex };
  });

function limitWords(text: string, maxWords: number) {
  return text.trim().split(/\s+/).slice(0, maxWords).join(" ").trim();
}

export const generateChapter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        ebookId: z.string().uuid(),
        position: z.number().int().min(1),
        blockIndex: z.number().int().min(1).max(6),
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

    const existingContent = chapter.content?.trim() ?? "";
    const currentWords = existingContent ? existingContent.split(/\s+/).length : 0;
    const maxWords = 4000;
    if (currentWords >= maxWords) {
      return {
        position: data.position,
        blockIndex: data.blockIndex,
        words: currentWords,
        complete: true,
        keyIndex: 0,
      };
    }

    const outline = (chapters ?? []).map((item) => `${item.position}. ${item.title}`).join("\n");
    const previousTail = existingContent.split(/\s+/).slice(-150).join(" ");
    const remainingWords = maxWords - currentWords;
    const { generateGroqText } = await import("./groq.server");
    const result = await generateGroqText(
      EDITOR_SYSTEM,
      `E-book: "${ebook.title}" — ${ebook.subtitle ?? ""}
Tema geral e objetivos: ${ebook.niche}

Sumário completo:
${outline}

Capítulo ${data.position}: "${chapter.title}"
Sub-bloco atual: ${data.blockIndex} de 6
Escreva somente o próximo sub-bloco, com 600 a 800 palavras, desenvolvendo uma ideia nova e prática do capítulo.
Use subtítulos curtos, exemplos concretos e passos acionáveis. Não repita conteúdo anterior e não use uma conclusão genérica.
${previousTail ? `Últimas 150 palavras do sub-bloco anterior para manter a continuidade:\n${previousTail}` : "Este é o primeiro sub-bloco; introduza o tema diretamente."}

${remainingWords <= 800 ? `Este é o último espaço disponível. Escreva no máximo ${remainingWords} palavras e finalize o capítulo.\n` : ""}
Ao concluir logicamente o capítulo, acrescente exatamente [[CAPITULO_CONCLUIDO]] ao final da resposta.`,
      { stage: "chapter_block", ebookId: data.ebookId },
    );

    const completedByMarker = /\[\[CAPITULO_CONCLUIDO\]\]/i.test(result.text);
    const block = limitWords(
      result.text.replace(/\[\[CAPITULO_CONCLUIDO\]\]/gi, ""),
      Math.min(800, remainingWords),
    );
    const combined = [existingContent, block].filter(Boolean).join("\n\n").trim();
    const totalWords = combined.split(/\s+/).filter(Boolean).length;
    const complete = completedByMarker || totalWords >= maxWords || data.blockIndex >= 6;
    const progress = Math.round(5 + (data.position / ebook.chapters_count) * 80);

    await supabase
      .from("chapters")
      .update({
        content: combined,
        audit_report: complete ? "Concluído pela geração fracionada da Groq." : null,
      })
      .eq("ebook_id", data.ebookId)
      .eq("position", data.position);
    await supabase
      .from("ebooks")
      .update({
        progress,
        progress_label: `Escrevendo Capítulo ${data.position} - Sub-bloco ${data.blockIndex}/6 (Groq Chave ${result.keyIndex}/6)...`,
      })
      .eq("id", data.ebookId);

    return {
      position: data.position,
      blockIndex: data.blockIndex,
      words: totalWords,
      progress,
      keyIndex: result.keyIndex,
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
