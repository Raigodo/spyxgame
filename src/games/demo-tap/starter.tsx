import { useState } from "react";
import type { StarterProps } from "../module";
import { btnPrimary, heading, input } from "@/ui/styles";
import { DEFAULT_SETTINGS, GOAL_RANGE, type TapTypes } from "./schemas";

export function DemoTapStarter({ disabled, start }: StarterProps<TapTypes>) {
  const [goal, setGoal] = useState(DEFAULT_SETTINGS.goal);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void start({ goal });
      }}
    >
      <label className="space-y-1">
        <span className={heading}>Taps to win</span>
        <input
          type="number"
          min={GOAL_RANGE.min}
          max={GOAL_RANGE.max}
          className={`${input} block w-24`}
          value={goal}
          onChange={(e) => setGoal(Number(e.target.value))}
        />
      </label>
      <button className={btnPrimary} disabled={disabled}>
        Start
      </button>
    </form>
  );
}
