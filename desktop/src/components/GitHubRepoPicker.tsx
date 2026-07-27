import { useCallback, useEffect, useState } from "react";
import { ghCapability, ghRefresh, repoNames } from "../github";
import { IconGitHub } from "./icons";
import { Spinner } from "./ui";
import "./newproject.css";

export function GitHubRepoPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [repos, setRepos] = useState<string[]>([]);
  const [login, setLogin] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError("");
    if (force) ghRefresh();
    try {
      const capability = await ghCapability();
      if (capability.state !== "ready") {
        setRepos([]);
        setLogin("");
        setError(
          capability.state === "missing"
            ? "GitHub CLI is not installed on this Mac."
            : "GitHub CLI is signed out. Run gh auth login, then retry.",
        );
        return;
      }
      setLogin(capability.login);
      setRepos(await repoNames());
    } catch (reason) {
      setRepos([]);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = repos.includes(value.trim()) ? value.trim() : "";

  return (
    <>
      <div className="row">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="owner/name"
          spellCheck={false}
        />
        <button
          className="btn"
          type="button"
          disabled={loading}
          onClick={() => void load(true)}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {loading ? (
        <div className="np-repo-state"><Spinner /> Loading repositories from this Mac…</div>
      ) : repos.length ? (
        <>
          <select
            className="np-repo-select"
            aria-label="Choose one of your GitHub repositories"
            value={selected}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">
              {value.trim() ? "Choose a different repository…" : `Choose from ${repos.length} repositories…`}
            </option>
            {repos.map((repository) => (
              <option key={repository} value={repository}>{repository}</option>
            ))}
          </select>
          <div className="np-repo-state">
            <IconGitHub size={12} /> Signed in as {login || "this Mac's GitHub account"}
          </div>
        </>
      ) : (
        <div className="np-repo-state bad">
          {error || "GitHub returned no repositories."}{" "}
          <button className="link-button" type="button" onClick={() => void load(true)}>
            Try again
          </button>
        </div>
      )}
    </>
  );
}
