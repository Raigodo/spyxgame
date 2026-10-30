"use client";

import type { FormEvent, ReactNode } from "react";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";

/** The look every game's settings form shares: fields, then Start. A game only supplies the fields. */
export function StarterForm({
  disabled,
  onStart,
  children,
}: {
  disabled: boolean;
  onStart: () => void;
  children?: ReactNode;
}) {
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onStart();
  }
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
      {children}
      <Button type="submit" size="lg" disabled={disabled}>
        Start
      </Button>
    </form>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="w-24 space-y-1">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
