import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Header } from "@/components/Brand";
import { useAuth } from "@/hooks/useAuth";
import { listEbooks } from "@/lib/ebooks.functions";

export const Route = createFileRoute("/painel")({
  head: () => ({
    meta: [
      { title: "Meus e-books — Chequetto" },
      { name: "description", content: "Acompanhe e baixe os e-books criados na Chequetto." },
      { property: "og:title", content: "Meus e-books — Chequetto" },
      { property: "og:description", content: "Sua biblioteca de e-books gerados por IA." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const fetchList = useServerFn(listEbooks);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", search: { next: "/painel" } });
  }, [loading, session, navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ["ebooks", session?.user.id],
    queryFn: () => fetchList(),
    enabled: !!session,
  });

  return (
    <div className="hero-surface min-h-screen">
      <Header />
      <main className="mx-auto max-w-5xl px-5 py-12">
        <h1 className="text-3xl font-semibold md:text-4xl">Meus e-books</h1>

        {isLoading && <p className="mt-8 text-sm text-muted-foreground">Carregando…</p>}

        {!isLoading && (data?.length ?? 0) === 0 && (
          <div className="panel mt-8 p-10 text-center">
            <p className="text-muted-foreground">Você ainda não criou nenhum e-book.</p>
            <Link to="/criar" className="btn-gold hover:btn-gold-hover mt-5 inline-block px-6 py-3">
              Criar o primeiro
            </Link>
          </div>
        )}

        <div className="mt-8 grid gap-4">
          {data?.map((ebook) => (
            <Link
              key={ebook.id}
              to="/ebook/$id"
              params={{ id: ebook.id }}
              className="panel flex items-center justify-between gap-4 p-5 transition-colors hover:border-primary/50"
            >
              <div>
                <h2 className="text-lg font-semibold">{ebook.title}</h2>
                <p className="text-sm text-muted-foreground">{ebook.subtitle}</p>
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-xs ${
                  ebook.paid
                    ? "border-primary/50 text-primary"
                    : "border-border text-muted-foreground"
                }`}
              >
                {ebook.paid ? "Liberado" : ebook.status === "ready" ? "Aguardando pagamento" : "Em produção"}
              </span>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
