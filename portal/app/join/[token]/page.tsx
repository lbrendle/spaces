import { JoinWorkspace } from "./JoinWorkspace";
import { requireChatGPTUser } from "../../chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <AuthenticatedJoin token={token} />;
}

async function AuthenticatedJoin({ token }: { token: string }) {
  await requireChatGPTUser(`/join/${encodeURIComponent(token)}`);
  return <JoinWorkspace token={token} />;
}
