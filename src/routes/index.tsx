import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Brand, Header } from "@/components/Brand";
import { useAuth } from "@/hooks/useAuth";
import { BookOpen, Check, ScanSearch, Sparkles, Wand2 } from "lucide-react";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Chequetto — Gerador Automatizado de E-books com IA" },
      {
        name: "description",
        content:
          "Descreva o nicho e a Chequetto escreve, audita e lapida cada capítulo, gera a capa e entrega seu e-book em PDF e EPUB.",
      },
      { property: "og:title", content: "Chequetto — Gerador Automatizado de E-books com IA" },
      {
        property: "og:description",
        content:
          "E-books completos com auditoria editorial automática, capa em alta resolução e download em PDF e EPUB.",
      },
    ],
  }),
  component: Landing,
});

const steps = [
  {
    icon: Wand2,
    title: "Rascunho bruto",
    text: "A IA escreve o capítulo a partir do seu nicho, dos objetivos e da meta de volume.",
  },
  {
    icon: ScanSearch,
    title: "Auditoria implacável",
    text: "O texto volta para o modelo como revisor editorial: caça repetições, enrolação e desvios.",
  },
  {
    icon: Sparkles,
    title: "Lapidação final",
    text: "O capítulo é reescrito corrigindo tudo que a auditoria apontou, antes de ser salvo.",
  },
];

function Landing() {
  const { session } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!session) return;
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem("chequetto:next");
      sessionStorage.removeItem("chequetto:next");
    } catch {
      /* ignore */
    }
    if (pending && pending.startsWith("/")) navigate({ to: pending });
  }, [session, navigate]);

  return (

    <div className="min-h-screen hero-surface">
      <Header />

      <main className="mx-auto max-w-6xl px-5">
        <section className="py-20 text-center md:py-28">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-1.5 text-xs tracking-wide text-muted-foreground uppercase">
            <Sparkles className="size-3.5 text-primary" /> Gerador automatizado de e-books
          </p>
          <h1 className="mx-auto max-w-4xl text-4xl leading-tight font-semibold md:text-6xl">
            Do nicho ao e-book pronto, <span className="text-gold">sem enrolação</span>.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-muted-foreground md:text-lg">
            A <Brand size="sm" /> escreve, lê criticamente e reescreve cada capítulo até atingir
            padrão editorial — depois gera a capa e entrega tudo em PDF e EPUB.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link to="/criar" className="btn-gold hover:btn-gold-hover px-7 py-3 text-base">
              Criar meu e-book
            </Link>
            <Link
              to="/painel"
              className="rounded-lg border border-border px-7 py-3 text-base text-foreground transition-colors hover:bg-card"
            >
              Ver meus e-books
            </Link>
          </div>
        </section>

        <section className="grid gap-5 pb-20 md:grid-cols-3">
          {steps.map((step) => (
            <article key={step.title} className="panel p-6">
              <step.icon className="mb-4 size-6 text-primary" />
              <h3 className="text-lg font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.text}</p>
            </article>
          ))}
        </section>

        <section className="grid gap-5 pb-24 md:grid-cols-2">
          <article className="panel p-8">
            <h2 className="text-2xl font-semibold">Plano Mensal</h2>
            <p className="mt-1 text-sm text-muted-foreground">Assinatura recorrente</p>
            <p className="mt-6 text-4xl font-semibold">
              R$ 99<span className="text-base text-muted-foreground">/mês</span>
            </p>
            <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
              {["E-books ilimitados enquanto ativo", "Capa gerada por IA", "PDF e EPUB"].map((i) => (
                <li key={i} className="flex items-center gap-2">
                  <Check className="size-4 text-primary" /> {i}
                </li>
              ))}
            </ul>
          </article>
          <article className="panel p-8" style={{ boxShadow: "var(--shadow-glow)" }}>
            <h2 className="text-2xl font-semibold">Plano Vitalício</h2>
            <p className="mt-1 text-sm text-muted-foreground">Pagamento único</p>
            <p className="mt-6 text-4xl font-semibold">R$ 299</p>
            <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
              {["Acesso para sempre", "Sem mensalidade", "Todos os formatos de download"].map(
                (i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Check className="size-4 text-primary" /> {i}
                  </li>
                ),
              )}
            </ul>
          </article>
        </section>
      </main>

      <footer className="border-t border-border/70 py-8 text-center text-sm text-muted-foreground">
        <BookOpen className="mx-auto mb-2 size-4 text-primary" />
        Chequetto — e-books com padrão editorial.
      </footer>
    </div>
  );
}
