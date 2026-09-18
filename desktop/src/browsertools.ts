/**
 * browsertools.ts — the browser, as something an agent can use.
 *
 * Spaces already has a browser: a real webview inside the workspace, which a
 * person opens and drives themselves. This makes it a shared instrument. An
 * agent navigates it and reads it through MCP — the same MCP its harness
 * already speaks — and because it is the *same* webview, whoever is sitting
 * there watches it happen rather than being told about it afterwards.
 *
 * That is the whole argument for doing it here rather than letting each agent
 * bring its own headless browser. A headless browser is invisible, signed into
 * nothing, and produces claims nobody can check. This one is on screen, shares
 * the session the person already has, and can be taken over mid-task by
 * clicking in it.
 *
 * What the agent gets is deliberately small: go somewhere, read it, click
 * something, type something. Everything is expressed against what a person can
 * see — link text, button labels, field names — because an agent that has to
 * guess CSS selectors for a page it cannot see will guess wrong, and because
 * the failure then says something useful.
 */
import { browserEval, browserLabel, browserNavigate, browserUrl } from "./browser";

/** How much page text one read returns before it is cut. */
const READ_LIMIT = 12_000;
/** How long to wait for a navigation to settle before reading. */
const SETTLE_MS = 900;

export interface PageSummary {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/**
 * The script that turns a rendered page into something readable.
 *
 * `innerText` rather than `textContent`: it respects what is actually
 * displayed, so navigation that is hidden behind a menu and the tracking
 * markup at the end of the body do not arrive as content. Script and style
 * elements are dropped explicitly because innerText on `<body>` still picks
 * some of them up in practice.
 */
const READ_SCRIPT = `
  const strip = ["script", "style", "noscript", "svg", "template"];
  const doc = document.cloneNode(true);
  for (const tag of strip) for (const el of doc.querySelectorAll(tag)) el.remove();
  const main = doc.querySelector("main, article, [role=main]") || doc.body;
  const text = (main && main.innerText ? main.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { url: location.href, title: document.title, text };
`;

/** Read whatever the browser is showing. */
export async function readPage(projectId: string): Promise<PageSummary> {
  const label = browserLabel(projectId);
  const result = await browserEval<{ url: string; title: string; text: string }>(
    label,
    READ_SCRIPT
  );
  if (!result.ok || !result.value) {
    throw new Error(result.error || "the browser did not answer");
  }
  const { url, title, text } = result.value;
  return {
    url,
    title,
    text: text.slice(0, READ_LIMIT),
    truncated: text.length > READ_LIMIT,
  };
}

/** Send the browser somewhere and read what arrives. */
export async function goTo(projectId: string, address: string): Promise<PageSummary> {
  const label = browserLabel(projectId);
  await browserNavigate(label, address);
  // A navigation is not a promise here; the webview starts loading and says
  // nothing more. Waiting a beat before reading is the difference between the
  // new page and the old one.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return readPage(projectId);
}

/**
 * Everything on the page a person could click or fill in.
 *
 * Returned as a numbered list rather than as selectors, because the number is
 * something an agent can pass back unambiguously and a selector is something
 * it has to invent. Elements that are not actually visible are left out: a
 * list that includes the contents of three closed menus is a list nobody can
 * act on.
 */
const CONTROLS_SCRIPT = `
  const out = [];
  const seen = new Set();
  const nodes = document.querySelectorAll(
    "a[href], button, input, textarea, select, [role=button], [role=link], [role=textbox], [contenteditable=true]"
  );
  for (const el of nodes) {
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    const label = (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.value ||
      el.innerText ||
      el.getAttribute("title") ||
      ""
    ).replace(/\\s+/g, " ").trim().slice(0, 80);
    if (!label) continue;
    const kind = el.tagName === "A" ? "link"
      : el.tagName === "INPUT" ? (el.type || "text")
      : el.tagName === "TEXTAREA" ? "text"
      : el.tagName === "SELECT" ? "select"
      : "button";
    const key = kind + "\\u0000" + label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ n: out.length + 1, kind, label });
    if (out.length >= 120) break;
  }
  return out;
`;

export interface Control {
  n: number;
  kind: string;
  label: string;
}

export async function controls(projectId: string): Promise<Control[]> {
  const result = await browserEval<Control[]>(browserLabel(projectId), CONTROLS_SCRIPT);
  if (!result.ok || !Array.isArray(result.value)) {
    throw new Error(result.error || "the browser did not answer");
  }
  return result.value;
}

/**
 * Build a script that finds one control by its visible text and acts on it.
 *
 * Matching is on what a person would read — the accessible name, the
 * placeholder, the button's own words — because that is what an agent has in
 * front of it after a read. Exact matches win over partial ones so that "Save"
 * does not select "Save and publish" when both are present.
 */
function locator(what: string): string {
  return `
    const want = ${JSON.stringify(what.trim().toLowerCase())};
    const nodes = [...document.querySelectorAll(
      "a[href], button, input, textarea, select, [role=button], [role=link], [role=textbox], [contenteditable=true]"
    )].filter((el) => {
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    });
    const name = (el) => (
      el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
      el.getAttribute("name") || el.innerText || el.value || el.getAttribute("title") || ""
    ).replace(/\\s+/g, " ").trim().toLowerCase();
    let target = nodes.find((el) => name(el) === want);
    if (!target) target = nodes.find((el) => name(el).includes(want));
  `;
}

/** Click the thing whose visible text this is. */
export async function click(projectId: string, what: string): Promise<string> {
  const script = `
    ${locator(what)}
    if (!target) return { hit: false, saw: nodes.slice(0, 40).map(name).filter(Boolean) };
    target.scrollIntoView({ block: "center" });
    target.click();
    return { hit: true, label: name(target), tag: target.tagName };
  `;
  const result = await browserEval<{ hit: boolean; label?: string; tag?: string; saw?: string[] }>(
    browserLabel(projectId),
    script
  );
  if (!result.ok || !result.value) throw new Error(result.error || "the browser did not answer");
  if (!result.value.hit) {
    const saw = (result.value.saw ?? []).slice(0, 12).join(", ");
    throw new Error(
      `Nothing on the page matches “${what}”.${saw ? ` Visible controls include: ${saw}.` : ""}`
    );
  }
  return `Clicked ${result.value.label}.`;
}

/**
 * Type into a field, and refuse to type into a password.
 *
 * The refusal is the point. An agent filling in a login is doing something
 * nobody asked for with a credential nobody gave it, and the browser it is
 * driving is signed into the person's own accounts. A page that wants a
 * password wants a person.
 */
export async function typeInto(projectId: string, field: string, text: string): Promise<string> {
  const script = `
    ${locator(field)}
    if (!target) return { hit: false, saw: nodes.slice(0, 40).map(name).filter(Boolean) };
    if (target.type === "password") return { hit: true, refused: true };
    target.scrollIntoView({ block: "center" });
    target.focus();
    const value = ${JSON.stringify(text)};
    if (target.isContentEditable) {
      target.textContent = value;
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        target.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value"
      );
      // Through the native setter, so React and anything else listening for
      // input events sees a real change rather than a value that appears from
      // nowhere and is overwritten on the next render.
      if (setter && setter.set) setter.set.call(target, value);
      else target.value = value;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { hit: true, label: name(target) };
  `;
  const result = await browserEval<{
    hit: boolean;
    refused?: boolean;
    label?: string;
    saw?: string[];
  }>(browserLabel(projectId), script);
  if (!result.ok || !result.value) throw new Error(result.error || "the browser did not answer");
  if (!result.value.hit) {
    const saw = (result.value.saw ?? []).slice(0, 12).join(", ");
    throw new Error(
      `No field on the page matches “${field}”.${saw ? ` Visible controls include: ${saw}.` : ""}`
    );
  }
  if (result.value.refused) {
    throw new Error(
      "That is a password field. Spaces will not type into one — ask the person to sign in."
    );
  }
  return `Typed into ${result.value.label}.`;
}

/** Where the browser currently is, for reporting without reading the page. */
export async function currentUrl(projectId: string): Promise<string> {
  return browserUrl(browserLabel(projectId));
}
