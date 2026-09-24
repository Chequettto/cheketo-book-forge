import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, Lock } from "lucide-react";
import { Header } from "@/components/Brand";
import { useAuth } from "@/hooks/useAuth";
import { getEbook } from "@/lib/ebooks.functions";
import { createCheckout, getAccess } from "@/lib/payments.functions";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/ebook/$id")({
  head: () => ({
    meta: [
      { title: "Seu e-book — Chequetto" },
      {
        name: "description",
        content: "Prévia do e-book gerado, escolha do plano e download em PDF ou EPUB.",
      },
      { property: "og:title", content: "Seu e-book — Chequetto" },
      { property: "og:description", content: "Prévia, checkout e download do seu e-book." },
    ],
  }),
  component: EbookPage,
});

function EbookPage() {
  const { id } = useParams({ from: "/ebook/$id" });
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const fetchEbook = useServerFn(getEbook);
  const fetchAccess = useServerFn(getAccess);
  const startCheckout = useServerFn(createCheckout);

  const [plan, setPlan] = useState<"monthly" | "lifetime">("lifetime");
  const [payer, setPayer] = useState({ name: "", email: "", cpfCnpj: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", search: { next: `/ebook/${id}` } });
  }, [loading, session, navigate, id]);

  useEffect(() => {
    if (session?.user.email) setPayer((p) => ({ ...p, email: p.email || session.user.email! }));
  }, [session]);

  const ebookQuery = useQuery({
    queryKey: ["ebook", id],
    queryFn: () => fetchEbook({ data: { ebookId: id } }),
    enabled: !!session,
  });

  const accessQuery = useQuery({
    queryKey: ["access", id],
    queryFn: () => fetchAccess({ data: { ebookId: id } }),
    enabled: !!session,
    refetchInterval: 15000,
  });

  async function pay() {
    if (!payer.name || !payer.email || payer.cpfCnpj.replace(/\D/g, "").length < 11) {
      toast.error("Preencha nome, e-mail e CPF/CNPJ.");
      return;
    }
    setBusy(true);
    try {
      const { checkoutUrl } = await startCheckout({ data: { ebookId: id, plan, ...payer } });
      if (!checkoutUrl) throw new Error("Link de pagamento indisponível.");
      window.location.href = checkoutUrl;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao abrir o checkout.");
      setBusy(false);
    }
  }

  async function download(format: "pdf" | "epub") {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const res = await fetch(`/api/download/${id}/${format}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      toast.error(res.status === 402 ? "Pagamento ainda não confirmado." : "Falha no download.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${ebookQuery.data?.ebook.title ?? "ebook"}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const ebook = ebookQuery.data?.ebook;
  const unlocked = accessQuery.data?.unlocked === true;

  return (
    <div className="hero-surface min-h-screen">
      <Header />
      <main className="mx-auto max-w-5xl px-5 py-12">
        {ebookQuery.isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}

        {ebook && (
          <>
            <div className="grid gap-8 md:grid-cols-[260px_1fr]">
              <div>
                {ebookQuery.data?.coverSignedUrl ? (
                  <img
                    src={ebookQuery.data.coverSignedUrl}
                    alt={`Capa do e-book ${ebook.title}`}
                    className="w-full rounded-xl border border-border"
                    style={{ boxShadow: "var(--shadow-panel)" }}
                  />
                ) : (
                  <div className="panel flex aspect-2/3 items-center justify-center text-sm text-muted-foreground">
                    Capa em processamento
                  </div>
                )}
              </div>

              <div>
                <h1 className="text-3xl font-semibold md:text-4xl">{ebook.title}</h1>
                {ebook.subtitle && <p className="mt-2 text-muted-foreground">{ebook.subtitle}</p>}
                <p className="mt-4 text-sm text-muted-foreground">por {ebook.author}</p>

                <div className="mt-8">
                  {accessQuery.data?.freeFirstEbook && (
                    <p className="mb-3 text-sm text-primary">
                      Cortesia: este é o seu primeiro e-book, download liberado.
                    </p>
                  )}
                  {!unlocked && accessQuery.data && !accessQuery.data.freeFirstEbook && (
                    <p className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
                      <Lock className="size-4 text-primary" /> A partir do 2º e-book, o download
                      é liberado depois do pagamento (plano abaixo).
                    </p>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={() => download("pdf")}
                      className="btn-gold hover:btn-gold-hover inline-flex items-center gap-2 px-6 py-3"
                    >
                      <Download className="size-4" /> Baixar PDF
                    </button>
                    <button
                      onClick={() => download("epub")}
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-6 py-3 transition-colors hover:bg-card"
                    >
                      <Download className="size-4" /> Baixar EPUB
                    </button>
                  </div>
                </div>

                {!unlocked && (
                  <div className="panel mt-6 p-6">
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Lock className="size-4 text-primary" /> Escolha um plano para liberar o
                      download completo deste e-book.
                    </p>

                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      {(
                        [
                          { id: "monthly", title: "Plano Mensal", price: "R$ 99/mês" },
                          { id: "lifetime", title: "Plano Vitalício", price: "R$ 299 único" },
                        ] as const
                      ).map((option) => (
                        <button
                          key={option.id}
                          onClick={() => setPlan(option.id)}
                          className={`rounded-xl border p-4 text-left transition-colors ${
                            plan === option.id
                              ? "border-primary bg-secondary"
                              : "border-border hover:border-primary/40"
                          }`}
                        >
                          <span className="block font-semibold">{option.title}</span>
                          <span className="text-sm text-muted-foreground">{option.price}</span>
                        </button>
                      ))}
                    </div>

                    <div className="mt-5 grid gap-3">
                      <input
                        className="field focus:field-focus"
                        placeholder="Nome completo"
                        value={payer.name}
                        onChange={(e) => setPayer({ ...payer, name: e.target.value })}
                      />
                      <input
                        className="field focus:field-focus"
                        placeholder="E-mail"
                        value={payer.email}
                        onChange={(e) => setPayer({ ...payer, email: e.target.value })}
                      />
                      <input
                        className="field focus:field-focus"
                        placeholder="CPF ou CNPJ"
                        value={payer.cpfCnpj}
                        onChange={(e) => setPayer({ ...payer, cpfCnpj: e.target.value })}
                      />
                    </div>

                    <button
                      onClick={pay}
                      disabled={busy}
                      className="btn-gold hover:btn-gold-hover mt-5 w-full py-3 disabled:opacity-60"
                    >
                      {busy ? "Abrindo checkout…" : "Ir para o pagamento"}
                    </button>
                    <p className="mt-3 text-center text-xs text-muted-foreground">
                      Pagamento processado pelo Asaas. O download libera automaticamente após a
                      confirmação.
                    </p>
                  </div>
                )}
              </div>
            </div>

            <section className="mt-14">
              <h2 className="text-2xl font-semibold">Prévia do conteúdo</h2>
              <div className="mt-5 space-y-5">
                {ebookQuery.data?.chapters.map((chapter) => (
                  <article key={chapter.position} className="panel p-6">
                    <h3 className="text-lg font-semibold">
                      {chapter.position}. {chapter.title}
                    </h3>
                    <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
                      {unlocked ? chapter.content : `${chapter.content.slice(0, 700)}…`}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
