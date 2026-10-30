import { useState } from "react";
import { NumberField, StarterForm } from "@/ui/lobby/starter-form";
import type { StarterProps } from "../module";
import { DEFAULT_SETTINGS, type SpyTypes } from "./schemas";

export function SpyStarter({ disabled, start }: StarterProps<SpyTypes>) {
  const [wordsPerPlayer, setWordsPerPlayer] = useState(DEFAULT_SETTINGS.wordsPerPlayer);
  const [minWords, setMinWords] = useState(DEFAULT_SETTINGS.minWords);
  return (
    <StarterForm disabled={disabled} onStart={() => void start({ wordsPerPlayer, minWords })}>
      <NumberField label="Words each" value={wordsPerPlayer} onChange={setWordsPerPlayer} />
      <NumberField label="Min words" value={minWords} onChange={setMinWords} />
    </StarterForm>
  );
}
