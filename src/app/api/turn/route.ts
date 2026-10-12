import { NextResponse } from "next/server";

// Credentials live a day: longer than any session we expect, short enough to be low-risk.
const TTL_SECONDS = 24 * 60 * 60;

export const dynamic = "force-dynamic";

// Server only: the TURN key never reaches the browser. Without it we answer with no servers,
// and the client falls back to STUN only.
export async function GET() {
  const keyId = process.env.TURN_KEY_ID;
  const apiToken = process.env.TURN_KEY_API_TOKEN;
  if (!keyId || !apiToken) return NextResponse.json({ iceServers: [] });

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
        cache: "no-store",
      }
    );
    if (!response.ok) {
      console.error(`[turn] Cloudflare answered ${response.status}`);
      return NextResponse.json({ iceServers: [] }, { status: 502 });
    }
    return NextResponse.json(await response.json(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[turn] credential request failed", error);
    return NextResponse.json({ iceServers: [] }, { status: 502 });
  }
}
