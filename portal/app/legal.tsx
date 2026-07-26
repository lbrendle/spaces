import Link from "next/link";
import type { ReactNode } from "react";

export function LegalPage({
  eyebrow,
  title,
  updated,
  children,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <main className="legal-page">
      <article className="legal-document">
        <header className="legal-header">
          <Link className="legal-brand" href="/">
            <span className="brand-glyph brand-icon" aria-hidden="true" />
            <span>Spaces</span>
          </Link>
          <p className="legal-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="legal-updated">Effective {updated}</p>
        </header>
        <div className="legal-content">{children}</div>
        <footer className="legal-footer">
          <Link href="/terms">Terms of Service</Link>
          <Link href="/privacy">Privacy Policy</Link>
        </footer>
      </article>
    </main>
  );
}
