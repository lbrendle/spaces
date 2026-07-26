import { invoke } from "@tauri-apps/api/core";
import { getDb, now } from "./db";

const DEVICE_KEY = "spaces.people.this-device";

export interface PortalMemberIdentity {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member" | "guest";
}

export interface PortalDeviceIdentity {
  id: string;
  name: string;
  ownerUserId: string;
  platform: string;
  tools: string[];
  status: string;
  lastSeenAt: string;
}

export function currentDeviceId(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberDeviceId(id: string): void {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    // A locked-down webview can still pair and sync; it just cannot label
    // the local machine across launches.
  }
}

/**
 * A truthful browser-only fallback.
 *
 * WebKit intentionally reports `MacIntel` on Apple-silicon Macs for
 * compatibility, so never expose that legacy token as hardware architecture.
 */
export function browserPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const reported = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  if (/mac|iphone|ipad/i.test(reported)) return "macOS";
  if (/win/i.test(reported)) return "Windows";
  if (/linux/i.test(reported)) return "Linux";
  return navigator.platform || "";
}

/** Ask the native shell for the real OS and CPU architecture when available. */
export async function currentPlatform(): Promise<string> {
  try {
    const reported = await invoke<string>("current_platform");
    return reported.trim() || browserPlatform();
  } catch {
    return browserPlatform();
  }
}

function toolMap(tools: string[]): string {
  return JSON.stringify(
    Object.fromEntries(tools.filter(Boolean).map((tool) => [tool, true]))
  );
}

/**
 * Collapse a pre-pair local row into the portal-issued identity for this Mac.
 *
 * Older releases only reconciled the id currently held in localStorage. If a
 * pairing had already replaced that value, an earlier UUID row could remain
 * beside the new `device_…` row and keep an agent stranded on the old host.
 * Legacy UUIDs are only adopted when they belong to the signed-in member and
 * have this device's exact name; other portal devices are never touched.
 */
async function reconcileLegacyDevice(
  db: Awaited<ReturnType<typeof getDb>>,
  currentId: string,
  memberId: string,
  deviceName: string,
  previousId = "",
): Promise<void> {
  const candidates = new Set<string>();
  if (previousId && previousId !== currentId) candidates.add(previousId);

  if (deviceName.trim()) {
    const legacy = await db.select<{ id: string }[]>(
      `SELECT id
         FROM devices
        WHERE id != $1
          AND member_id = $2
          AND lower(trim(name)) = lower(trim($3))
          AND substr(id, 1, 7) != 'device_'`,
      [currentId, memberId, deviceName]
    );
    for (const row of legacy) candidates.add(row.id);
  }

  for (const candidate of candidates) {
    await db.execute(
      "UPDATE agents SET host_device_id = $1 WHERE host_device_id = $2",
      [currentId, candidate]
    );
    await db.execute("DELETE FROM devices WHERE id = $1", [candidate]);
  }
}

/**
 * Make the web-issued device id the one local source of truth.
 *
 * Early builds minted an unrelated local id before pairing. Repoint hosted
 * agents first, then replace that device row, so an agent never becomes
 * temporarily unhosted.
 */
export async function adoptPairedDevice(
  deviceId: string,
  deviceName: string,
  ownerUserId: string,
): Promise<void> {
  const db = await getDb();
  const previous = currentDeviceId();
  if (ownerUserId) {
    await db.execute(
      `UPDATE members
          SET portal_user_id = $1
        WHERE is_self = 1`,
      [ownerUserId]
    );
  }
  const self = await db.select<{ id: string }[]>(
    "SELECT id FROM members WHERE is_self = 1 LIMIT 1"
  );
  const memberId = self[0]?.id ?? "me";
  const platform = await currentPlatform();
  await db.execute(
    `INSERT INTO devices
      (id, member_id, name, platform, tools, last_seen_at, created_at)
     VALUES ($1,$2,$3,$4,'{}',$5,$5)
     ON CONFLICT(id) DO UPDATE SET
       member_id=excluded.member_id,
       name=excluded.name,
       platform=excluded.platform,
       last_seen_at=excluded.last_seen_at`,
    [deviceId, memberId, deviceName, platform, now()]
  );
  await reconcileLegacyDevice(db, deviceId, memberId, deviceName, previous);
  rememberDeviceId(deviceId);
}

export async function syncPortalPeople(
  currentUserId: string,
  currentId: string,
  members: PortalMemberIdentity[],
  devices: PortalDeviceIdentity[],
): Promise<Map<string, string>> {
  const db = await getDb();
  const memberIds = new Map<string, string>();
  const selfRows = await db.select<{ id: string }[]>(
    "SELECT id FROM members WHERE is_self = 1 LIMIT 1"
  );
  const selfId = selfRows[0]?.id ?? "me";

  for (const member of members) {
    let localId = "";
    if (member.id === currentUserId) {
      localId = selfId;
    } else {
      const existing = await db.select<{ id: string }[]>(
        `SELECT id
           FROM members
          WHERE portal_user_id = $1 OR (email != '' AND lower(email) = lower($2))
          ORDER BY (portal_user_id = $1) DESC
          LIMIT 1`,
        [member.id, member.email]
      );
      localId = existing[0]?.id ?? `portal-member:${member.id}`;
    }
    memberIds.set(member.id, localId);
    await db.execute(
      `INSERT INTO members
        (id, name, email, color, role, portal_user_id, is_self, status, created_at)
       VALUES ($1,$2,$3,'',$4,$5,$6,'active',$7)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         email=excluded.email,
         role=excluded.role,
         portal_user_id=excluded.portal_user_id,
         status='active'`,
      [
        localId,
        member.name,
        member.email,
        member.role,
        member.id,
        localId === selfId ? 1 : 0,
        now(),
      ]
    );
  }

  const previous = currentDeviceId();
  for (const device of devices) {
    const ownerLocalId = memberIds.get(device.ownerUserId) ?? selfId;
    const seen = Date.parse(device.lastSeenAt);
    await db.execute(
      `INSERT INTO devices
        (id, member_id, name, platform, tools, last_seen_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(id) DO UPDATE SET
         member_id=excluded.member_id,
         name=excluded.name,
         platform=excluded.platform,
         tools=excluded.tools,
         last_seen_at=excluded.last_seen_at`,
      [
        device.id,
        ownerLocalId,
        device.name,
        device.platform,
        toolMap(device.tools),
        Number.isFinite(seen) ? seen : 0,
        now(),
      ]
    );
  }
  if (currentId) {
    const here = devices.find((device) => device.id === currentId);
    await reconcileLegacyDevice(
      db,
      currentId,
      selfId,
      here?.name ?? "",
      previous
    );
    rememberDeviceId(currentId);
  }
  return memberIds;
}
