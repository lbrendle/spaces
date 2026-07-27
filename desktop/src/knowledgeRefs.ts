import { getDb } from "./db";

export type KnowledgeIdentityEntity = "vault" | "document";

interface KnowledgeIdentityRow {
  entity: KnowledgeIdentityEntity;
  local_id: string;
  remote_id: string;
}

function identityKey(entity: KnowledgeIdentityEntity, id: string): string {
  return `${entity}:${id}`;
}

/**
 * The portal assigns one durable record id to shared content. An originating
 * device keeps it in portal_sync_state; a receiving device keeps the same id in
 * portal_links. Folding both tables into one map makes Knowledge references
 * survive member-local mirror ids.
 */
export async function stableKnowledgeIdentities(): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.select<KnowledgeIdentityRow[]>(
    `SELECT entity, local_id, remote_id
       FROM portal_links
      WHERE entity IN ('vault', 'document') AND remote_id <> ''
      UNION ALL
     SELECT entity, local_id, remote_id
       FROM portal_sync_state
      WHERE entity IN ('vault', 'document') AND remote_id <> ''`,
  );
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!row.local_id || !row.remote_id) continue;
    result.set(identityKey(row.entity, row.local_id), row.remote_id);
  }
  return result;
}

export function stableKnowledgeIdentity(
  identities: Map<string, string>,
  entity: KnowledgeIdentityEntity,
  localId: string,
): string {
  return identities.get(identityKey(entity, localId)) ?? localId;
}

/**
 * Resolve a stable cross-device id back to the row on this Mac. Direct local
 * ids still work for content that has not reached the portal yet.
 */
export async function localKnowledgeIdentity(
  entity: KnowledgeIdentityEntity,
  stableId: string,
): Promise<string | null> {
  const db = await getDb();
  const table = entity === "vault" ? "vaults" : "documents";
  const direct = await db.select<Array<{ id: string }>>(
    `SELECT id FROM ${table} WHERE id = $1 LIMIT 1`,
    [stableId],
  );
  if (direct[0]?.id) return direct[0].id;

  const linked = await db.select<Array<{ local_id: string }>>(
    `SELECT local_id
       FROM portal_links
      WHERE entity = $1 AND remote_id = $2
      UNION ALL
     SELECT local_id
       FROM portal_sync_state
      WHERE entity = $1 AND remote_id = $2
      LIMIT 1`,
    [entity, stableId],
  );
  return linked[0]?.local_id ?? null;
}
