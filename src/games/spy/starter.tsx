import { useState } from "react";
import type { StarterProps } from "../module";
import { btnPrimary, heading, input } from "@/ui/styles";
import { DEFAULT_SETTINGS, type SpyTypes } from "./schemas";

export function SpyStarter({ disabled, start }: StarterProps<SpyTypes>) {
  const [wordsPerPlayer, setWordsPerPlayer] = useState(DEFAULT_SETTINGS.wordsPerPlayer);
  const [minWords, setMinWords] = useState(DEFAULT_SETTINGS.minWords);
  const field = (label: string, value: number, set: (n: number) => void) => (
    <label className="space-y-1">
      <span className={heading}>{label}</span>
      <input
        type="number"
        className={`${input} block w-24`}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
      />
    </label>
  );
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void start({ wordsPerPlayer, minWords });
      }}
    >
      {field("Words each", wordsPerPlayer, setWordsPerPlayer)}
      {field("Min words", minWords, setMinWords)}
      <button className={btnPrimary} disabled={disabled}>
        Start
      </button>
    </form>
  );
}
