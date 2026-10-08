import { getApps, initializeApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";

// NEXT_PUBLIC_* must be read as literal property accesses so Next can inline them.
// Each entry keeps the env var name next to its value, so the error can name it.
function readConfig() {
  const entries = {
    apiKey: ["NEXT_PUBLIC_FIREBASE_API_KEY", process.env.NEXT_PUBLIC_FIREBASE_API_KEY],
    authDomain: ["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN],
    projectId: ["NEXT_PUBLIC_FIREBASE_PROJECT_ID", process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID],
    storageBucket: [
      "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    ],
    messagingSenderId: [
      "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    ],
    appId: ["NEXT_PUBLIC_FIREBASE_APP_ID", process.env.NEXT_PUBLIC_FIREBASE_APP_ID],
  } as const;

  const missing = Object.values(entries)
    .filter(([, value]) => !value)
    .map(([envName]) => envName);
  if (missing.length > 0) {
    throw new Error(`[firebase] Missing config: ${missing.join(", ")}. See .env.example.`);
  }

  return Object.fromEntries(
    Object.entries(entries).map(([key, [, value]]) => [key, value])
  ) as Record<keyof typeof entries, string>;
}

let client: Firestore | undefined;

/** Created on first use, so importing the client never needs Firebase env. */
export function getFirestoreClient(): Firestore {
  client ??= getFirestore(getApps()[0] ?? initializeApp(readConfig()));
  return client;
}
