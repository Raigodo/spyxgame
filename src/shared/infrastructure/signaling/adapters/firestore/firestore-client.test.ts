import { afterEach, expect, it, vi } from "vitest";
import { getFirestoreClient } from "./firestore-client";

const VARS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
];

afterEach(() => vi.unstubAllEnvs());

it("names every missing variable", () => {
  for (const name of VARS) vi.stubEnv(name, "");
  expect(() => getFirestoreClient()).toThrow(/NEXT_PUBLIC_FIREBASE_API_KEY/);
  expect(() => getFirestoreClient()).toThrow(/NEXT_PUBLIC_FIREBASE_APP_ID/);
});
