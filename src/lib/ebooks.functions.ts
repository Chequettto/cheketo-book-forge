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

    const { generateText } = await import("./gemini.server");
    const raw = await generateText(
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

    const titles = raw
      .split("\n")
      .map((line) => line.replace(/^\s*\d+[\.\)-]\s*/, "").replace(/[*#]/g, "").trim())
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
      .update({ status: "writing", progress: 5, progress_label: "Sumário pronto" })
      .eq("id", ebook.id);

    return { ebookId: ebook.id, titles };
  });

/**
 * Pipeline anti-enrolação de um capítulo:
 * 1. rascunho bruto -> 2. auditoria crítica -> 3. reescrita lapidada.
 */
export const generateChapter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ ebookId: z.string().uuid(), position: z.number().int().min(1) }).parse(input),
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
      .select("position, title, content, audit_report")
      .eq("ebook_id", data.ebookId)
      .order("position");
    const chapter = chapters?.find((c) => c.position === data.position);
    if (!chapter) throw new Error("Capítulo não encontrado.");

    // Já foi escrito, auditado e lapidado numa tentativa anterior: não reescreve
    // do zero, só confirma o progresso e retorna — isso é o que permite retomar
    // uma geração que travou no meio sem gastar de novo os capítulos prontos.
    if (chapter.content && chapter.audit_report) {
      const progress = Math.round(5 + (data.position / ebook.chapters_count) * 80);
      await supabase
        .from("ebooks")
        .update({ progress, progress_label: `Capítulo ${data.position} já estava pronto` })
        .eq("id", data.ebookId);
      return {
        position: data.position,
        words: chapter.content.split(/\s+/).length,
        progress,
        skipped: true,
      };
    }

    const outline = (chapters ?? []).map((c) => `${c.position}. ${c.title}`).join("\n");
    const alreadyWritten = (chapters ?? [])
      .filter((c) => c.position < data.position && c.content)
      .map((c) => `${c.title}: ${c.content.slice(0, 600)}`)
      .join("\n---\n");

    const wordsTarget = Math.max(
      600,
      Math.round((ebook.pages_count * 320) / Math.max(1, ebook.chapters_count)),
    );

    const { generateText } = await import("./gemini.server");

    // 1. Rascunho bruto
    const draft = await generateText(
      EDITOR_SYSTEM,
      `E-book: "${ebook.title}" — ${ebook.subtitle ?? ""}
Autor: ${ebook.author}
Tema e objetivos: ${ebook.niche}

Sumário completo:
${outline}

${alreadyWritten ? `Resumo do que já foi escrito (NÃO repita):\n${alreadyWritten}` : ""}

Escreva o capítulo ${data.position}: "${chapter.title}".
Extensão alvo: aproximadamente ${wordsTarget} palavras.
Use subtítulos curtos, exemplos práticos, passos acionáveis e, quando fizer sentido, listas objetivas.
Não escreva título do e-book nem conclusão genérica. Comece direto pelo conteúdo do capítulo.`,
      { stage: "draft", ebookId: data.ebookId },
    );

    // Salva o rascunho imediatamente: se a auditoria ou a reescrita falharem
    // depois (ex. cota do Gemini), o capítulo não fica em branco — o rascunho
    // já está no banco e a tentativa seguinte não perde esse trabalho.
    await supabase
      .from("chapters")
      .update({ content: draft.trim() })
      .eq("ebook_id", data.ebookId)
      .eq("position", data.position);

    // 2. Autocrítica + reescrita num único passe (era auditoria + reescrita em
    // 2 chamadas separadas — juntar num só corte reduz de 3 para 2 chamadas
    // ao Gemini por capítulo, o que reduz proporcionalmente o risco de bater
    // no limite de cota das 6 chaves globais no meio da geração).
    const revisionRaw = await generateText(
      "Você é um revisor editorial implacável, especialista em não-ficção prática, e reescreve o texto você mesmo depois de apontar as falhas.",
      `Leia o rascunho abaixo do capítulo "${chapter.title}" do e-book "${ebook.title}" (${ebook.niche}).

Primeiro, em até 5 linhas, aponte os problemas reais: repetições, enrolação, falta de exemplos concretos, desvio do tema, ritmo.
Depois, na mesma resposta, reescreva o capítulo INTEIRO corrigindo esses problemas, aprofundando tecnicamente,
mantendo aproximadamente ${wordsTarget} palavras e preservando o tema "${chapter.title}".

RASCUNHO:
"""${draft}"""

Retorne EXATAMENTE neste formato, sem nada antes ou depois:
CRÍTICA:
<crítica em até 5 linhas>
---CAPÍTULO FINAL---
<capítulo final revisado, começando direto pelo conteúdo>`,
      { stage: "revise", ebookId: data.ebookId },
    );

    const marker = /---CAP[IÍ]TULO FINAL---/i;
    const [rawCritique, rawFinal] = revisionRaw.split(marker);
    const audit = (rawCritique ?? "").replace(/^CR[IÍ]TICA:\s*/i, "").trim() || "Revisado sem observações.";
    // Se o modelo não seguir o formato à risca, usa a resposta inteira como
    // capítulo em vez de descartar o trabalho já pago/gerado.
    const polished = (rawFinal ?? revisionRaw).trim();

    await supabase
      .from("chapters")
      .update({ content: polished.trim(), audit_report: audit })
      .eq("ebook_id", data.ebookId)
      .eq("position", data.position);

    const progress = Math.round(5 + (data.position / ebook.chapters_count) * 80);
    await supabase
      .from("ebooks")
      .update({
        progress,
        progress_label: `Capítulo ${data.position} revisado e lapidado`,
      })
      .eq("id", data.ebookId);

    return { position: data.position, words: polished.split(/\s+/).length, progress };
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

    const ext = data.mimeType === "image/png" ? "png" : data.mimeType === "image/webp" ? "webp" : "jpg";
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
