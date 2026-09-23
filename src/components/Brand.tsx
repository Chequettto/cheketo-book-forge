import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";

export function Brand({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const scale = size === "lg" ? "text-4xl" : size === "sm" ? "text-lg" : "text-2xl";
  return (
    <span className={`font-[family-name:var(--font-display)] font-semibold ${scale}`}>
      <span className="text-gold">Chequetto</span>
    </span>
  );
}

export function Header() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate({ to: "/", replace: true });
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-4">
        <Link to="/" className="flex items-center gap-2">
          <Brand />
        </Link>
        <nav className="flex items-center gap-2 text-sm">
          <Link
            to="/painel"
            className="rounded-lg px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
          >
            Meus e-books
          </Link>
          <Link to="/criar" className="btn-gold hover:btn-gold-hover px-4 py-2 text-sm">
            Criar e-book
          </Link>
          {!loading &&
            (user ? (
              <div className="flex items-center gap-2 pl-1">
                <span
                  className="hidden max-w-[10rem] truncate text-xs text-muted-foreground sm:inline"
                  title={user.email ?? ""}
                >
                  {user.email}
                </span>
                <button
                  onClick={handleSignOut}
                  className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Sair
                </button>
              </div>
            ) : (
              <Link
                to="/auth"
                className="rounded-lg border border-border px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                Entrar
              </Link>
            ))}
        </nav>
      </div>
    </header>
  );
}
