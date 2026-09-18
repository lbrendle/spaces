/**
 * adopt.ts — taking in the context other agents already keep.
 *
 * Every coding agent writes its project knowledge into a file: Claude Code
 * into `CLAUDE.md`, Codex into `AGENTS.md`, and Spaces into its own generated
 * `.hq/CONTEXT.md`. Until now the traffic was one-way. Spaces rendered its
 * database into `.hq/` and overwrote whatever was there, and read none of it
 * back — so a decision recorded by anything other than Spaces was, at best,
 * ignored, and at worst erased the next time the blackboard ran.
 *
 * That is not hypothetical. Five decisions about this very workspace — how
 * deploys work, which agent owns which files — survived in
 * `archii/.hq/CONTEXT.md` only because no project happened to point at that
 * directory any more. Pointing one at it again would have blanked them.
 *
 * So: read before writing, and keep reading. Adoption is append-only and
 * idempotent. It never edits CLAUDE.md or AGENTS.md — those belong to their
 * authors — and it never removes a memory entry, because the absence of a
 * section from a file somebody else maintains is not evidence that the
 * decision was reversed.
 */
import { invoke } from "@tauri-apps/api/core";
import { getDb, now } from "./db";
import { useStore } from "./store";
import {
  digest,
  isGenerated,
  parseGeneratedContext,
  parseInstructions,
  parsePreamble,
  type Candidate,
} from "./adoptparse";
import type { Project } from "./types";

/** Where project context is kept, and what to call it when it has no heading. */
const SOURCES: ReadonlyArray<{ rel: string; label: string; generated: boolean }> = [
  // Spaces' own, first: it is the one this can lose, and the one whose
  // structure is exactly known.
  { rel: ".hq/CONTEXT.md", label: "Project context", generated: true },
  { rel: "CLAUDE.md", label: "CLAUDE.md", generated: false },
  { rel: "AGENTS.md", label: "AGENTS.md", generated: false },
  { rel: ".github/copilot-instructions.md", label: "Copilot instructions", generated: false },
];

export interface AdoptResult {
  /** Entries created this time. */
  added: number;
  /** Sections already held, so nothing to do. */
  known: number;
  /** Files that were read, for reporting. */
  sources: string[];
  /** Whether a description was taken from a previous generated file. */
  description: boolean;
}

async function readFile(root: string, rel: string): Promise<string | null> {
  try {
    return await invoke<string>("read_text_file", { root, relativePath: rel });
  } catch {
    return null;
  }
}

/**
 * Bring a project's on-disk context into its memory.
 *
 * Safe to call on every sync: a section already adopted is recognised by its
 * digest and skipped, so this is a no-op until one of those files actually
 * changes. When one does, the changed section arrives as a *new* entry rather
 * than editing the old one — the old wording is what the workspace was
 * operating on, and quietly replacing it would rewrite history.
 */
export async function adoptContext(project: Project): Promise<AdoptResult> {
  const result: AdoptResult = { added: 0, known: 0, sources: [], description: false };
  const root = (project.local_path ?? "").trim();
  if (!root) return result;

  const db = await getDb();
  const seen = new Set(
    (
      await db.select<{ digest: string }[]>(
        "SELECT digest FROM adopted_context WHERE project_id = $1",
        [project.id]
      )
    ).map((r) => r.digest)
  );

  const store = useStore.getState();
  // Titles already in memory, so context adopted before this table existed —
  // or written by hand in the app — is not duplicated.
  const titles = new Set(
    store.memory
      .filter((m) => m.project_id === project.id)
      .map((m) => m.title.trim().toLowerCase())
  );

  for (const source of SOURCES) {
    const text = await readFile(root, source.rel);
    if (text === null || !text.trim()) continue;

    let candidates: Candidate[];
    if (source.generated) {
      // Only parse it as ours if it actually is ours; a hand-written file at
      // that path is somebody's own work and reads as instructions.
      if (isGenerated(text)) {
        candidates = parseGeneratedContext(text);
        /*
         * The description is the one part of the file Spaces keeps in a column
         * rather than in memory, so nothing above adopts it — and a project
         * created by pointing at a folder has that column empty, which meant
         * the next regeneration silently dropped the line saying what the
         * project is. Fill it only when it is empty: what the app holds now is
         * newer than what a file on disk was rendered from.
         */
        if (!(project.description ?? "").trim()) {
          const preamble = parsePreamble(text);
          if (preamble) {
            await store.updateProject(project.id, { description: preamble });
            result.description = true;
          }
        }
      } else {
        candidates = parseInstructions(text, source.label);
      }
    } else {
      candidates = parseInstructions(text, source.label);
    }
    if (!candidates.length) continue;
    result.sources.push(source.rel);

    for (const candidate of candidates) {
      const key = digest(candidate);
      if (seen.has(key)) {
        result.known += 1;
        continue;
      }
      if (titles.has(candidate.title.trim().toLowerCase())) {
        // Same heading, different words: record that this wording is known so
        // it is not offered again, but do not add a second entry under a
        // title the workspace already has.
        await db.execute(
          "INSERT OR IGNORE INTO adopted_context (project_id, digest, source, title, memory_id, adopted_at) VALUES ($1,$2,$3,$4,'',$5)",
          [project.id, key, source.rel, candidate.title, now()]
        );
        seen.add(key);
        result.known += 1;
        continue;
      }

      const entry = await store.addMemory({
        project_id: project.id,
        kind: candidate.kind,
        title: candidate.title,
        content: candidate.content,
      });
      await db.execute(
        "INSERT OR IGNORE INTO adopted_context (project_id, digest, source, title, memory_id, adopted_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [project.id, key, source.rel, candidate.title, entry.id, now()]
      );
      seen.add(key);
      titles.add(candidate.title.trim().toLowerCase());
      result.added += 1;
    }
  }

  return result;
}
