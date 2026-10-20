import { useEffect, useMemo, useRef } from "react";
import type { AgentLog, AgentLogTag, BackendTraceStep, WarRoomContext } from "../types";

export type AgentPhase = "pending" | "planning" | "reviewing" | "executing" | "complete" | "error";

export interface AgentNodeState {
  id: string;
  name: string;
  role: string;
  phase: AgentPhase;
  detail: string;
  retryCount?: number;
}

export interface AgentLoopState {
  phase: AgentPhase;
  attempt: number;
  nodes: AgentNodeState[];
  logs: AgentLog[];
  reviewerMessage?: string;
  isComplex?: boolean;
}

export interface AgentWarRoomModalProps {
  open: boolean;
  onClose: () => void;
  context?: WarRoomContext;
  loopState?: AgentLoopState;
  trace?: BackendTraceStep[];
  analysisLogs?: Array<{ tag: string; message: string }>;
}

type PersonaId = "orchestrator" | "acquisition" | "vision" | "synthesizer";
type PersonaState = "pending" | "executing" | "complete" | "error";

interface AgentPersona {
  id: PersonaId;
  icon: string;
  name: string;
  description: string;
  matches: RegExp;
}

interface PersonaView extends AgentPersona {
  state: PersonaState;
  summary: string;
}

const personas: AgentPersona[] = [
  {
    id: "orchestrator",
    icon: "🕵️",
    name: "Orchestrator Agent",
    description: "Analyzing request & routing tasks.",
    matches: /agent\.(classifier|planner)/i,
  },
  {
    id: "acquisition",
    icon: "🛰️",
    name: "Acquisition Agent",
    description: "Fetching Sentinel-1/2 imagery from Planetary Computer STAC.",
    matches: /acquisition\.|validator\.assets/i,
  },
  {
    id: "vision",
    icon: "🧠",
    name: "Vision Engine",
    description: "Running OpenCV, NDVI, and SSIM pixel analysis.",
    matches: /geo\.|change\.|thumbnail\.|sar\.|validator\.scene_pair/i,
  },
  {
    id: "synthesizer",
    icon: "✍️",
    name: "Synthesizer",
    description: "Compiling exact metrics and generating the final report.",
    matches: /metrics\.integrate|answer\.compose/i,
  },
];

const defaultContext: WarRoomContext = {
  route: "Satellite analysis",
  query: "Describe this scene",
  status: "complete",
};

const tagStyles: Record<AgentLogTag, string> = {
  SYS: "text-slate-400",
  E2B: "text-violet-300",
  AGT: "text-cyan-300",
  LOG: "text-amber-300",
  OUT: "text-emerald-300",
};

function logTagStyle(tag: string): string {
  return tagStyles[tag as AgentLogTag] ?? "text-zinc-300";
}

function traceToolNames(trace: BackendTraceStep[]): string[] {
  return trace.map((step) => step.tool_name);
}

function traceOutput(trace: BackendTraceStep[], matcher: RegExp): Record<string, unknown> | null {
  return trace.find((step) => matcher.test(step.tool_name))?.output ?? null;
}

function personaSummary(persona: AgentPersona, trace: BackendTraceStep[]): string {
  if (persona.id === "orchestrator") return "Classified the request and routed the analysis.";

  if (persona.id === "acquisition") {
    const output = traceOutput(trace, /acquisition\.fetch/i);
    const sceneCount = output?.scene_count;
    if (typeof sceneCount === "number") {
      return `Fetched ${sceneCount} Sentinel scene${sceneCount === 1 ? "" : "s"} for analysis.`;
    }
    return "Imagery was fetched and checked for usable scenes.";
  }

  if (persona.id === "vision") {
    return trace.some((step) => /change\.detect/i.test(step.tool_name))
      ? "Computed NDVI, SSIM, and change metrics."
      : "Ran spectral and pixel-level image analysis.";
  }

  return "Compiled exact metrics and the final report.";
}

function personaViews(phase: AgentPhase, trace: BackendTraceStep[]): PersonaView[] {
  const toolNames = traceToolNames(trace);
  const completed = personas.map((persona) => toolNames.some((name) => persona.matches.test(name)));

  if (phase === "complete") {
    return personas.map((persona) => ({
      ...persona,
      state: "complete",
      summary: personaSummary(persona, trace),
    }));
  }

  const nextIndex = completed.findIndex((isComplete) => !isComplete);
  const activeIndex = nextIndex === -1 ? personas.length - 1 : nextIndex;

  return personas.map((persona, index) => {
    const isComplete = completed[index];
    const isActive = phase !== "pending" && index === activeIndex;
    const state: PersonaState = phase === "error" && isActive
      ? "error"
      : isComplete
        ? "complete"
        : isActive
          ? "executing"
          : "pending";
    return {
      ...persona,
      state,
      summary: state === "complete"
        ? personaSummary(persona, trace)
        : state === "error"
          ? "This step stopped because the backend returned an error."
          : state === "executing"
            ? persona.description
            : "Waiting for the previous agent to finish.",
    };
  });
}

function traceLogs(trace: BackendTraceStep[]): AgentLog[] {
  return trace.map((step, index) => ({
    id: index + 1,
    tag: step.status === "error" ? "LOG" : "AGT",
    message: `[${step.tool_name}] ${step.status === "error" ? String(step.output.error ?? "tool failed") : JSON.stringify({ params: step.params, output: step.output })}`,
    timestamp: `${Math.round(step.duration_ms)} ms`,
  }));
}

function suppliedLogs(
  trace: BackendTraceStep[],
  analysisLogs: Array<{ tag: string; message: string }>,
): AgentLog[] {
  if (trace.length) return traceLogs(trace);
  return analysisLogs.map((log, index) => ({
    id: index + 1,
    tag: log.tag as AgentLogTag,
    message: log.message,
    timestamp: "API",
  }));
}

function personaStateClasses(state: PersonaState): string {
  if (state === "complete") return "border-emerald-500/80 bg-emerald-950/25 text-emerald-100";
  if (state === "executing") return "border-blue-500 bg-blue-900/20 text-blue-50 shadow-[0_0_28px_rgba(59,130,246,0.2)]";
  if (state === "error") return "border-rose-500 bg-rose-950/25 text-rose-100";
  return "border-zinc-800 bg-zinc-950/50 text-slate-400 opacity-70";
}

function PersonaIcon({ persona }: { persona: PersonaView }) {
  if (persona.state === "complete") {
    return <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-400/15 text-lg text-emerald-400">✓</span>;
  }
  if (persona.state === "error") {
    return <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-400/15 text-lg text-rose-300">!</span>;
  }
  if (persona.state === "executing") {
    return (
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-400/15 text-lg text-blue-200">
        <span className="relative">{persona.icon}<span className="absolute -right-2 -top-1 h-2 w-2 animate-pulse rounded-full bg-blue-300" /></span>
      </span>
    );
  }
  return <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-400/10 text-lg text-slate-400">{persona.icon}</span>;
}

function PersonaCard({ persona }: { persona: PersonaView }) {
  const stateLabel = persona.state === "complete"
    ? "Completed"
    : persona.state === "executing"
      ? "Working now"
      : persona.state === "error"
        ? "Stopped"
        : "Up next";

  return (
    <article className={`relative rounded-2xl border p-4 transition-all duration-300 ${personaStateClasses(persona.state)} ${persona.state === "executing" ? "animate-pulse" : ""}`}>
      <div className="flex items-start gap-3">
        <PersonaIcon persona={persona} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-wide">{persona.name}</h3>
            <span className={`text-[9px] font-bold uppercase tracking-[0.18em] ${persona.state === "complete" ? "text-emerald-400" : persona.state === "executing" ? "text-blue-200" : persona.state === "error" ? "text-rose-300" : "text-slate-500"}`}>
              {stateLabel}
            </span>
          </div>
          <p className={`mt-2 text-[11px] leading-5 ${persona.state === "pending" ? "text-slate-500" : "text-slate-300"}`}>
            {persona.summary}
          </p>
        </div>
      </div>
    </article>
  );
}

export default function AgentWarRoomModal({
  open,
  onClose,
  context = defaultContext,
  loopState,
  trace = [],
  analysisLogs = [],
}: AgentWarRoomModalProps) {
  const activeLoop: AgentLoopState = loopState ?? {
    phase: "pending",
    attempt: 1,
    nodes: [],
    logs: [],
    isComplex: false,
  };
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const previousPhaseRef = useRef<AgentPhase>(activeLoop.phase);
  const onCloseRef = useRef(onClose);
  const personaData = useMemo(() => personaViews(activeLoop.phase, trace), [activeLoop.phase, trace]);
  const backendLogs = useMemo(() => suppliedLogs(trace, analysisLogs), [analysisLogs, trace]);
  const displayedLogs = activeLoop.logs.length ? activeLoop.logs : backendLogs;
  const completedCount = personaData.filter((persona) => persona.state === "complete").length;
  const activePersona = personaData.find((persona) => persona.state === "executing");
  const isTerminal = activeLoop.phase === "complete" || activeLoop.phase === "error";
  const phaseLabel = activeLoop.phase === "complete"
    ? "Complete"
    : activeLoop.phase === "error"
      ? "Needs attention"
      : activePersona?.name ?? "Preparing analysis";

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    const completedNow = previousPhaseRef.current !== "complete" && activeLoop.phase === "complete";
    previousPhaseRef.current = activeLoop.phase;
    if (!open || !completedNow) return;

    const closeTimer = window.setTimeout(() => onCloseRef.current(), 1500);
    return () => window.clearTimeout(closeTimer);
  }, [activeLoop.phase, open]);

  useEffect(() => {
    if (!open || !terminalRef.current) return;
    terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [activeLoop.phase, displayedLogs.length, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="war-room-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div className="flex h-[min(760px,calc(100vh-32px))] w-[min(1120px,100%)] flex-col overflow-hidden rounded-3xl border border-slate-700 bg-slate-950 text-slate-100 shadow-[0_30px_100px_rgba(0,0,0,0.7)]">
        <header className="flex items-center justify-between gap-4 border-b border-slate-800 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-blue-300">
              <span className="h-2 w-2 rounded-full bg-blue-400 motion-safe:animate-pulse" aria-hidden="true" />
              Live agent pipeline
            </div>
            <h2 id="war-room-title" className="mt-1 text-base font-semibold tracking-wide text-white">Making sense of your scene</h2>
            <p className="mt-1 max-w-xl truncate text-[11px] text-slate-400" title={context.query}>“{context.query}”</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-[9px] uppercase tracking-[0.18em] text-slate-500">Now</div>
              <div className="mt-1 max-w-44 truncate text-xs font-semibold text-blue-200">{phaseLabel}</div>
            </div>
            <button
              type="button"
              onClick={() => onCloseRef.current()}
              className="grid h-9 w-9 place-items-center rounded-xl border border-slate-700 text-lg text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-400/60"
              aria-label="Close agent pipeline"
            >
              ×
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[0.95fr_1.05fr]">
          <main className="min-h-0 overflow-y-auto border-b border-slate-800 bg-[radial-gradient(circle_at_50%_0%,rgba(37,99,235,0.12),transparent_55%)] p-5 sm:p-6 lg:border-b-0 lg:border-r">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">What is happening now?</div>
                <p className="mt-1 text-xs text-slate-300">Four focused agents turn the request into a clear answer.</p>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-sm font-semibold text-blue-200">{completedCount}/4</div>
                <div className="text-[9px] uppercase tracking-wider text-slate-500">agents done</div>
              </div>
            </div>

            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-800" aria-label={`${completedCount} of 4 agents completed`}>
              <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-emerald-400 transition-all duration-500" style={{ width: `${(completedCount / personas.length) * 100}%` }} />
            </div>

            <div className="relative mt-5 space-y-3">
              <div className="absolute bottom-8 left-5 top-8 w-px bg-gradient-to-b from-blue-500/40 via-slate-700 to-emerald-500/40" aria-hidden="true" />
              {personaData.map((persona) => (
                <PersonaCard key={persona.id} persona={persona} />
              ))}
            </div>

            {activeLoop.phase === "complete" ? (
              <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-950/20 px-3 py-2.5 text-center text-[10px] font-medium text-emerald-200">
                Analysis complete. Opening your report…
              </div>
            ) : activeLoop.phase === "error" ? (
              <div className="mt-5 rounded-xl border border-rose-500/30 bg-rose-950/20 px-3 py-2.5 text-center text-[10px] font-medium text-rose-200">
                The analysis stopped. See the terminal for the exact error.
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-blue-500/20 bg-blue-950/20 px-3 py-2.5 text-center text-[10px] text-blue-200">
                {activePersona ? `${activePersona.name} is working on your request.` : "Preparing the first agent…"}
              </div>
            )}
          </main>

          <section className="flex min-h-0 flex-col bg-black/30" aria-label="Live terminal stream">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4 sm:px-6">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Live terminal</div>
                <div className="mt-1 text-xs text-slate-300">Raw proof from the analysis run</div>
              </div>
              <span className={`font-mono text-[10px] ${activeLoop.phase === "error" ? "text-rose-300" : activeLoop.phase === "complete" ? "text-emerald-300" : "text-blue-300"}`}>
                {activeLoop.phase === "error" ? "● ERROR" : activeLoop.phase === "complete" ? "● DONE" : "● LIVE"}
              </span>
            </div>
            <div ref={terminalRef} className="min-h-0 flex-1 overflow-y-auto p-5 font-mono text-[11px] leading-6 sm:p-6" aria-live="polite">
              {displayedLogs.length ? displayedLogs.map((log, index) => (
                <div key={`${log.id}-${index}`} className="flex gap-2">
                  <span className="shrink-0 text-slate-600">{log.timestamp}</span>
                  <span className={`shrink-0 font-semibold ${logTagStyle(log.tag)}`}>{log.tag}</span>
                  <span className="break-words text-slate-300">{log.message}</span>
                </div>
              )) : (
                <div className="text-slate-600">--:--:--.--- SYS waiting for the first agent event</div>
              )}
              {!isTerminal ? <span className="mt-2 inline-block h-3 w-1.5 animate-pulse bg-blue-300 align-middle" aria-label="Waiting for next log entry" /> : null}
            </div>
            <div className="border-t border-slate-800 px-5 py-3 text-[10px] text-slate-500 sm:px-6">
              <div className="flex items-center justify-between gap-3">
                <span>Auto-scrolling to newest event</span>
                <span>{context.status === "error" ? "Run stopped" : context.status === "complete" ? "Report ready" : "Listening"}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
