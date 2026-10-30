import { useState } from "react";
import { NumberField, StarterForm } from "@/ui/lobby/starter-form";
import type { StarterProps } from "../module";
import { DEFAULT_SETTINGS, GOAL_RANGE, type TapTypes } from "./schemas";

export function DemoTapStarter({ disabled, start }: StarterProps<TapTypes>) {
  const [goal, setGoal] = useState(DEFAULT_SETTINGS.goal);
  return (
    <StarterForm disabled={disabled} onStart={() => void start({ goal })}>
      <NumberField
        label="Taps to win"
        value={goal}
        onChange={setGoal}
        min={GOAL_RANGE.min}
        max={GOAL_RANGE.max}
      />
    </StarterForm>
  );
}
