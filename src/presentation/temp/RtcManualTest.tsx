"use client";

import { useState, useRef, useEffect } from "react";
import { RtcConnectionFactory } from "@infrastructure/webrtc/attempt-2/rtc-connection-factory";
import type { ActiveRtcConnection } from "@infrastructure/webrtc/attempt-2/active-rtc-connection";

// ─── Root ─────────────────────────────────────────────────────────────────────

export function RtcManualTest() {
  const [role, setRole] = useState<"host" | "guest" | null>(null);

  if (!role) {
    return (
      <Layout title="RTC connection test">
        <p className="text-gray-500 text-sm">Pick your role in this tab.</p>
        <div className="flex gap-3 mt-4">
          <RoleButton onClick={() => setRole("host")}>Host</RoleButton>
          <RoleButton onClick={() => setRole("guest")}>Guest</RoleButton>
        </div>
      </Layout>
    );
  }

  return role === "host" ? <HostTest /> : <GuestTest />;
}

// ─── Host ─────────────────────────────────────────────────────────────────────

function HostTest() {
  const factoryRef = useRef<RtcConnectionFactory | null>(null);
  const [offer, setOffer] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [connection, setConnection] = useState<ActiveRtcConnection | null>(
    null,
  );

  useEffect(() => {
    const factory = new RtcConnectionFactory();
    factoryRef.current = factory;

    factory.onOfferCreated((o) => setOffer(JSON.stringify(o, null, 2)));
    factory.onIceCandidateCreated((c) =>
      setCandidates((prev) => [...prev, JSON.stringify(c)]),
    );
    factory.onConnected((conn) => setConnection(conn));

    void factory.initiateOffer();

    return () => {
      factory.close();
      factoryRef.current = null;
    };
  }, []);

  async function handleApplyAnswer(value: string) {
    await factoryRef.current?.applyAnswer(JSON.parse(value));
  }

  async function handleApplyCandidate(value: string) {
    await factoryRef.current?.applyIceCandidate(JSON.parse(value));
  }

  return (
    <Layout title="Host">
      <Step index={1} label="Send this offer to the guest">
        {offer ? (
          <CopyBox value={offer} />
        ) : (
          <Pending label="Creating offer…" />
        )}
      </Step>

      <Step index={2} label="Paste the answer from the guest">
        <PasteAndApply
          placeholder="Paste answer JSON here"
          buttonLabel="Apply answer"
          onApply={handleApplyAnswer}
        />
      </Step>

      <Step
        index={3}
        label="Send these ICE candidates to the guest (copy one by one)"
      >
        {candidates.length === 0 ? (
          <Pending label="Waiting for ICE candidates…" />
        ) : (
          <div className="space-y-2">
            {candidates.map((c, i) => (
              <CopyBox key={i} value={c} rows={2} />
            ))}
          </div>
        )}
      </Step>

      <Step
        index={4}
        label="Paste ICE candidates from the guest (one at a time)"
      >
        <PasteAndApply
          placeholder="Paste candidate JSON here"
          buttonLabel="Apply candidate"
          onApply={handleApplyCandidate}
          repeatable
        />
      </Step>

      {connection && (
        <Step index={5} label="Connected — send messages">
          <Chat connection={connection} />
        </Step>
      )}
    </Layout>
  );
}

// ─── Guest ────────────────────────────────────────────────────────────────────

function GuestTest() {
  const factoryRef = useRef<RtcConnectionFactory | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [connection, setConnection] = useState<ActiveRtcConnection | null>(
    null,
  );
  const [offerApplied, setOfferApplied] = useState(false);

  useEffect(() => {
    const factory = new RtcConnectionFactory();
    factoryRef.current = factory;

    factory.onAnswerCreated((a) => setAnswer(JSON.stringify(a, null, 2)));
    factory.onIceCandidateCreated((c) =>
      setCandidates((prev) => [...prev, JSON.stringify(c)]),
    );
    factory.onConnected((conn) => setConnection(conn));

    return () => {
      factory.close();
      factoryRef.current = null;
    };
  }, []);

  async function handleApplyOffer(value: string) {
    await factoryRef.current?.applyOffer(JSON.parse(value));
    setOfferApplied(true);
  }

  async function handleApplyCandidate(value: string) {
    await factoryRef.current?.applyIceCandidate(JSON.parse(value));
  }

  return (
    <Layout title="Guest">
      <Step index={1} label="Paste the offer from the host">
        <PasteAndApply
          placeholder="Paste offer JSON here"
          buttonLabel="Apply offer"
          onApply={handleApplyOffer}
        />
      </Step>

      {offerApplied && (
        <>
          <Step index={2} label="Send this answer to the host">
            {answer ? (
              <CopyBox value={answer} />
            ) : (
              <Pending label="Creating answer…" />
            )}
          </Step>

          <Step
            index={3}
            label="Send these ICE candidates to the host (copy one by one)"
          >
            {candidates.length === 0 ? (
              <Pending label="Waiting for ICE candidates…" />
            ) : (
              <div className="space-y-2">
                {candidates.map((c, i) => (
                  <CopyBox key={i} value={c} rows={2} />
                ))}
              </div>
            )}
          </Step>

          <Step
            index={4}
            label="Paste ICE candidates from the host (one at a time)"
          >
            <PasteAndApply
              placeholder="Paste candidate JSON here"
              buttonLabel="Apply candidate"
              onApply={handleApplyCandidate}
              repeatable
            />
          </Step>
        </>
      )}

      {connection && (
        <Step index={5} label="Connected — send messages">
          <Chat connection={connection} />
        </Step>
      )}
    </Layout>
  );
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function Chat({ connection }: { connection: ActiveRtcConnection }) {
  const [messages, setMessages] = useState<
    { from: "me" | "them"; text: string }[]
  >([]);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return connection.onMessage((msg) => {
      setMessages((prev) => [...prev, { from: "them", text: msg }]);
    });
  }, [connection]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSend() {
    if (!input.trim()) return;
    connection.send(input);
    setMessages((prev) => [...prev, { from: "me", text: input }]);
    setInput("");
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2 bg-gray-50 p-3 border border-gray-200 rounded-lg h-48 overflow-y-auto">
        {messages.length === 0 && (
          <p className="text-gray-400 text-sm">
            No messages yet — say something!
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.from === "me" ? "justify-end" : "justify-start"}`}
          >
            <span
              className={`px-3 py-1.5 rounded-lg text-sm max-w-xs break-words ${
                m.from === "me"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-800 border border-gray-200"
              }`}
            >
              {m.text}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Type a message…"
          className="flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 px-4 py-2 rounded-lg text-white text-sm transition-colors disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function Layout({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6 mx-auto p-6 max-w-xl">
      <h2 className="font-semibold text-lg">{title}</h2>
      {children}
    </div>
  );
}

function Step({
  index,
  label,
  children,
}: {
  index: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex justify-center items-center bg-gray-800 rounded-full w-6 h-6 font-medium text-white text-xs shrink-0">
          {index}
        </span>
        <p className="font-medium text-gray-700 text-sm">{label}</p>
      </div>
      <div className="ml-8">{children}</div>
    </div>
  );
}

function CopyBox({ value, rows = 4 }: { value: string; rows?: number }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative">
      <textarea
        readOnly
        value={value}
        rows={rows}
        className="bg-gray-50 p-2 pr-20 border border-gray-200 rounded-lg focus:outline-none w-full font-mono text-black text-xs resize-none"
        onFocus={(e) => e.target.select()}
      />
      <button
        onClick={handleCopy}
        className="top-2 right-2 absolute bg-white hover:bg-gray-100 px-2 py-1 border border-gray-200 rounded text-xs transition-colors"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

function PasteAndApply({
  placeholder,
  buttonLabel,
  onApply,
  repeatable = false,
}: {
  placeholder: string;
  buttonLabel: string;
  onApply: (value: string) => Promise<void>;
  repeatable?: boolean;
}) {
  const [value, setValue] = useState("");
  const [applied, setApplied] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleApply() {
    if (!value.trim()) return;
    setLoading(true);
    try {
      await onApply(value);
      setApplied(true);
      setValue("");
      if (repeatable) setApplied(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="p-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-full font-mono text-xs resize-none"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={handleApply}
          disabled={!value.trim() || loading}
          className="bg-gray-800 hover:bg-gray-700 disabled:opacity-40 px-3 py-1.5 rounded-lg text-white text-sm transition-colors disabled:cursor-not-allowed"
        >
          {loading ? "Applying…" : buttonLabel}
        </button>
        {applied && !repeatable && (
          <span className="font-medium text-green-600 text-xs">Applied ✓</span>
        )}
      </div>
    </div>
  );
}

function Pending({ label }: { label: string }) {
  return <p className="text-gray-400 text-sm animate-pulse">{label}</p>;
}

function RoleButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-gray-800 hover:bg-gray-700 px-6 py-3 rounded-lg font-medium text-white transition-colors"
    >
      {children}
    </button>
  );
}
