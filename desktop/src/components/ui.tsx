import React from "react";
import { colorFor } from "../types";
import { highlight } from "../syntax";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Tiny markdown renderer: fences, inline code, bold/italic, links, headings, lists, quotes. */
export function mdToHtml(src: string): string {
  const fences: string[] = [];
  const media: string[] = [];
  // NUL sentinels cannot collide with message text: NULs are stripped first.
  let text = src.replace(/\u0000/g, "").replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    fences.push(
      `<pre class="codeblock"><div class="codelang">${escapeHtml(lang || "")}</div><code>${highlight(code, lang || "")}</code></pre>`
    );
    return ` \u0000F${fences.length - 1}\u0000 `;
  });
  text = escapeHtml(text);
  // Protect media before ordinary link/autolink handling, otherwise the URL
  // inside the generated element is linked a second time. Only HTTPS is
  // accepted; local worktree paths must be uploaded through Spaces first.
  text = text.replace(
    /!\[([^\]\n]*)\]\((https:\/\/[^\s)]+)\)/g,
    (_match, alt, url) => {
      const video = /\.(?:mp4|mov|m4v|webm)(?:[?#]|$)/i.test(url);
      media.push(
        video
          ? `<video class="md-media" controls preload="metadata" src="${url}" aria-label="${alt || "Shared video"}"></video>`
          : `<a class="md-media-link" href="${url}" target="_blank" rel="noreferrer"><img class="md-media" src="${url}" alt="${alt || "Shared image"}" loading="lazy" /></a>`,
      );
      return ` \u0000I${media.length - 1}\u0000 `;
    },
  );
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>");
  // Left boundary keeps emails (a@b.c), npm scopes and /@user URLs intact.
  text = text.replace(/(?<![\w@.\/-])@([a-z0-9-]+)/gi, `<span class="mention">@$1</span>`);
  text = text.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noreferrer">$1</a>`);
  text = text.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, `$1<a href="$2" target="_blank" rel="noreferrer">$2</a>`);

  const lines = text.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    const q = line.match(/^&gt;\s?(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${li[1]}</li>`);
      continue;
    }
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (h) out.push(`<div class="md-h md-h${h[1].length}">${h[2]}</div>`);
    else if (q) out.push(`<blockquote>${q[1]}</blockquote>`);
    else if (line.trim() === "") out.push(`<div class="md-gap"></div>`);
    else out.push(`<div>${line}</div>`);
  }
  if (inList) out.push("</ul>");
  let html = out.join("");
  html = html.replace(/ ?\u0000F(\d+)\u0000 ?/g, (_m, i) => fences[Number(i)]);
  html = html.replace(/ ?\u0000I(\d+)\u0000 ?/g, (_m, i) => media[Number(i)]);
  return html;
}

export function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"modal" + (wide ? " modal-wide" : "")}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Avatar({ name, id, kind }: { name: string; id: string; kind?: string }) {
  // Older/local rows can contain a null author name even though the current
  // schema types it as a string. One malformed historical message should not
  // be able to take down the entire project workspace.
  const letter = (name?.[0] ?? "?").toUpperCase();
  const badge =
    kind === "claude" ? "✳" : kind === "codex" ? "◈" : kind === "ritz" ? "◉" : null;
  return (
    <div className="avatar" style={{ background: colorFor(id) }}>
      {letter}
      {badge && <span className="avatar-badge">{badge}</span>}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
