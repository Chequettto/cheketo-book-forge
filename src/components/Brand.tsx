import { Link } from "@tanstack/react-router";

export function Brand({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const scale = size === "lg" ? "text-4xl" : size === "sm" ? "text-lg" : "text-2xl";
  return (
    <span className={`font-[family-name:var(--font-display)] font-semibold ${scale}`}>
      <span className="text-gold">Chequetto</span>
    </span>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
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
        </nav>
      </div>
    </header>
  );
}
