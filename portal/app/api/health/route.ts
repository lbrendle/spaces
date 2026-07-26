export const dynamic = "force-dynamic";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

export async function GET() {
  return Response.json(
    {
      ok: true,
      service: "spaces",
      pairing: true,
      timestamp: new Date().toISOString(),
    },
    { headers },
  );
}
