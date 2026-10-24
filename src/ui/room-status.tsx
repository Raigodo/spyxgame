import Link from "next/link";
import type { RoomEnd } from "@/room";
import { Screen } from "./screen";
import { btn } from "./styles";

function Notice({ title, back }: { title: string; back?: boolean }) {
  return (
    <Screen>
      <p className="font-semibold text-base">{title}</p>
      {back && (
        <Link href="/room" className={`${btn} inline-block`}>
          Back to rooms
        </Link>
      )}
    </Screen>
  );
}

export const ConnectingNotice = () => <Notice title="Connecting…" />;
export const JoinFailedNotice = () => <Notice title="Couldn't join the room." back />;

const ENDED: Record<RoomEnd["reason"], string> = {
  superseded: "This player is open in another tab.",
  kicked: "You were removed from the room.",
  full: "The room is full.",
};
export const RoomEndedNotice = ({ reason }: { reason: RoomEnd["reason"] }) => (
  <Notice title={ENDED[reason]} back />
);
