import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Header } from "@/components/Brand";
import { useAuth } from "@/hooks/useAuth";
import { createEbook, generateChapter, generateCover, uploadCover } from "@/lib/ebooks.functions";

export const Route = createFileRoute("/criar")({
  head: () => ({
    meta: [
      { title: "Criar e-book — Chequetto" },
      {
        name: "description",
        content: "Preencha título, nicho, capa e volume: a Chequetto escreve e revisa tudo.",
      },
      { property: "og:title", content: "Criar e-book — Chequetto" },
      { property: "og:description", content: "Gere um e-book completo com IA em minutos." },
    ],
  }),
  component: CreatePage,
});

type Step = { label: string; done: boolean };

function CreatePage() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const runCreate = useServerFn(createEbook);
  const runChapter = useServerFn(generateChapter);
  const runCover = useServerFn(generateCover);
  const runUploadCover = useServerFn(uploadCover);

  const [form, setForm] = useState({
    title: "",
    subtitle: "",
    author: "",
    niche: "",
    coverPrompt: "",
    chaptersCount: 6,
    pagesCount: 40,
  });
  const [coverMode, setCoverMode] = useState<"ai" | "upload">("ai");
  const [coverFile, setCoverFile] = useState<{ base64: string; mimeType: string } | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [current, setCurrent] = useState("");
  // Guarda o e-book em andamento quando a geração falha no meio, pra "Retomar"
  // não precisar chamar createEbook de novo nem reescrever capítulos prontos.
  const [resumable, setResumable] = useState<{ ebookId: string; titles: string[] } | null>(null);


  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", search: { next: "/criar" } });
  }, [loading, session, navigate]);

  function pickCover(file: File | null) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error("A imagem deve ter até 10 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      setCoverFile({ base64: result, mimeType: file.type });
      setCoverPreview(result);
    };
    reader.readAsDataURL(file);
  }

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }


  /**
   * Roda os capítulos + capa de um e-book já criado. Capítulos que já têm
   * conteúdo e auditoria prontos de uma tentativa anterior são pulados no
   * servidor (generateChapter detecta isso sozinho) — então chamar isso de
   * novo depois de uma falha não reescreve do zero, só continua de onde parou.
   */
  async function runPipeline(ebookId: string, titles: string[]) {
    setSteps(titles.map((label) => ({ label, done: false })));

    for (let position = 1; position <= titles.length; position++) {
      setCurrent(`Escrevendo, auditando e lapidando o capítulo ${position}…`);
      try {
        await runChapter({ data: { ebookId, position } });
      } catch {
        // Uma falha isolada (ex. pico de cota nas 6 chaves) não deve derrubar
        // o e-book inteiro: espera um pouco e tenta esse capítulo mais uma vez
        // antes de desistir de verdade.
        setCurrent(`Capítulo ${position} deu erro, tentando novamente…`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await runChapter({ data: { ebookId, position } });
      }
      setSteps((prev) => prev.map((s, i) => (i === position - 1 ? { ...s, done: true } : s)));
      // Espaço entre capítulos: evita empilhar 3 chamadas ao Gemini por
      // capítulo de forma tão rápida que todas as 6 chaves caem juntas.
      if (position < titles.length) await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    if (coverMode === "upload" && coverFile) {
      setCurrent("Aplicando a capa enviada…");
      await runUploadCover({
        data: { ebookId, base64: coverFile.base64, mimeType: coverFile.mimeType as "image/png" },
      });
    } else {
      setCurrent("Renderizando a capa em alta resolução…");
      await runCover({ data: { ebookId } });
    }

    toast.success("E-book gerado com sucesso.");
    navigate({ to: "/ebook/$id", params: { id: ebookId } });
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (form.niche.trim().length < 20) {
      toast.error("Descreva o nicho com pelo menos 20 caracteres.");
      return;
    }
    setRunning(true);
    setSteps([]);
    setResumable(null);
    let created: { ebookId: string; titles: string[] } | null = null;
    try {
      setCurrent("Estruturando o sumário…");
      created = await runCreate({ data: form });
      await runPipeline(created.ebookId, created.titles);
    } catch (error) {
      if (created) setResumable(created);
      toast.error(error instanceof Error ? error.message : "Falha na geração.");
      setRunning(false);
      setCurrent("");
    }
  }

  async function resume() {
    if (!resumable) return;
    setRunning(true);
    try {
      await runPipeline(resumable.ebookId, resumable.titles);
      setResumable(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao retomar a geração.");
      setRunning(false);
      setCurrent("");
    }
  }

  if (running) {
    return (
      <div className="hero-surface min-h-screen">
        <Header />
        <main className="mx-auto max-w-2xl px-5 py-20">
          <div className="panel p-8 text-center">
            <div className="mx-auto mb-6 size-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <h1 className="text-2xl font-semibold">Chequetto está produzindo seu e-book</h1>
            <p className="mt-3 text-sm text-muted-foreground">{current}</p>
            <ul className="mt-8 space-y-2 text-left text-sm">
              {steps.map((step, index) => (
                <li
                  key={index}
                  className={`flex items-center gap-3 rounded-lg border border-border/60 px-4 py-2.5 ${
                    step.done ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <span
                    className={`size-2 rounded-full ${step.done ? "bg-primary" : "bg-border"}`}
                  />
                  {index + 1}. {step.label}
                </li>
              ))}
            </ul>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="hero-surface min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-5 py-12">
        <h1 className="text-3xl font-semibold md:text-4xl">Painel de criação</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Quanto mais específico o nicho, melhor o resultado editorial.
        </p>

        {resumable && (
          <div className="panel mt-6 flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-muted-foreground">
              A última geração parou no meio. Os capítulos já prontos não serão reescritos —
              só o que faltou continua.
            </p>
            <button
              onClick={resume}
              className="btn-gold hover:btn-gold-hover shrink-0 px-5 py-2.5 text-sm"
            >
              Retomar geração
            </button>
          </div>
        )}

        <form onSubmit={generate} className="panel mt-8 space-y-5 p-7">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Título do e-book">
              <input
                className="field focus:field-focus"
                value={form.title}
                onChange={(e) => update("title", e.target.value)}
                required
                placeholder="Tráfego pago sem desperdício"
              />
            </Field>
            <Field label="Subtítulo">
              <input
                className="field focus:field-focus"
                value={form.subtitle}
                onChange={(e) => update("subtitle", e.target.value)}
                placeholder="O método de campanhas lucrativas"
              />
            </Field>
          </div>

          <Field label="Nome do autor">
            <input
              className="field focus:field-focus"
              value={form.author}
              onChange={(e) => update("author", e.target.value)}
              required
              placeholder="Sandro Chequetto"
            />
          </Field>

          <Field label="Descrição do nicho / conteúdo">
            <textarea
              className="field focus:field-focus min-h-40 resize-y"
              value={form.niche}
              onChange={(e) => update("niche", e.target.value)}
              required
              placeholder="Tema, objetivo, público-alvo e os pontos centrais que devem ser abordados."
            />
          </Field>

          <div className="rounded-xl border border-border/60 p-4">
            <span className="mb-3 block text-sm font-medium text-muted-foreground">Capa</span>
            <div className="mb-4 flex gap-2">
              <button
                type="button"
                onClick={() => setCoverMode("ai")}
                className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                  coverMode === "ai" ? "border-primary text-primary" : "border-border"
                }`}
              >
                Gerar com IA
              </button>
              <button
                type="button"
                onClick={() => setCoverMode("upload")}
                className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                  coverMode === "upload" ? "border-primary text-primary" : "border-border"
                }`}
              >
                Enviar minha imagem
              </button>
            </div>

            {coverMode === "ai" ? (
              <textarea
                className="field focus:field-focus min-h-28 resize-y"
                value={form.coverPrompt}
                onChange={(e) => update("coverPrompt", e.target.value)}
                placeholder="Estilo, cores, elementos visuais e clima desejado para a capa."
              />
            ) : (
              <div className="flex items-center gap-4">
                <input
                  id="cover-file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => pickCover(e.target.files?.[0] ?? null)}
                />
                <label
                  htmlFor="cover-file"
                  className="cursor-pointer rounded-lg border border-border px-5 py-2.5 text-sm transition-colors hover:bg-card"
                >
                  Escolher imagem
                </label>
                {coverPreview ? (
                  <img
                    src={coverPreview}
                    alt="Prévia da capa enviada"
                    className="h-24 w-16 rounded-md border border-border object-cover"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    PNG, JPG ou WebP, até 10 MB.
                  </span>
                )}
              </div>
            )}
          </div>


          <div className="grid gap-5 md:grid-cols-2">
            <Field label={`Quantidade de capítulos: ${form.chaptersCount}`}>
              <input
                type="number"
                min={1}
                max={20}
                className="field focus:field-focus"
                value={form.chaptersCount}
                onChange={(e) => update("chaptersCount", Number(e.target.value))}
              />
            </Field>
            <Field label={`Meta de páginas: ${form.pagesCount}`}>
              <input
                type="number"
                min={5}
                max={300}
                className="field focus:field-focus"
                value={form.pagesCount}
                onChange={(e) => update("pagesCount", Number(e.target.value))}
              />
            </Field>
          </div>

          <button type="submit" className="btn-gold hover:btn-gold-hover w-full py-3.5 text-base">
            Gerar e-book completo
          </button>
          <p className="text-center text-xs text-muted-foreground">
            A geração pode levar alguns minutos: cada capítulo passa por escrita, auditoria e
            reescrita.
          </p>
        </form>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
