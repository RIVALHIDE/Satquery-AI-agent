import { useEffect, useState } from "react";
import type { AgentLog, AgentLogTag, WarRoomContext } from "../types";

interface AgentWarRoomModalProps {
  open: boolean;
  onClose: () => void;
  context?: WarRoomContext;
}

const initialLogLines: Array<{ tag: AgentLogTag; message: string }> = [
  { tag: "SYS", message: "war-room channel connected" },
  { tag: "E2B", message: "context window mounted · local runtime" },
  { tag: "AGT", message: "orchestrator received scene query" },
  { tag: "LOG", message: "routing intent → feature_extraction" },
  { tag: "AGT", message: "feature extraction agent started" },
  { tag: "OUT", message: "awaiting final measurement payload" },
];

const liveLogLines: Array<{ tag: AgentLogTag; message: string }> = [
  { tag: "SYS", message: "heartbeat ok · no external model calls" },
  { tag: "E2B", message: "OpenCV worker memory stable at 184 MB" },
  { tag: "AGT", message: "HSV masks assembled for water / vegetation" },
  { tag: "LOG", message: "coverage metrics normalized to scene extent" },
  { tag: "OUT", message: "agent response serialized successfully" },
];

const tagStyles: Record<AgentLogTag, string> = {
  SYS: "text-slate-400",
  E2B: "text-violet-300",
  AGT: "text-cyan-300",
  LOG: "text-amber-300",
  OUT: "text-emerald-300",
};

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function AgentNode({
  title,
  subtitle,
  accent,
  status = "active",
}: {
  title: string;
  subtitle: string;
  accent: string;
  status?: "active" | "idle";
}) {
  return (
    <div className="w-44 rounded-xl border border-white/10 bg-zinc-900/90 p-3 shadow-xl">
      <div className="flex items-start justify-between gap-2">
        <div className={`grid h-7 w-7 place-items-center rounded-lg ${accent} text-xs font-bold text-zinc-950`}>✦</div>
        <span className={`mt-1 h-1.5 w-1.5 rounded-full ${status === "active" ? "bg-emerald-400 shadow-[0_0_9px_rgba(52,211,153,0.8)]" : "bg-zinc-600"}`} />
      </div>
      <div className="mt-3 text-xs font-semibold text-zinc-100">{title}</div>
      <div className="mt-1 text-[10px] leading-4 text-zinc-500">{subtitle}</div>
    </div>
  );
}

export default function AgentWarRoomModal({
  open,
  onClose,
  context = { route: "Feature Extraction Agent", query: "Describe this scene", status: "complete" },
}: AgentWarRoomModalProps) {
  const [logs, setLogs] = useState<AgentLog[]>([]);

  useEffect(() => {
    if (!open) return;

    setLogs(
      initialLogLines.map((line, index) => ({
        ...line,
        id: index,
        timestamp: stamp(),
      })),
    );
    let lineIndex = 0;
    const interval = window.setInterval(() => {
      const line = liveLogLines[lineIndex % liveLogLines.length];
      lineIndex += 1;
      setLogs((current) => [
        ...current.slice(-13),
        { ...line, id: Date.now(), timestamp: stamp() },
      ]);
    }, 1800);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="war-room-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[min(720px,calc(100vh-32px))] w-[min(1180px,100%)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 text-zinc-100 shadow-[0_30px_100px_rgba(0,0,0,0.65)]">
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-300">◈</div>
            <div>
              <h2 id="war-room-title" className="text-sm font-semibold tracking-wide">Agent War Room</h2>
              <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Live orchestration trace
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <div className="text-[10px] uppercase tracking-wider text-zinc-600">Active route</div>
              <div className="mt-1 text-xs text-cyan-300">{context.route}</div>
            </div>
            <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 text-lg text-zinc-400 transition hover:border-white/20 hover:bg-white/5 hover:text-white" aria-label="Close war room">×</button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="relative min-h-[360px] overflow-hidden border-b border-white/10 bg-[radial-gradient(circle_at_50%_40%,rgba(34,211,238,0.06),transparent_48%)] p-6 lg:border-b-0 lg:border-r">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-600">Execution graph</div>
                <div className="mt-2 max-w-lg truncate text-xs text-zinc-400" title={context.query}>“{context.query}”</div>
              </div>
              <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[10px] text-emerald-300">{context.status}</span>
            </div>

            <div className="relative mx-auto mt-8 flex h-[calc(100%-84px)] min-h-[320px] max-w-[620px] flex-col items-center">
              <AgentNode title="User Query" subtitle="natural language + scene context" accent="bg-cyan-300" />
              <div className="flex h-14 flex-col items-center text-zinc-700"><span className="h-8 w-px bg-gradient-to-b from-cyan-300/70 to-violet-300/70" /><span className="text-xs">▼</span></div>
              <AgentNode title="Orchestrator" subtitle="intent routing · tool selection" accent="bg-violet-300" />
              <div className="relative flex h-16 w-full items-start justify-center">
                <span className="absolute left-1/2 top-0 h-7 w-px bg-zinc-700" />
                <span className="absolute left-[25%] right-[25%] top-7 h-px bg-zinc-700" />
                <span className="absolute left-[25%] top-7 h-5 w-px bg-cyan-300/50" />
                <span className="absolute right-[25%] top-7 h-5 w-px bg-amber-300/50" />
                <span className="absolute left-[calc(25%-3px)] top-[26px] text-[10px] text-cyan-300">▼</span>
                <span className="absolute right-[calc(25%-3px)] top-[26px] text-[10px] text-amber-300">▼</span>
              </div>
              <div className="flex w-full justify-between px-[calc(25%-44px)]">
                <AgentNode title="Feature Extraction" subtitle="water · vegetation · built-up" accent="bg-emerald-300" />
                <AgentNode title="Change Detection" subtitle="bi-temporal diff · contours" accent="bg-amber-300" status="idle" />
              </div>
              <div className="mt-6 flex w-full max-w-md items-center justify-center gap-3 text-[10px] uppercase tracking-wider text-zinc-600">
                <span className="h-px flex-1 bg-zinc-800" />
                <span>structured response</span>
                <span className="h-px flex-1 bg-zinc-800" />
              </div>
            </div>
          </div>

          <section className="flex min-h-0 flex-col bg-black/20" aria-label="System terminal logs">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-600">Terminal stream</div>
                <div className="mt-1 text-xs text-zinc-300">agent-runtime / stdout</div>
              </div>
              <span className="font-mono text-[10px] text-emerald-300">● LIVE</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5 font-mono text-[11px] leading-6">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-2">
                  <span className="shrink-0 text-zinc-700">{log.timestamp}</span>
                  <span className={`shrink-0 font-semibold ${tagStyles[log.tag]}`}>{log.tag}</span>
                  <span className="text-zinc-400">{log.message}</span>
                </div>
              ))}
              <span className="mt-2 inline-block h-3 w-1.5 animate-pulse bg-emerald-300 align-middle" />
            </div>
            <div className="border-t border-white/10 px-5 py-4">
              <div className="flex items-center justify-between text-[10px] text-zinc-600">
                <span>transport: local event bus</span>
                <span>no external LLM calls</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
