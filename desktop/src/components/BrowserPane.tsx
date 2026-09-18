import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  browserAction,
  browserBounds,
  browserClose,
  browserNavigate,
  browserOpen,
  browserDock,
  browserEval,
  browserIsFloating,
  browserLabel,
  browserPopout,
  browserUrl,
  browserVisibility,
  normalizeBrowserInput,
} from "../browser";
import {
  IconArrowLeft,
  IconArrowRight,
  IconContract,
  IconExpand,
  IconGlobe,
  IconRefresh,
} from "./icons";

interface BrowserPaneProps {
  projectId: string;
  initialUrl: string;
  active: boolean;
}

/**
 * Native project browser.
 *
 * A Tauri child webview occupies only the rectangle below Spaces's own toolbar,
 * so the address bar stays part of the trusted app chrome while pages retain a
 * real browser engine, cookies, logins, navigation, and devtools.
 */
export function BrowserPane({ projectId, initialUrl, active }: BrowserPaneProps) {
  const native = isTauri();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editingAddressRef = useRef(false);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  // One definition of the label, shared with the tools agents call — they have
  // to address the same webview this pane is showing, or an agent browses
  // something nobody can see.
  const labelRef = useRef(browserLabel(projectId));
  const label = labelRef.current;

  const [firstUrl] = useState(() => {
    const saved =
      typeof window === "undefined"
        ? ""
        : window.localStorage.getItem(`spaces-browser:${projectId}`) ?? "";
    return normalizeBrowserInput(saved || initialUrl);
  });
  const [address, setAddress] = useState(firstUrl);
  const [fallbackUrl, setFallbackUrl] = useState(firstUrl);
  const [error, setError] = useState("");
  /*
   * The page's own title.
   *
   * Worth showing for its own sake — an address bar full of query parameters
   * says much less than "Pull requests · spaces" — and it is also the honest
   * proof that Spaces can read the page at all. The same call underlies every
   * browser tool an agent has; if the title is right, so is the bridge.
   */
  const [pageTitle, setPageTitle] = useState("");
  /*
   * True while the browser is in its own floating window.
   *
   * The pane must not recreate its webview while that is the case — there is
   * only one browser, and two would be two different pages that look like one.
   */
  const [floating, setFloating] = useState(false);
  const [ready, setReady] = useState(!native);

  const enqueue = useCallback((fn: () => Promise<unknown>) => {
    chainRef.current = chainRef.current.then(fn, fn).catch(() => {});
    return chainRef.current;
  }, []);

  const place = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    await browserBounds(label, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, [label]);

  // A browser can already be floating when this pane mounts — after switching
  // channels, or on the next launch — so ask rather than assume.
  useEffect(() => {
    void browserIsFloating(label).then(setFloating).catch(() => {});
  }, [label]);

  useEffect(() => {
    if (!native) return;
    // Floating means the browser already exists in its own window. Opening a
    // second one here would put two different pages on screen that both claim
    // to be this project's browser.
    if (floating) return;
    let live = true;
    let settleTimer = 0;

    void enqueue(async () => {
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      try {
        await browserOpen(label, firstUrl, {
          x: rect.left,
          y: rect.top,
          width: Math.max(1, rect.width),
          height: Math.max(1, rect.height),
        });
      } catch (reason) {
        if (live) {
          setReady(false);
          setError(String(reason));
        }
        return;
      }
      if (!live) {
        await browserClose(label).catch(() => {});
        return;
      }
      setReady(true);
      setError("");
      // Opening from a fully collapsed dock animates the host from zero width.
      // ResizeObserver can fire before the webview handle exists, so do one
      // final placement after Spaces's pane transition has settled.
      settleTimer = window.setTimeout(() => void place().catch(() => {}), 260);
    }).catch((reason) => {
      if (live) setError(String(reason));
    });

    return () => {
      live = false;
      window.clearTimeout(settleTimer);
      setReady(false);
      void enqueue(async () => {
        await browserClose(label).catch(() => {});
      });
    };
  }, [enqueue, firstUrl, floating, label, native, place]);

  useEffect(() => {
    if (!native) return;
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void place().catch(() => {}));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [native, place]);

  useEffect(() => {
    if (!native || !ready) return;
    if (active) {
      // The Rust command returns after the child webview has been dispatched
      // to the macOS main thread. Give that dispatch one frame before sending
      // visibility/bounds commands; the webview is visible by default.
      const timer = window.setTimeout(() => {
        void browserVisibility(label, true)
          .then(() => place())
          .catch(() => {});
      }, 80);
      return () => window.clearTimeout(timer);
    } else {
      void browserVisibility(label, false).catch(() => {});
    }
  }, [active, label, native, place, ready]);

  // Child webview navigation is independent from React. Poll its URL so links
  // clicked inside pages keep Spaces's address field truthful.
  useEffect(() => {
    if (!native || !ready || !active) return;
    /*
     * Reading the URL is a cheap question for the webview handle. Reading the
     * title is not — it evaluates a script inside the page and waits for the
     * answer — so it happens when the page has actually changed rather than
     * every tick. Doing both at 800ms was a WKWebView round trip per second
     * for a string that changes when you navigate.
     */
    let lastUrl = "";
    const poll = window.setInterval(() => {
      void browserUrl(label)
        .then((url) => {
          if (!url) return;
          // Do not replace a half-typed address with the current page URL.
          // The poll catches up on the next tick after the field loses focus.
          if (!editingAddressRef.current) setAddress(url);
          window.localStorage.setItem(`spaces-browser:${projectId}`, url);
          if (url === lastUrl) return;
          lastUrl = url;
          void browserEval<string>(label, "return document.title")
            .then((result) => setPageTitle(result.ok ? String(result.value ?? "") : ""))
            .catch(() => setPageTitle(""));
        })
        .catch(() => {});
    }, 800);
    return () => window.clearInterval(poll);
  }, [active, label, native, projectId, ready]);

  useEffect(() => {
    const navigateFromAgent = (event: Event) => {
      const detail = (
        event as CustomEvent<{ projectId?: string; url?: string }>
      ).detail;
      if (detail?.projectId !== projectId || !detail.url?.trim()) return;
      setAddress(detail.url.trim());
      setFallbackUrl(normalizeBrowserInput(detail.url));
      window.localStorage.setItem(
        `spaces-browser:${projectId}`,
        normalizeBrowserInput(detail.url),
      );
      if (native && ready) {
        void browserNavigate(label, detail.url)
          .then((url) => {
            setAddress(url);
            setFallbackUrl(url);
            window.localStorage.setItem(`spaces-browser:${projectId}`, url);
          })
          .catch((reason) => setError(String(reason)));
      }
    };
    window.addEventListener("spaces:open-browser", navigateFromAgent);
    return () =>
      window.removeEventListener("spaces:open-browser", navigateFromAgent);
  }, [label, native, projectId, ready]);

  async function go(value = address) {
    setError("");
    try {
      const url = await browserNavigate(label, value);
      setAddress(url);
      setFallbackUrl(url);
      window.localStorage.setItem(`spaces-browser:${projectId}`, url);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function popOut() {
    setError("");
    try {
      const url = await browserPopout(label);
      setFloating(true);
      if (url) setAddress(url);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function dock() {
    setError("");
    try {
      const url = await browserDock(label);
      if (url) setAddress(url);
      // Clearing this lets the open effect run again and rebuild the webview
      // in the pane, at wherever the floating window had got to.
      setFloating(false);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function act(action: "back" | "forward" | "reload") {
    setError("");
    if (!native && action === "reload") {
      setFallbackUrl((url) => {
        const separator = url.includes("#") ? "&" : "#";
        return `${url}${separator}spaces-reload=${Date.now()}`;
      });
      return;
    }
    try {
      await browserAction(label, action);
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <div className="cc-browser">
      <div className="cc-browser-bar">
        <div className="cc-browser-nav" aria-label="Browser navigation">
          <button className="icon-btn" title="Back" onClick={() => void act("back")}>
            <IconArrowLeft size={15} />
          </button>
          <button className="icon-btn" title="Forward" onClick={() => void act("forward")}>
            <IconArrowRight size={15} />
          </button>
          <button className="icon-btn" title="Reload" onClick={() => void act("reload")}>
            <IconRefresh size={15} />
          </button>
        </div>
        <form
          className="cc-address"
          onSubmit={(event) => {
            event.preventDefault();
            editingAddressRef.current = false;
            void go();
          }}
        >
          <IconGlobe size={14} />
          <input
            aria-label="Address or search"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              editingAddressRef.current = true;
              event.currentTarget.select();
            }}
            onBlur={() => {
              editingAddressRef.current = false;
            }}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </form>
        {pageTitle && (
          <span className="cc-browser-title" title={pageTitle}>
            {pageTitle}
          </span>
        )}
        <button
          className="icon-btn"
          title={floating ? "Put the browser back in this panel" : "Float the browser above everything"}
          onClick={() => void (floating ? dock() : popOut())}
        >
          {floating ? <IconContract size={15} /> : <IconExpand size={15} />}
        </button>
        <span className={"cc-browser-state" + (ready || floating ? " ready" : "")}>
          {floating ? "floating" : ready ? "live" : "opening"}
        </span>
      </div>
      {error && <div className="banner warn cc-browser-error">{error}</div>}
      <div className="cc-browser-host" ref={hostRef}>
        {!native && (
          <iframe
            key={fallbackUrl}
            title="Spaces project browser"
            src={fallbackUrl.replace(/#spaces-reload=\d+$/, "")}
          />
        )}
        {native && floating && (
          <div className="cc-browser-loading">
            <IconGlobe size={22} />
            This browser is floating above your other windows.
            <button className="btn tiny" onClick={() => void dock()}>
              Put it back
            </button>
          </div>
        )}
        {native && !floating && !ready && !error && (
          <div className="cc-browser-loading">
            <IconGlobe size={22} />
            Opening the project browser…
          </div>
        )}
      </div>
    </div>
  );
}
